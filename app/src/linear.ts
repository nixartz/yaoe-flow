// Cliente GraphQL do Linear — scoped por connection (apiKey + teamId).
// Multi-workspace: use `linearFor(ctx)`; exports de módulo usam fallback
// single-tenant (config.linear) só pra validação Config / paths legados.
import { config } from "./config";
import { log, errFields } from "./logger";
import type { LinearIssue } from "./types";
import type { LinearContext } from "./db/linearConnections";
import { DEFAULT_CONNECTION_ID, singleTenantContext } from "./db/linearConnections";

const API = "https://api.linear.app/graphql";

/** Soft floor: below this remaining budget, skip a full reconciliation tick. */
export const LINEAR_TICK_BUDGET_FLOOR = 40;

export interface LinearScope {
  apiKey: string;
  teamId: string | null;
  /** Chave de cache (connectionId); "default" = single-tenant. */
  connectionId: string;
}

export class LinearRateLimitError extends Error {
  readonly resetAtMs: number;
  readonly remaining: number;
  readonly limit: number;

  constructor(message: string, opts: { resetAtMs: number; remaining?: number; limit?: number }) {
    super(message);
    this.name = "LinearRateLimitError";
    this.resetAtMs = opts.resetAtMs;
    this.remaining = opts.remaining ?? 0;
    this.limit = opts.limit ?? 5000;
  }
}

export function isLinearRateLimitError(e: unknown): e is LinearRateLimitError {
  return e instanceof LinearRateLimitError;
}

type RateLimitState = {
  remaining: number | null;
  limit: number | null;
  resetAtMs: number | null;
  /** Wall clock until which callers must not hit Linear for this key. */
  cooledUntilMs: number | null;
};

const rateLimitByKey = new Map<string, RateLimitState>();

function rateLimitKey(apiKey: string): string {
  return apiKey.slice(0, 12);
}

function getRateLimitState(apiKey: string): RateLimitState {
  const k = rateLimitKey(apiKey);
  let st = rateLimitByKey.get(k);
  if (!st) {
    st = { remaining: null, limit: null, resetAtMs: null, cooledUntilMs: null };
    rateLimitByKey.set(k, st);
  }
  return st;
}

/** Remaining cooldown ms for this API key (0 = clear to call). */
export function linearRateLimitCooldownMs(apiKey: string): number {
  const st = getRateLimitState(apiKey);
  if (!st.cooledUntilMs) return 0;
  return Math.max(0, st.cooledUntilMs - Date.now());
}

/** Snapshot of last-seen Linear request budget for this key (from response headers). */
export function linearRateLimitSnapshot(apiKey: string): {
  remaining: number | null;
  limit: number | null;
  resetAtMs: number | null;
  cooledUntilMs: number | null;
} {
  const st = getRateLimitState(apiKey);
  return {
    remaining: st.remaining,
    limit: st.limit,
    resetAtMs: st.resetAtMs,
    cooledUntilMs: st.cooledUntilMs,
  };
}

/** True when a full tick would likely exhaust the hourly budget. */
export function shouldSkipTickForRateBudget(apiKey: string): boolean {
  if (linearRateLimitCooldownMs(apiKey) > 0) return true;
  const st = getRateLimitState(apiKey);
  return st.remaining !== null && st.remaining < LINEAR_TICK_BUDGET_FLOOR;
}

function markRateLimited(apiKey: string, resetAtMs: number, remaining = 0, limit = 5000): void {
  const st = getRateLimitState(apiKey);
  st.remaining = remaining;
  st.limit = limit;
  st.resetAtMs = resetAtMs;
  st.cooledUntilMs = resetAtMs;
  log.linear.warn(
    {
      remaining,
      limit,
      resetAtMs,
      cooldownMs: Math.max(0, resetAtMs - Date.now()),
    },
    "Linear rate limit — entering cooldown until reset"
  );
}

function recordRateLimitHeaders(apiKey: string, headers: Headers): void {
  const remainingRaw = headers.get("X-RateLimit-Requests-Remaining");
  const limitRaw = headers.get("X-RateLimit-Requests-Limit");
  const resetRaw = headers.get("X-RateLimit-Requests-Reset");
  if (remainingRaw === null && limitRaw === null && resetRaw === null) return;

  const st = getRateLimitState(apiKey);
  if (remainingRaw !== null) st.remaining = Number(remainingRaw);
  if (limitRaw !== null) st.limit = Number(limitRaw);
  if (resetRaw !== null) {
    const resetAtMs = Number(resetRaw);
    if (Number.isFinite(resetAtMs)) st.resetAtMs = resetAtMs;
  }

  // Hard stop when the window is exhausted — avoid thrashing until reset.
  if (st.remaining === 0 && st.resetAtMs && st.resetAtMs > Date.now()) {
    st.cooledUntilMs = st.resetAtMs;
  } else if (st.cooledUntilMs && st.remaining !== null && st.remaining > LINEAR_TICK_BUDGET_FLOOR) {
    // Budget recovered (new window or clock skew) — clear stale cooldown.
    st.cooledUntilMs = null;
  }
}

type GqlErrorExt = {
  code?: string;
  statusCode?: number;
  meta?: { rateLimitResult?: { remaining?: number; limit?: number; duration?: number } };
};

function parseRateLimitFromErrors(
  errors: unknown
): { remaining: number; limit: number; durationMs: number } | null {
  if (!Array.isArray(errors)) return null;
  for (const err of errors) {
    const ext = (err as { extensions?: GqlErrorExt })?.extensions;
    if (!ext || (ext.code !== "RATELIMITED" && ext.statusCode !== 429)) continue;
    const meta = ext.meta?.rateLimitResult;
    return {
      remaining: meta?.remaining ?? 0,
      limit: meta?.limit ?? 5000,
      durationMs: meta?.duration ?? 3_600_000,
    };
  }
  return null;
}

/** Strip `bestEffort` so it never lands in Pino fields; pick warn vs error. */
function gqlLogContext(context: Record<string, unknown>): {
  bestEffort: boolean;
  fields: Record<string, unknown>;
} {
  const { bestEffort, ...fields } = context;
  return { bestEffort: Boolean(bestEffort), fields };
}

function gqlFailureLog(context: Record<string, unknown>) {
  return gqlLogContext(context).bestEffort ? log.linear.warn : log.linear.error;
}

function assertNotInCooldown(apiKey: string, operation: string, context: Record<string, unknown>): void {
  const cooldownMs = linearRateLimitCooldownMs(apiKey);
  if (cooldownMs <= 0) return;
  const st = getRateLimitState(apiKey);
  const resetAtMs = st.cooledUntilMs ?? Date.now() + cooldownMs;
  log.linear.warn(
    { operation, cooldownMs, resetAtMs, ...gqlLogContext(context).fields },
    "Linear API call skipped: rate limit cooldown active"
  );
  throw new LinearRateLimitError(`Linear rate limit cooldown (${cooldownMs}ms remaining)`, {
    resetAtMs,
    remaining: st.remaining ?? 0,
    limit: st.limit ?? 5000,
  });
}

type GqlFn = <T>(
  operation: string,
  query: string,
  variables?: Record<string, unknown>,
  context?: Record<string, unknown>
) => Promise<T>;

function makeGql(apiKey: string): GqlFn {
  return async function gql<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown> = {},
    context: Record<string, unknown> = {}
  ): Promise<T> {
    const start = Date.now();
    assertNotInCooldown(apiKey, operation, context);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
      const durationMs = Date.now() - start;
      recordRateLimitHeaders(apiKey, res.headers);

      if (!res.ok) {
        const body = await res.text();
        let parsed: { errors?: unknown } | null = null;
        try {
          parsed = JSON.parse(body) as { errors?: unknown };
        } catch {
          /* non-JSON body */
        }
        const rl = parsed ? parseRateLimitFromErrors(parsed.errors) : null;
        if (rl) {
          const st = getRateLimitState(apiKey);
          const resetAtMs =
            st.resetAtMs && st.resetAtMs > Date.now() ? st.resetAtMs : Date.now() + rl.durationMs;
          markRateLimited(apiKey, resetAtMs, rl.remaining, rl.limit);
          gqlFailureLog(context)(
            { operation, status: res.status, durationMs, body, ...gqlLogContext(context).fields },
            "Linear API HTTP error"
          );
          throw new LinearRateLimitError(`Linear API rate limited (${rl.remaining}/${rl.limit} remaining)`, {
            resetAtMs,
            remaining: rl.remaining,
            limit: rl.limit,
          });
        }
        gqlFailureLog(context)(
          { operation, status: res.status, durationMs, body, ...gqlLogContext(context).fields },
          "Linear API HTTP error"
        );
        throw new Error(`Linear API ${res.status}: ${body}`);
      }

      const json = (await res.json()) as { data?: T; errors?: unknown };
      if (json.errors) {
        const rl = parseRateLimitFromErrors(json.errors);
        if (rl) {
          const st = getRateLimitState(apiKey);
          const resetAtMs =
            st.resetAtMs && st.resetAtMs > Date.now() ? st.resetAtMs : Date.now() + rl.durationMs;
          markRateLimited(apiKey, resetAtMs, rl.remaining, rl.limit);
          gqlFailureLog(context)(
            { operation, durationMs, errors: json.errors, ...gqlLogContext(context).fields },
            "Linear GraphQL error"
          );
          throw new LinearRateLimitError(`Linear API rate limited (${rl.remaining}/${rl.limit} remaining)`, {
            resetAtMs,
            remaining: rl.remaining,
            limit: rl.limit,
          });
        }
        gqlFailureLog(context)(
          { operation, durationMs, errors: json.errors, ...gqlLogContext(context).fields },
          "Linear GraphQL error"
        );
        throw new Error(`Linear GraphQL: ${JSON.stringify(json.errors)}`);
      }

      log.linear.debug({ operation, durationMs, ...gqlLogContext(context).fields }, "Linear API ok");
      return json.data as T;
    } catch (e) {
      if (isLinearRateLimitError(e)) throw e;
      if (e instanceof Error && (e.message.startsWith("Linear API") || e.message.startsWith("Linear GraphQL"))) {
        throw e;
      }
      gqlFailureLog(context)(
        { operation, durationMs: Date.now() - start, ...gqlLogContext(context).fields, ...errFields(e) },
        "Linear API request failed"
      );
      throw e;
    }
  };
}

/** Test helper — clears in-memory rate-limit / cooldown state. */
export function __resetLinearRateLimitStateForTests(): void {
  rateLimitByKey.clear();
}

/** Test helper — force a cooldown as if Linear returned RATELIMITED. */
export function __markLinearRateLimitedForTests(
  apiKey: string,
  opts: { resetAtMs: number; remaining?: number; limit?: number }
): void {
  markRateLimited(apiKey, opts.resetAtMs, opts.remaining ?? 0, opts.limit ?? 5000);
}

/** Test helper — apply response headers the way makeGql does. */
export function __recordLinearRateLimitHeadersForTests(apiKey: string, headers: Headers): void {
  recordRateLimitHeaders(apiKey, headers);
}

interface RawRel {
  type: string;
  // Dono da relação (quem "blocks" / aponta). Em inverseRelations este é o
  // outro lado — o blocker. relatedIssue em inverseRelations é SEMPRE a issue
  // atual (self); usar relatedIssue.id aqui vira dead-lock eterno de deps.
  issue: { id: string; state: { name: string } };
  relatedIssue: { id: string; state: { name: string } };
}
interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  state: { name: string };
  team?: { id: string };
  inverseRelations: { nodes: RawRel[] };
}

function normalize(raw: RawIssue): LinearIssue {
  // inverseRelations = relações em que ESTA issue é o relatedIssue.
  // Tipo "blocks" + issue = X ⇒ "X blocks this" ⇒ this.blockedBy inclui X.
  const blockedBy = (raw.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === "blocks")
    .map((r) => r.issue.id)
    .filter((id) => id !== raw.id);
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    stateName: raw.state.name,
    teamId: raw.team?.id,
    blockedBy,
  };
}

export function createLinearClient(scope: LinearScope) {
  const gql = makeGql(scope.apiKey);
  const teamId = () => scope.teamId ?? "";

  // Per-tick memo: fill* + readiness + reclaim often list the same states.
  // Cleared via beginTickCache() at the start of each connection reconcile.
  let tickListCache = new Map<string, Promise<LinearIssue[]>>();
  let tickIssueCache = new Map<string, Promise<LinearIssue>>();

  function beginTickCache(): void {
    tickListCache = new Map();
    tickIssueCache = new Map();
  }

  function withTeamFilter(filter: Record<string, unknown>): Record<string, unknown> {
    const id = teamId();
    if (!id) return filter;
    return { ...filter, team: { id: { eq: id } } };
  }

  let stateCache: Record<string, string> | null = null;
  async function resolveStateId(name: string): Promise<string> {
    if (!stateCache) {
      const id = teamId();
      if (id) {
        const data = await gql<{ team: { states: { nodes: { id: string; name: string }[] } } }>(
          "team.states",
          `query($teamId: String!) {
            team(id: $teamId) { states { nodes { id name } } }
          }`,
          { teamId: id }
        );
        stateCache = {};
        for (const s of data.team.states.nodes) stateCache[s.name] = s.id;
      } else {
        const data = await gql<{ workflowStates: { nodes: { id: string; name: string }[] } }>(
          "workflowStates.list",
          `query { workflowStates(first: 250) { nodes { id name } } }`
        );
        stateCache = {};
        for (const s of data.workflowStates.nodes) stateCache[s.name] = s.id;
      }
      log.linear.debug(
        { stateCount: Object.keys(stateCache).length, connectionId: scope.connectionId },
        "workflow states cached"
      );
    }
    const stateId = stateCache[name];
    if (!stateId) {
      throw new Error(`State not found in Linear: "${name}" (check config.states and the connection's team)`);
    }
    return stateId;
  }

  async function linearDispatchHints(): Promise<string> {
    const tid = teamId();
    if (!tid) return "";
    const logical: Record<string, string> = {
      Planned: config.states.planned,
      Blocked: config.states.blocked,
      "Code Review": config.states.codeReview,
      "In Review": config.states.inReview,
      "Pending Merge": config.states.pendingMerge,
      Reopened: config.states.reopened,
      Completed: config.states.completed,
      "In Progress": config.states.inProgress,
      Refining: config.states.refining,
    };
    const stateIds: Record<string, string> = {};
    for (const [key, name] of Object.entries(logical)) {
      try {
        stateIds[key] = await resolveStateId(name);
      } catch {
        /* status opcional ausente no time — pula */
      }
    }
    return `\nteamId: ${tid}\nstateIds: ${JSON.stringify(stateIds)}`;
  }

  async function getIssue(id: string): Promise<LinearIssue> {
    const cached = tickIssueCache.get(id);
    if (cached) return cached;
    const pending = (async () => {
      const data = await gql<{ issue: RawIssue }>(
        "issue.get",
        `query($id: String!) {
          issue(id: $id) {
            id identifier title
            state { name }
            team { id }
            inverseRelations { nodes { type issue { id state { name } } relatedIssue { id state { name } } } }
          }
        }`,
        { id },
        { issueId: id }
      );
      return normalize(data.issue);
    })();
    tickIssueCache.set(id, pending);
    try {
      return await pending;
    } catch (e) {
      tickIssueCache.delete(id);
      throw e;
    }
  }

  async function listIssuesInState(stateName: string): Promise<LinearIssue[]> {
    const cacheKey = `state:${stateName}`;
    const cached = tickListCache.get(cacheKey);
    if (cached) return cached;
    const pending = (async () => {
      const data = await gql<{
        issues: {
          nodes: { id: string; identifier: string; title: string; state: { name: string }; team?: { id: string } }[];
        };
      }>(
        "issues.listByState",
        `query($filter: IssueFilter!) {
          issues(first: 50, filter: $filter) {
            nodes { id identifier title state { name } team { id } }
          }
        }`,
        { filter: withTeamFilter({ state: { name: { eq: stateName } } }) },
        { stateName }
      );
      return data.issues.nodes.map((n) => ({
        ...n,
        stateName: n.state.name,
        teamId: n.team?.id,
        blockedBy: [],
      }));
    })();
    tickListCache.set(cacheKey, pending);
    try {
      return await pending;
    } catch (e) {
      tickListCache.delete(cacheKey);
      throw e;
    }
  }

  async function countInState(stateName: string): Promise<number> {
    return (await listIssuesInState(stateName)).length;
  }

  // One GraphQL round-trip for several plain by-state lists (fillWorkers,
  // fillReviewers, reclaim, pendingMergeIssues, ... often need 5-8 distinct
  // states in the same tick). Aliased sub-queries share the tickListCache
  // key ("state:<name>") with listIssuesInState, so a state already fetched
  // this tick (or fetched here and read again later via listIssuesInState)
  // never triggers a second request.
  async function listIssuesInStates(stateNames: string[]): Promise<Record<string, LinearIssue[]>> {
    const uniqueNames = [...new Set(stateNames)];
    const toFetch = uniqueNames.filter((name) => !tickListCache.has(`state:${name}`));

    if (toFetch.length > 0) {
      const aliasFor = (i: number) => `s${i}`;
      const aliasToName = new Map(toFetch.map((name, i) => [aliasFor(i), name]));
      const queryParts = toFetch
        .map(
          (_, i) => `${aliasFor(i)}: issues(first: 50, filter: $filter${i}) {
            nodes { id identifier title state { name } team { id } }
          }`
        )
        .join("\n");
      const varDecls = toFetch.map((_, i) => `$filter${i}: IssueFilter!`).join(", ");
      const variables = Object.fromEntries(
        toFetch.map((name, i) => [`filter${i}`, withTeamFilter({ state: { name: { eq: name } } })])
      );

      const pending = (async () => {
        const data = await gql<
          Record<string, { nodes: { id: string; identifier: string; title: string; state: { name: string }; team?: { id: string } }[] }>
        >(
          "issues.listByStates",
          `query(${varDecls}) {\n${queryParts}\n}`,
          variables,
          { stateNames: toFetch }
        );
        const byAlias: Record<string, LinearIssue[]> = {};
        for (const [alias, name] of aliasToName) {
          byAlias[name] = (data[alias]?.nodes ?? []).map((n) => ({
            ...n,
            stateName: n.state.name,
            teamId: n.team?.id,
            blockedBy: [],
          }));
        }
        return byAlias;
      })();

      // Fan the shared batch promise back out per-state so listIssuesInState
      // (and a second listIssuesInStates call) hit the same cache entry.
      for (const name of toFetch) {
        const cacheKey = `state:${name}`;
        const perState = pending.then((byAlias) => byAlias[name] ?? []);
        tickListCache.set(cacheKey, perState);
        perState.catch(() => {
          if (tickListCache.get(cacheKey) === perState) tickListCache.delete(cacheKey);
        });
      }
    }

    const result: Record<string, LinearIssue[]> = {};
    await Promise.all(
      uniqueNames.map(async (name) => {
        result[name] = await tickListCache.get(`state:${name}`)!;
      })
    );
    return result;
  }

  async function listIssuesInStateWithLabel(stateName: string, labelName: string): Promise<LinearIssue[]> {
    const cacheKey = `state+label:${stateName}:${labelName}`;
    const cached = tickListCache.get(cacheKey);
    if (cached) return cached;
    const pending = (async () => {
      const data = await gql<{
        issues: {
          nodes: { id: string; identifier: string; title: string; state: { name: string }; team?: { id: string } }[];
        };
      }>(
        "issues.listByStateAndLabel",
        `query($filter: IssueFilter!) {
          issues(first: 50, filter: $filter) {
            nodes { id identifier title state { name } team { id } }
          }
        }`,
        {
          filter: withTeamFilter({
            state: { name: { eq: stateName } },
            labels: { name: { eq: labelName } },
          }),
        },
        { stateName, labelName }
      );
      return data.issues.nodes.map((n) => ({
        ...n,
        stateName: n.state.name,
        teamId: n.team?.id,
        blockedBy: [],
      }));
    })();
    tickListCache.set(cacheKey, pending);
    try {
      return await pending;
    } catch (e) {
      tickListCache.delete(cacheKey);
      throw e;
    }
  }

  async function setState(issueId: string, stateName: string): Promise<void> {
    const stateId = await resolveStateId(stateName);
    await gql<{ issueUpdate: { success: boolean } }>(
      "issue.setState",
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId },
      { issueId, stateName }
    );
    log.linear.info({ issueId, stateName, connectionId: scope.connectionId }, "issue state updated");
  }

  let viewerCache: { id: string; name: string; email: string; typename: string } | null = null;
  /** Actor da API key — cacheado por client/connection. App users cannot be assignees. */
  async function getViewer(): Promise<{ id: string; name: string; email: string; typename: string }> {
    if (viewerCache) return viewerCache;
    const data = await gql<{ viewer: { id: string; name: string; email: string; __typename: string } }>(
      "viewer.get",
      `query { viewer { id name email __typename } }`
    );
    const v = data.viewer;
    viewerCache = { id: v.id, name: v.name, email: v.email, typename: v.__typename };
    return viewerCache;
  }

  async function assignIssue(
    issueId: string,
    assigneeId: string,
    opts?: { bestEffort?: boolean }
  ): Promise<void> {
    await gql<{ issueUpdate: { success: boolean } }>(
      "issue.assign",
      `mutation($id: String!, $assigneeId: String!) {
        issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
      }`,
      { id: issueId, assigneeId },
      { issueId, assigneeId, ...(opts?.bestEffort ? { bestEffort: true } : {}) }
    );
    log.linear.info({ issueId, assigneeId, connectionId: scope.connectionId }, "issue assigned");
  }

  async function getAttachmentUrls(issueId: string): Promise<string[]> {
    const data = await gql<{ issue: { attachments: { nodes: { url: string }[] } } }>(
      "issue.attachments",
      `query($id: String!) {
        issue(id: $id) { attachments { nodes { url } } }
      }`,
      { id: issueId },
      { issueId }
    );
    return (data.issue.attachments?.nodes ?? []).map((n) => n.url);
  }

  async function listCommentBodies(issueId: string): Promise<string[]> {
    const data = await gql<{ issue: { comments: { nodes: { body: string }[] } } }>(
      "issue.comments",
      `query($id: String!) {
        issue(id: $id) { comments(first: 50) { nodes { body } } }
      }`,
      { id: issueId },
      { issueId }
    );
    return (data.issue.comments?.nodes ?? []).map((n) => n.body);
  }

  async function comment(issueId: string, body: string): Promise<void> {
    await gql<{ commentCreate: { success: boolean } }>(
      "issue.comment",
      `mutation($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) { success }
      }`,
      { id: issueId, body },
      { issueId, bodyLength: body.length }
    );
    log.linear.info({ issueId, bodyLength: body.length }, "issue comment created");
  }

  let labelCache: Record<string, string> | null = null;
  async function loadLabels(force = false): Promise<Record<string, string>> {
    if (!labelCache || force) {
      const id = teamId();
      const cache: Record<string, string> = {};
      if (id) {
        const data = await gql<{ team: { labels: { nodes: { id: string; name: string }[] } } }>(
          "team.labels",
          `query($teamId: String!) {
            team(id: $teamId) { labels { nodes { id name } } }
          }`,
          { teamId: id }
        );
        for (const l of data.team.labels.nodes) cache[l.name] = l.id;
      } else {
        const data = await gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
          "issueLabels.list",
          `query { issueLabels(first: 250) { nodes { id name } } }`
        );
        for (const l of data.issueLabels.nodes) cache[l.name] = l.id;
      }
      labelCache = cache;
      log.linear.debug({ labelCount: Object.keys(labelCache).length, force }, "labels cached");
    }
    return labelCache;
  }

  async function ensureLabelId(name: string): Promise<string> {
    const cache = await loadLabels();
    if (cache[name]) return cache[name];
    const tid = teamId();
    const input = tid ? { name, teamId: tid } : { name };
    try {
      const data = await gql<{ issueLabelCreate: { issueLabel: { id: string; name: string } } }>(
        "issueLabel.create",
        `mutation($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { issueLabel { id name } }
        }`,
        { input },
        { labelName: name }
      );
      const created = data.issueLabelCreate.issueLabel;
      cache[created.name] = created.id;
      log.linear.info({ labelName: created.name, labelId: created.id }, "label created");
      return created.id;
    } catch (e) {
      const refreshed = await loadLabels(true);
      if (refreshed[name]) {
        log.linear.warn(
          { labelName: name, ...errFields(e) },
          "issueLabelCreate failed but the label already existed (race) — recovered via refresh"
        );
        return refreshed[name];
      }
      log.linear.error(
        { labelName: name, ...errFields(e) },
        "could not create/find the label — the label operation will fail (cosmetic, but worth investigating)"
      );
      throw e;
    }
  }

  async function getIssueLabels(issueId: string): Promise<{ id: string; name: string }[]> {
    const data = await gql<{ issue: { labels: { nodes: { id: string; name: string }[] } } }>(
      "issue.labels",
      `query($id: String!) { issue(id: $id) { labels { nodes { id name } } } }`,
      { id: issueId },
      { issueId }
    );
    return data.issue.labels?.nodes ?? [];
  }

  async function setLabelIds(issueId: string, labelIds: string[]): Promise<void> {
    await gql<{ issueUpdate: { success: boolean } }>(
      "issue.setLabels",
      `mutation($id: String!, $ids: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $ids }) { success }
      }`,
      { id: issueId, ids: labelIds },
      { issueId, labelCount: labelIds.length }
    );
  }

  const labelLocks = new Map<string, Promise<void>>();

  async function withLabelLock<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
    const prev = labelLocks.get(issueId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    labelLocks.set(issueId, gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (labelLocks.get(issueId) === gate) labelLocks.delete(issueId);
    }
  }

  async function addLabel(issueId: string, name: string): Promise<void> {
    return withLabelLock(issueId, async () => {
      const current = await getIssueLabels(issueId);
      if (current.some((l) => l.name === name)) {
        log.linear.debug({ issueId, labelName: name }, "label already present, skipped");
        return;
      }
      const lid = await ensureLabelId(name);
      await setLabelIds(issueId, [...current.map((l) => l.id), lid]);
      log.linear.info({ issueId, labelName: name }, "label added");
    });
  }

  async function removeLabel(issueId: string, name: string): Promise<void> {
    return withLabelLock(issueId, async () => {
      const current = await getIssueLabels(issueId);
      if (!current.some((l) => l.name === name)) {
        log.linear.debug({ issueId, labelName: name }, "label not present, skipped");
        return;
      }
      await setLabelIds(
        issueId,
        current.filter((l) => l.name !== name).map((l) => l.id)
      );
      log.linear.info({ issueId, labelName: name }, "label removed");
    });
  }

  async function mutateLabels(
    issueId: string,
    { remove = [], add = [] }: { remove?: string[]; add?: string[] }
  ): Promise<void> {
    return withLabelLock(issueId, async () => {
      const removeSet = new Set(remove);
      const before = await getIssueLabels(issueId);
      let labels = before.filter((l) => !removeSet.has(l.name));
      const actuallyRemoved = before.filter((l) => removeSet.has(l.name)).map((l) => l.name);
      const added: string[] = [];

      for (const name of add) {
        if (labels.some((l) => l.name === name)) continue;
        const lid = await ensureLabelId(name);
        labels = [...labels, { id: lid, name }];
        added.push(name);
      }

      if (actuallyRemoved.length === 0 && added.length === 0) {
        log.linear.debug({ issueId, remove, add }, "mutateLabels: no changes");
        return;
      }

      await setLabelIds(
        issueId,
        labels.map((l) => l.id)
      );
      log.linear.info({ issueId, removed: actuallyRemoved, added }, "labels mutated");
    });
  }

  async function listIssuesWithLabelPrefix(
    prefix: string
  ): Promise<{ id: string; stateName: string; matchingLabels: string[] }[]> {
    const data = await gql<{
      issues: { nodes: { id: string; state: { name: string }; labels: { nodes: { name: string }[] } }[] };
    }>(
      "issues.listByLabelPrefix",
      `query($filter: IssueFilter!) {
        issues(first: 100, filter: $filter) {
          nodes { id state { name } labels { nodes { name } } }
        }
      }`,
      {
        filter: withTeamFilter({ labels: { name: { startsWith: prefix } } }),
      },
      { labelPrefix: prefix }
    );
    return data.issues.nodes.map((n) => ({
      id: n.id,
      stateName: n.state.name,
      matchingLabels: (n.labels?.nodes ?? []).map((l) => l.name).filter((nm) => nm.startsWith(prefix)),
    }));
  }

  async function listTeamStateNames(): Promise<string[]> {
    const id = teamId();
    if (id) {
      const data = await gql<{ team: { states: { nodes: { name: string }[] } } }>(
        "team.states.names",
        `query($teamId: String!) { team(id: $teamId) { states { nodes { name } } } }`,
        { teamId: id }
      );
      return data.team.states.nodes.map((s) => s.name);
    }
    const data = await gql<{ workflowStates: { nodes: { name: string }[] } }>(
      "workflowStates.names",
      `query { workflowStates(first: 250) { nodes { name } } }`
    );
    return data.workflowStates.nodes.map((s) => s.name);
  }

  async function listTeamLabelNames(): Promise<string[]> {
    const id = teamId();
    if (id) {
      const data = await gql<{ team: { labels: { nodes: { name: string }[] } } }>(
        "team.labels.names",
        `query($teamId: String!) { team(id: $teamId) { labels(first: 250) { nodes { name } } } }`,
        { teamId: id }
      );
      return data.team.labels.nodes.map((l) => l.name);
    }
    const data = await gql<{ issueLabels: { nodes: { name: string }[] } }>(
      "issueLabels.names",
      `query { issueLabels(first: 250) { nodes { name } } }`
    );
    return data.issueLabels.nodes.map((l) => l.name);
  }

  let orgUrlKeyCache: string | null = null;
  async function organizationUrlKey(): Promise<string> {
    if (orgUrlKeyCache === null) {
      const data = await gql<{ organization: { urlKey: string } }>(
        "organization.urlKey",
        `query { organization { urlKey } }`
      );
      orgUrlKeyCache = data.organization.urlKey;
    }
    return orgUrlKeyCache;
  }

  /** Invalida caches locais (após rotate de key ou troca de team). */
  function invalidateCaches(): void {
    stateCache = null;
    labelCache = null;
    orgUrlKeyCache = null;
    viewerCache = null;
    beginTickCache();
  }

  return {
    scope,
    /** Call once per connection reconcile so fill* + readiness share list/getIssue. */
    beginTickCache,
    linearDispatchHints,
    getIssue,
    listIssuesInState,
    listIssuesInStates,
    countInState,
    listIssuesInStateWithLabel,
    setState,
    getViewer,
    assignIssue,
    getAttachmentUrls,
    listCommentBodies,
    comment,
    addLabel,
    removeLabel,
    mutateLabels,
    listIssuesWithLabelPrefix,
    listTeamStateNames,
    listTeamLabelNames,
    organizationUrlKey,
    invalidateCaches,
  };
}

export type LinearClient = ReturnType<typeof createLinearClient>;

const clientCache = new Map<string, LinearClient>();

function scopeFromContext(ctx: LinearContext): LinearScope {
  return {
    apiKey: ctx.apiKey,
    teamId: ctx.teamId,
    connectionId: ctx.connectionId,
  };
}

/** Client scoped à connection — cache por connectionId + fingerprint da key. */
export function linearFor(ctx: LinearContext): LinearClient {
  const cacheKey = `${ctx.connectionId}:${ctx.apiKey.slice(0, 8)}:${ctx.teamId ?? ""}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = createLinearClient(scopeFromContext(ctx));
    clientCache.set(cacheKey, client);
  }
  return client;
}

function defaultScope(): LinearScope {
  const ctx = singleTenantContext();
  if (ctx) return scopeFromContext(ctx);
  return {
    apiKey: config.linear.apiKey,
    teamId: config.linear.teamId || null,
    connectionId: DEFAULT_CONNECTION_ID,
  };
}

function defaultClient(): LinearClient {
  return linearFor({
    connectionId: defaultScope().connectionId,
    organizationId: "",
    apiKey: defaultScope().apiKey,
    webhookSecret: config.linear.webhookSecret,
    teamId: defaultScope().teamId,
    teamKey: config.linear.teamKey || null,
    name: "Default",
    // Client Linear não usa credencial GitHub; o fallback global basta.
    githubAuthMode: null,
    githubToken: null,
  });
}

// ── Exports de módulo (compat Config / callers sem ctx explícito) ──

export async function linearDispatchHints(): Promise<string> {
  return defaultClient().linearDispatchHints();
}
export async function getIssue(id: string): Promise<LinearIssue> {
  return defaultClient().getIssue(id);
}
export async function listIssuesInState(stateName: string): Promise<LinearIssue[]> {
  return defaultClient().listIssuesInState(stateName);
}
export async function countInState(stateName: string): Promise<number> {
  return defaultClient().countInState(stateName);
}
export async function listIssuesInStateWithLabel(stateName: string, labelName: string): Promise<LinearIssue[]> {
  return defaultClient().listIssuesInStateWithLabel(stateName, labelName);
}
export async function setState(issueId: string, stateName: string): Promise<void> {
  return defaultClient().setState(issueId, stateName);
}
export async function getAttachmentUrls(issueId: string): Promise<string[]> {
  return defaultClient().getAttachmentUrls(issueId);
}
export async function listCommentBodies(issueId: string): Promise<string[]> {
  return defaultClient().listCommentBodies(issueId);
}
export async function comment(issueId: string, body: string): Promise<void> {
  return defaultClient().comment(issueId, body);
}
export async function addLabel(issueId: string, name: string): Promise<void> {
  return defaultClient().addLabel(issueId, name);
}
export async function removeLabel(issueId: string, name: string): Promise<void> {
  return defaultClient().removeLabel(issueId, name);
}
export async function mutateLabels(
  issueId: string,
  opts: { remove?: string[]; add?: string[] }
): Promise<void> {
  return defaultClient().mutateLabels(issueId, opts);
}
export async function listIssuesWithLabelPrefix(
  prefix: string
): Promise<{ id: string; stateName: string; matchingLabels: string[] }[]> {
  return defaultClient().listIssuesWithLabelPrefix(prefix);
}
export async function listTeamStateNames(): Promise<string[]> {
  return defaultClient().listTeamStateNames();
}
export async function listTeamLabelNames(): Promise<string[]> {
  return defaultClient().listTeamLabelNames();
}
export async function organizationUrlKey(): Promise<string> {
  return defaultClient().organizationUrlKey();
}
