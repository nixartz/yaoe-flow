// Issue-scoped agent workspaces under WORKSPACE_ROOT.
//
// Lifecycle (aligned with the pipeline, broader than footprint locks):
//   created on first dispatch for an issue (PMO / Dev / …)
//   reused across roles and retries (Reopened, Blocked → resume)
//   removed on Completed (webhook) or by reconcileStaleWorkspaces on the tick
//
// Layout (mirrors Valkey lock prefixing):
//   default connection → `$WORKSPACE_ROOT/issue-<issueId>/`
//   other connections  → `$WORKSPACE_ROOT/conn-<connectionId>/issue-<issueId>/`
//   harness siblings   → `…/issue-<id>-home`, `-cursor-config`, …
//   ephemeral          → `$WORKSPACE_ROOT/run-<runId>/` (no issueId; deleted after run)
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config";
import { log, errFields } from "../logger";
import { DEFAULT_CONNECTION_ID } from "../db/linearConnections";

export const ISSUE_WORKSPACE_PREFIX = "issue-";
export const RUN_WORKSPACE_PREFIX = "run-";
export const CONN_WORKSPACE_PREFIX = "conn-";

/** Sibling dirs created next to the workspace cwd by harness prepareSpawn. */
export const WORKSPACE_SIBLING_SUFFIXES = [
  "-home",
  "-cursor-config",
  "-claude-config",
  "-codex-home",
] as const;

export function workspaceRoot(): string {
  return config.goose.workingDir;
}

function sanitizeId(id: string): string {
  return id.replace(/[/\\]/g, "_");
}

function isSiblingDirName(name: string): boolean {
  return WORKSPACE_SIBLING_SUFFIXES.some((s) => name.endsWith(s));
}

/** Directory that holds issue-* folders for this Linear connection. */
export function connectionWorkspaceRoot(connectionId: string = DEFAULT_CONNECTION_ID): string {
  if (!connectionId || connectionId === DEFAULT_CONNECTION_ID) return workspaceRoot();
  return join(workspaceRoot(), `${CONN_WORKSPACE_PREFIX}${sanitizeId(connectionId)}`);
}

export function issueWorkspaceCwd(issueId: string, connectionId: string = DEFAULT_CONNECTION_ID): string {
  return join(connectionWorkspaceRoot(connectionId), `${ISSUE_WORKSPACE_PREFIX}${sanitizeId(issueId)}`);
}

export function ephemeralRunCwd(runId: string): string {
  return join(workspaceRoot(), `${RUN_WORKSPACE_PREFIX}${runId}`);
}

/** Prefer a stable issue workspace; fall back to per-run only when issueId is absent. */
export function resolveDispatchCwd(opts: {
  issueId?: string;
  runId: string;
  connectionId?: string;
}): string {
  if (opts.issueId) {
    return issueWorkspaceCwd(opts.issueId, opts.connectionId ?? DEFAULT_CONNECTION_ID);
  }
  return ephemeralRunCwd(opts.runId);
}

export function isIssueWorkspaceCwd(cwd: string): boolean {
  const name = basename(cwd);
  if (!name.startsWith(ISSUE_WORKSPACE_PREFIX)) return false;
  if (isSiblingDirName(name)) return false;
  return true;
}

/**
 * Parse `issue-<uuid>` directory names. Sibling dirs (`issue-<uuid>-home`, …)
 * return null so callers only see the primary workspace folder.
 */
export function parseIssueIdFromWorkspaceDirName(name: string): string | null {
  if (!name.startsWith(ISSUE_WORKSPACE_PREFIX)) return null;
  if (isSiblingDirName(name)) return null;
  const id = name.slice(ISSUE_WORKSPACE_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function listIssueWorkspaceIssueIds(connectionId: string = DEFAULT_CONNECTION_ID): string[] {
  const root = connectionWorkspaceRoot(connectionId);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      const id = parseIssueIdFromWorkspaceDirName(name);
      if (id) out.push(id);
    }
  } catch (e) {
    log.agent.warn({ root, connectionId, ...errFields(e) }, "failed to list issue workspaces");
  }
  return out;
}

/** Remove cwd + harness sibling dirs (HOME / config mirrors). Best-effort. */
export function removeWorkspaceTree(cwd: string): void {
  const targets = [cwd, ...WORKSPACE_SIBLING_SUFFIXES.map((s) => `${cwd}${s}`)];
  for (const path of targets) {
    try {
      if (!existsSync(path)) continue;
      rmSync(path, { recursive: true, force: true });
      log.agent.info({ path }, "workspace path removed");
    } catch (e) {
      log.agent.warn({ path, ...errFields(e) }, "failed to remove workspace path (best-effort)");
    }
  }
}

function maybeRemoveEmptyDir(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    if (readdirSync(dir).length > 0) return;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Drop an issue workspace after Completed (or stale reconcile).
 * `GOOSE_KEEP_WORKSPACES=true` keeps it on disk for debugging.
 */
export function removeIssueWorkspace(issueId: string, connectionId: string = DEFAULT_CONNECTION_ID): void {
  if (config.goose.keepWorkspaces) {
    log.agent.info({ issueId, connectionId }, "keeping issue workspace (GOOSE_KEEP_WORKSPACES=true)");
    return;
  }
  removeWorkspaceTree(issueWorkspaceCwd(issueId, connectionId));
  // Drop empty conn-<id> parent so multi-Linear roots do not accumulate forever.
  if (connectionId && connectionId !== DEFAULT_CONNECTION_ID) {
    maybeRemoveEmptyDir(connectionWorkspaceRoot(connectionId));
  }
}

/**
 * Linear states that may keep an on-disk issue workspace.
 * Broader than footprint lock-holding: Planned/Refining keep the clone so Dev
 * does not re-clone after PMO, and Blocked keeps WIP before a branch exists.
 */
export function workspaceHoldingStates(states: {
  refining: string;
  planned: string;
  inProgress: string;
  codeReview: string;
  inReview: string;
  reopened: string;
  pendingMerge: string;
  blocked: string;
}): Set<string> {
  return new Set([
    states.refining,
    states.planned,
    states.inProgress,
    states.codeReview,
    states.inReview,
    states.reopened,
    states.pendingMerge,
    states.blocked,
  ]);
}

/**
 * After an agent run: delete only ephemeral `run-*` workspaces.
 * Issue-scoped dirs survive until Completed / stale reconcile.
 */
export function cleanupAfterRun(cwd: string, keep: boolean): void {
  if (keep || isIssueWorkspaceCwd(cwd)) return;
  removeWorkspaceTree(cwd);
}

/**
 * Remove top-level `run-*` dirs (and siblings) that are not in an active dispatch.
 * Covers crashes / pre-migration leftovers that reconcileStaleWorkspaces ignores
 * (it only scans issue-*).
 */
export function removeOrphanEphemeralRunDirs(
  activeCwds: ReadonlySet<string>,
  root: string = workspaceRoot()
): number {
  if (!existsSync(root)) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(RUN_WORKSPACE_PREFIX)) continue;
      if (isSiblingDirName(name)) continue;
      const cwd = join(root, name);
      if (activeCwds.has(cwd)) continue;
      removeWorkspaceTree(cwd);
      removed++;
    }
  } catch (e) {
    log.agent.warn({ root, ...errFields(e) }, "failed to sweep ephemeral run workspaces");
  }
  return removed;
}
