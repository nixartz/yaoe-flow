// ─────────────────────────────────────────────────────────────────────────
// SCHEDULER — controller de reconciliação declarativa (estilo k8s).
//
// Em vez de "no evento X faça Y", a cada tick ele pergunta: o estado atual do
// Linear bate com o desejado? E reconcilia:
//   1. fillRefiners  → preenche seats de PMO livres com To Do (+ gate)
//   2. fillWorkers   → preenche seats de Dev livres: Reopened PRIMEIRO, depois
//                      Planned (retrabalho pós-review desemperca a fila)
//   3. fillReviewers → preenche seats de reviewer livres com Code Review
//   4. drainMerge    → se nenhum merge está em voo, mergeia UM Pending Merge
//
// A contagem de "seats ocupados" é DERIVADA do Linear (nº de issues em
// Refining / In Progress / In Review), não de contadores em memória. Isso é
// self-healing: se um webhook se perder, o tick periódico corrige sozinho.
//
// Ciclo de vida do footprint lock:
//   adquirido ao mover Planned → In Progress  (libera o "seat" de footprint)
//   liberado  ao chegar em Completed          (o código já está na main)
//   sobrevive aos ciclos Code Review ⇄ Reopened (a branch continua existindo)
//   Blocked mantém o lock até um humano resolver
//   Self-heal: reconcileStaleLocks() no tick libera locks cujo estado Linear
//   já saiu do conjunto lock-holding (webhook de Completed perdido, etc.)
//
// Ciclo de vida do workspace em disco (issue-<id>):
//   criado no primeiro dispatch da issue (qualquer harness)
//   reutilizado até Completed (inclui Planned/Refining/Blocked/Reopened)
//   removido no webhook Completed + reconcileStaleWorkspaces() no tick
//
// Multi-Linear: cada tick itera sequencialmente sobre todos os contextos
// ativos (connections enabled ou fallback single-tenant). Locks, dispatches e
// queries são scoped ao connectionId do contexto corrente.
//
// IMPORTANTE — o tick NÃO pode awaitar harness/LLM. estimateFootprint (papel
// Orchestrator) e dispatch* vão via fire(); senão `running=true` prende a fila
// e os webhooks/ticks seguintes viram "tick skipped" até o agent terminar.
// ─────────────────────────────────────────────────────────────────────────
import { config } from "./config";
import { log, errFields } from "./logger";
import {
  linearFor,
  isLinearRateLimitError,
  shouldSkipTickForRateBudget,
  linearRateLimitCooldownMs,
  linearRateLimitSnapshot,
  type LinearClient,
} from "./linear";
import type { LinearContext } from "./db/linearConnections";
import { resolveActiveContexts } from "./db/linearConnections";
import { resolveGithubAccessToken } from "./githubAuth";
import * as agent from "./agent";
import * as locks from "./locks";
import * as github from "./github";
import * as store from "./dashboard/store";
import { collidesWithActive } from "./dag";
import { filesOutsideFootprint } from "./scope";
import { notify } from "./notifications/events";
import { budgetBanners, isActiveHarnessPausedForRole } from "./agent/harness/budget";
import { activeHarnessQuotaCooldownForRole } from "./agent/harness/quota";
import type { SchedulerRole } from "./agent/recipe/defaults";
import { refreshReadinessSnapshot } from "./readiness";
import {
  listIssueWorkspaceIssueIds,
  removeIssueWorkspace,
  removeOrphanEphemeralRunDirs,
  workspaceHoldingStates,
  issueWorkspaceCwd,
} from "./agent/workspace";
import type { Footprint } from "./types";

const S = config.states;

// Fases "ocupadas" — uma issue Nestes estados significa que um dispatch
// está COMEÇANDO ou AINDA EM VOO (não terminando). Usado por onStatusChange
// para nunca fechar por engano o run do próprio agente da fase.
// Pending Merge entra aqui porque o merge do Orchestrator roda SEM mudar o
// status (fica em Pending Merge até Completed): sem isto, um webhook de
// label/assignee (ou duplicata) com stateName=Pending Merge fechava o run
// do merge em ~2s enquanto o agent continuava executando.
const OCCUPIED_STATES = new Set<string>([S.refining, S.inProgress, S.inReview, S.pendingMerge]);

/** States that may legitimately hold a Valkey footprint lock. */
function lockHoldingStates(): Set<string> {
  return new Set([
    S.inProgress,
    S.codeReview,
    S.inReview,
    S.reopened,
    S.pendingMerge,
    S.blocked, // documented: keeps lock until a human resolves it
  ]);
}

function svcHeader(phase: string): string {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `🤖 **Orchestrator** · \`yaoe-flow\` · ${now} UTC · ${phase}`;
}

/**
 * Gate de quota do provider (agent/harness/quota.ts) — mesmo padrão do
 * budget pausar: checar ANTES de moveState/acquireLock, nunca depois (a
 * issue já teria sido movida). Um erro de quota anterior já devolveu a issue
 * pra fila e comentou o motivo (dispatch.ts); isto só evita bater na MESMA
 * parede de novo pra cada candidato do tick até o reset.
 */
async function quotaCoolingDown(ctx: LinearContext, role: SchedulerRole, label: string): Promise<boolean> {
  const resetAtMs = await activeHarnessQuotaCooldownForRole(ctx.connectionId, role);
  if (!resetAtMs) return false;
  log.scheduler.debug(
    { connectionId: ctx.connectionId, role, resetAt: new Date(resetAtMs).toISOString() },
    `${label} skipped: harness ativo em cooldown de quota do provider`
  );
  return true;
}

const AGENT_LABEL = {
  pmo: `${config.labels.agentPrefix}pmo`,
  dev: `${config.labels.agentPrefix}dev`,
  /** @deprecated label antiga — ainda removida no reconcile. */
  workerLegacy: `${config.labels.agentPrefix}senior-engineer`,
  reviewer: `${config.labels.agentPrefix}reviewer`,
} as const;

async function safeLabel(p: Promise<unknown>, operation: string, issueId: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    log.scheduler.warn({ issueId, operation, ...errFields(e) }, "label operation failed (best-effort)");
  }
}

async function moveState(lin: LinearClient, issueId: string, from: string | undefined, to: string, reason: string): Promise<void> {
  log.scheduler.info({ issueId, from, to, reason }, "moving issue state");
  await lin.setState(issueId, to);
}

/**
 * Assigna a issue ao viewer da API key da connection (o bot Linear).
 * Best-effort: falha não bloqueia o dispatch (só perde a métrica de assignee).
 */
async function assignToConnectionViewer(lin: LinearClient, issueId: string, ctx: LinearContext): Promise<void> {
  try {
    const viewer = await lin.getViewer();
    await lin.assignIssue(issueId, viewer.id);
    log.scheduler.info(
      {
        issueId,
        assigneeId: viewer.id,
        assigneeName: viewer.name,
        connectionId: ctx.connectionId,
        connectionName: ctx.name,
      },
      "assigned issue to connection viewer"
    );
  } catch (e) {
    log.scheduler.warn(
      { issueId, connectionId: ctx.connectionId, ...errFields(e) },
      "assign to connection viewer failed (best-effort)"
    );
  }
}

// Encerramento manual via dashboard (pausar/encerrar um agente em execução).
// Não existe "pausa" real pra um processo de agente em stream — "pausar" e
// "encerrar" são a MESMA ação técnica (mata o processo agora); a diferença é
// só o enquadramento do motivo que vira comentário. "Retomar" reusa 100% o
// fluxo que já existe: humano lê o comentário, resolve o que motivou a parada,
// e move a issue de volta pra Reopened — o worker pega o branch já existente
// em modo `fix`. Idempotente e seguro chamar mesmo se a issue não estiver de
// fato numa fase ocupada (vira só um comentário + no-op nos locks).
//
// Se ainda houver OUTRO processo/run vivo na mesma issue (duplicate-dispatch),
// NÃO move pra Blocked — isso fechava a irmã como "failed" via webhook enquanto
// o agent continuava executando.
export async function manualStopRun(
  issueId: string,
  reason: string,
  ctx?: LinearContext,
  opts?: { exceptRunId?: string }
): Promise<{ movedToBlocked: boolean }> {
  if (!ctx) {
    const ctxs = resolveActiveContexts();
    ctx = ctxs[0];
    if (!ctx) {
      log.scheduler.error({ issueId, reason }, "manualStopRun: no active Linear context — operation aborted");
      return { movedToBlocked: false };
    }
    if (ctxs.length > 1) {
      log.scheduler.warn(
        { issueId, reason, connectionId: ctx.connectionId, totalContexts: ctxs.length },
        "manualStopRun: ctx not provided, using the first active context (may not be the right one)"
      );
    }
  }
  const lin = linearFor(ctx);
  log.scheduler.warn({ issueId, reason, connectionId: ctx.connectionId }, "manual stop requested via dashboard");

  const liveSiblings = agent.listActiveRunIdsForIssue(issueId, opts?.exceptRunId);
  const openSiblings = store
    .listOpenRuns(issueId)
    .filter((r) => r.id !== opts?.exceptRunId)
    .map((r) => r.id);
  const stillBusy = liveSiblings.length > 0 || openSiblings.length > 0;

  if (stillBusy) {
    const siblingIds = [...new Set([...liveSiblings, ...openSiblings])];
    await lin.comment(
      issueId,
      `${svcHeader("Reliability")}\n\n🛑 Uma execução foi interrompida manualmente via dashboard.\n\n${reason}\n\n**Não** movendo para Blocked: ainda há run(s) ativa(s) nesta issue (\`${siblingIds.join("`, `")}\`). Aguarde concluir ou encerre as demais runs antes de bloquear.`
    );
    log.scheduler.warn(
      { issueId, siblingIds, connectionId: ctx.connectionId },
      "manual stop: sibling run still active — skipping Blocked transition"
    );
    return { movedToBlocked: false };
  }

  await lin.comment(
    issueId,
    `${svcHeader("Reliability")}\n\n🛑 Execução interrompida manualmente via dashboard.\n\n${reason}\n\nMovendo para Blocked. Revise e mova para Reopened para retomar — o worker pega o branch já existente em modo de correção.`
  );
  await moveState(lin, issueId, undefined, S.blocked, "manual stop via dashboard");
  // Mesma limpeza que Completed já faz, exceto footprint/lock: o Blocked
  // mantém o lock até um humano resolver (mesma semântica documentada em
  // config.ts para o estado Blocked em geral).
  await locks.clearMergingIf(ctx.connectionId, issueId);
  await locks.clearAttempts(ctx.connectionId, issueId);
  await locks.clearStarted(ctx.connectionId, issueId);
  return { movedToBlocked: true };
}

// ── Entrada por webhook ──
export async function onStatusChange(issueId: string, stateName: string, ctx: LinearContext): Promise<void> {
  log.scheduler.info({ issueId, stateName, connectionId: ctx.connectionId }, "processing status change");
  const lin = linearFor(ctx);

  const boundTeam = ctx.teamId;
  if (boundTeam) {
    const issue = await lin.getIssue(issueId);
    if (issue.teamId && issue.teamId !== boundTeam) {
      log.scheduler.debug(
        { issueId, stateName, issueTeamId: issue.teamId, boundTeamId: boundTeam, connectionId: ctx.connectionId },
        "status change ignored: issue belongs to another team"
      );
      return;
    }
  }

  // Reconciliação da dashboard: transição para FORA de uma fase ocupada
  // implica que o dispatch que a ocupava terminou. Pending Merge é ocupada
  // pelo merge do Orchestrator — ao ENTRAR nela, só fechamos o run do
  // reviewer (quem acabou de aprovar), nunca um merge já em voo.
  if (stateName === S.pendingMerge) {
    store.closeOpenRun(
      issueId,
      "reviewer",
      "completed",
      `Closed by a status transition in Linear (→ ${stateName})`
    );
  } else if (!OCCUPIED_STATES.has(stateName)) {
    const liveIds = agent.listActiveRunIdsForIssue(issueId);
    if (stateName === S.blocked && liveIds.length > 0) {
      // Human/manual Blocked while a twin (or slow) agent is still running:
      // close only dead open rows; leave live processes alone (they revive via
      // reviveRunIfStillActive if a race already marked them failed).
      log.scheduler.warn(
        { issueId, liveIds, connectionId: ctx.connectionId },
        "Blocked while dispatch still active — not closing live runs"
      );
      store.closeOpenRuns(
        issueId,
        "failed",
        `Closed by a status transition in Linear (→ ${stateName})`,
        { exceptRunIds: liveIds }
      );
    } else {
      store.closeOpenRuns(
        issueId,
        stateName === S.blocked ? "failed" : "completed",
        `Closed by a status transition in Linear (→ ${stateName})`
      );
    }
  }

  if (stateName === S.completed) {
    log.scheduler.info({ issueId, connectionId: ctx.connectionId }, "issue completed — releasing resources");
    await locks.releaseLock(ctx.connectionId, issueId);
    await locks.clearFootprint(ctx.connectionId, issueId);
    await locks.clearMergingIf(ctx.connectionId, issueId);
    await locks.clearAttempts(ctx.connectionId, issueId);
    await locks.clearStarted(ctx.connectionId, issueId);
    // Do not rm -rf under a still-running merge/agent — tick reconcile cleans up after.
    const busyCwd = issueWorkspaceCwd(issueId, ctx.connectionId);
    if (agent.activeDispatchCwds().has(busyCwd)) {
      log.scheduler.info(
        { issueId, connectionId: ctx.connectionId, cwd: busyCwd },
        "issue completed but dispatch still active — deferring workspace removal"
      );
    } else {
      removeIssueWorkspace(issueId, ctx.connectionId);
    }
  } else if (stateName === S.reopened) {
    log.scheduler.info({ issueId, connectionId: ctx.connectionId }, "issue reopened — clearing merge mutex if held");
    await locks.clearMergingIf(ctx.connectionId, issueId);
  } else if (stateName === S.blocked) {
    // §8.1: o pipeline depende de humano ver Blocked — notifica nos canais habilitados.
    notify("issue_blocked", { issueId, linearCtx: ctx });
  } else if (stateName === S.pendingMerge) {
    notify("issue_pending_merge", { issueId, linearCtx: ctx });
  }

  await tick();
}

// ── Loop de reconciliação (idempotente; roda por evento e periodicamente) ──
// `running`/`runningSince` são liberados no `finally` mesmo se algo lançar —
// isso já é suficiente pra nunca travar de vez, DESDE que nada dentro do tick
// fique pendurado indefinidamente. É por isso que toda chamada HTTP externa
// (Linear/GitHub/Hermes) tem timeout (config.httpTimeoutMs, ver linear.ts/
// github.ts/agent/hermes.ts) — sem timeout, um fetch() que nunca resolve
// prenderia esse `await` pra sempre e `running` nunca voltaria a `false`.
let running = false;
let runningSince = 0;

export async function tick(): Promise<void> {
  if (running) {
    const stuckMs = Date.now() - runningSince;
    if (stuckMs > config.tickIntervalMs * 3) {
      log.scheduler.warn(
        { stuckMs },
        "tick skipped: previous cycle still running longer than expected — if this persists, it indicates a stuck call despite httpTimeoutMs"
      );
    } else {
      log.scheduler.debug("tick skipped: already running");
    }
    return;
  }
  running = true;
  runningSince = Date.now();
  const start = runningSince;
  try {
    const contexts = resolveActiveContexts();
    log.scheduler.info(
      {
        connectionCount: contexts.length,
        connections: contexts.map((c) => ({
          id: c.connectionId,
          name: c.name,
          organizationId: c.organizationId || null,
          teamId: c.teamId,
          githubAuth: c.githubAuthMode ?? (c.githubToken ? "pat" : "global"),
        })),
      },
      "tick started"
    );
    if (contexts.length === 0) {
      log.scheduler.info("tick: nenhum contexto Linear ativo — nada a reconciliar");
      return;
    }
    // Disk-only: orphan run-* leftovers (crashes / pre-migration). Independent of
    // Linear rate limits — do not nest under a connection that may be skipped.
    {
      const swept = removeOrphanEphemeralRunDirs(agent.activeDispatchCwds());
      if (swept > 0) {
        log.scheduler.info({ removed: swept }, "orphan ephemeral run-* workspaces swept");
      }
    }
    for (const ctx of contexts) {
      const connStart = Date.now();
      const cooldownMs = linearRateLimitCooldownMs(ctx.apiKey);
      const budget = linearRateLimitSnapshot(ctx.apiKey);
      if (shouldSkipTickForRateBudget(ctx.apiKey)) {
        log.scheduler.warn(
          {
            connectionId: ctx.connectionId,
            connectionName: ctx.name,
            cooldownMs,
            remaining: budget.remaining,
            limit: budget.limit,
            resetAtMs: budget.resetAtMs,
          },
          "tick: skipping Linear connection — rate limit cooldown or request budget too low"
        );
        continue;
      }
      log.scheduler.info(
        {
          connectionId: ctx.connectionId,
          connectionName: ctx.name,
          organizationId: ctx.organizationId || null,
          teamId: ctx.teamId,
        },
        "tick: reconciling Linear connection"
      );
      try {
        const lin = linearFor(ctx);
        lin.beginTickCache();
        await prefetchTickStates(lin);
        // Self-heal missed Completed webhooks BEFORE fillWorkers, otherwise
        // Planned candidates stay blocked by zombie locks forever.
        await reconcileStaleLocks(ctx);
        await reconcileStaleWorkspaces(ctx);
        await fillRefiners(ctx);
        await fillWorkers(ctx);
        await fillReviewers(ctx);
        await drainMerge(ctx);
        await reclaimStale(ctx);
        await reconcileAgentLabels(ctx);
        log.scheduler.info(
          {
            connectionId: ctx.connectionId,
            connectionName: ctx.name,
            durationMs: Date.now() - connStart,
            linearRemaining: linearRateLimitSnapshot(ctx.apiKey).remaining,
          },
          "tick: connection reconciled"
        );
      } catch (e) {
        if (isLinearRateLimitError(e)) {
          log.scheduler.warn(
            {
              connectionId: ctx.connectionId,
              connectionName: ctx.name,
              resetAtMs: e.resetAtMs,
              remaining: e.remaining,
              limit: e.limit,
              cooldownMs: Math.max(0, e.resetAtMs - Date.now()),
            },
            "tick: Linear rate limited — cooling down this connection until reset"
          );
        } else {
          // Isola falha por connection: um 503 do Linear numa org não pode matar
          // o fillWorkers da outra (antes o throw abortava o tick inteiro).
          log.scheduler.error(
            { connectionId: ctx.connectionId, connectionName: ctx.name, ...errFields(e) },
            "tick: falha ao reconciliar connection — seguindo para as demais"
          );
        }
      }
      // Snapshot mesmo após falha parcial: a dashboard precisa de alguma visão.
      // Best-effort interno (refreshReadinessSnapshot não propaga throw).
      // Skip when still rate-limited — readiness alone is ~10 listByState calls.
      if (!shouldSkipTickForRateBudget(ctx.apiKey)) {
        await refreshReadinessSnapshot(ctx);
      }
    }
    checkBudgetBanners();
    log.scheduler.info({ durationMs: Date.now() - start, connectionCount: contexts.length }, "tick completed");
  } catch (e) {
    throw e;
  } finally {
    running = false;
  }
}

// One GraphQL round-trip instead of up to 8: fillRefiners/fillWorkers/
// fillReviewers/reclaimStale/pendingMergeIssues each read one of these plain
// (non-label-gated) by-state lists every tick. Warming them together via
// listIssuesInStates lets every later listIssuesInState/countInState call
// for the same state hit tickListCache instead of issuing its own request.
// The ready-to-* label-gated variant (listIssuesInStateWithLabel) is a
// different cache key/query and isn't covered here — only relevant when the
// human curation gate (autoDispatchIssues=false) is active for that queue.
async function prefetchTickStates(lin: LinearClient): Promise<void> {
  const states = [S.refining, S.inProgress, S.reopened, S.inReview, S.codeReview, S.pendingMerge];
  if (config.autoDispatchIssues) states.push(S.todo, S.planned);
  try {
    await lin.listIssuesInStates(states);
  } catch (e) {
    // Best-effort warm-up only — a failure here just means each caller falls
    // back to its own individual listIssuesInState/countInState call below.
    log.scheduler.debug({ ...errFields(e) }, "prefetchTickStates failed (non-fatal, falling back to per-call fetch)");
  }
}

/**
 * `onlyIssueId` (§8.2, dispatch manual): antecipa o tick pra UMA issue,
 * respeitando tudo (gates/deps/footprint/seats) — não é bypass, é só não
 * esperar o próximo tick periódico. Sem o filtro (uso normal do tick), varre
 * todos os candidatos.
 */
async function fillRefiners(ctx: LinearContext, onlyIssueId?: string): Promise<boolean> {
  const lin = linearFor(ctx);
  const occupied = await lin.countInState(S.refining);
  let free = config.capacity.maxPmoWorkers - occupied;
  log.scheduler.debug({ occupied, free, max: config.capacity.maxPmoWorkers, connectionId: ctx.connectionId }, "fillRefiners capacity");

  if (free <= 0) return false;

  // Gate humano ready-to-refine — espelha AUTO_MERGE_ISSUES pro refine.
  const all = config.autoDispatchIssues
    ? await lin.listIssuesInState(S.todo)
    : await lin.listIssuesInStateWithLabel(S.todo, config.labels.readyToRefine);
  const ready = onlyIssueId ? all.filter((i) => i.id === onlyIssueId) : all;
  log.scheduler.debug(
    { candidateCount: ready.length, autoDispatch: config.autoDispatchIssues, connectionId: ctx.connectionId },
    "fillRefiners candidates"
  );

  // §7.4: budget pausar do harness do PMO — NÃO move a issue (igual seat cheio).
  if (isActiveHarnessPausedForRole("pmo")) {
    log.scheduler.debug("fillRefiners skipped: harness ativo do PMO com budget pausar");
    return false;
  }
  if (await quotaCoolingDown(ctx, "pmo", "fillRefiners")) return false;

  let dispatched = false;
  for (const issue of ready) {
    if (free <= 0) break;
    log.scheduler.info({ issueId: issue.id, identifier: issue.identifier, connectionId: ctx.connectionId }, "dispatching refiner");
    await moveState(lin, issue.id, S.todo, S.refining, "fillRefiners");
    await locks.markStarted(ctx.connectionId, issue.id);
    await safeLabel(
      lin.mutateLabels(issue.id, {
        remove: config.autoDispatchIssues ? [] : [config.labels.readyToRefine],
        add: [AGENT_LABEL.pmo],
      }),
      "mutateLabels(ready→pmo)",
      issue.id
    );
    fire(agent.dispatchRefine(issue.id, ctx), "dispatchRefine", issue.id);
    free--;
    dispatched = true;
  }
  return dispatched;
}

async function fillWorkers(ctx: LinearContext, onlyIssueId?: string): Promise<boolean> {
  const lin = linearFor(ctx);
  const occupied = await lin.countInState(S.inProgress);
  let free = config.capacity.maxDevWorkers - occupied;
  log.scheduler.debug({ occupied, free, max: config.capacity.maxDevWorkers, connectionId: ctx.connectionId }, "fillWorkers capacity");

  if (free <= 0) {
    return false;
  }

  const reopened = await lin.listIssuesInState(S.reopened);
  // Gate humano ready-to-implement — com AUTO_DISPATCH_ISSUES=true, Planned basta.
  const planned = config.autoDispatchIssues
    ? await lin.listIssuesInState(S.planned)
    : await lin.listIssuesInStateWithLabel(S.planned, config.labels.readyToImplement);
  log.scheduler.debug(
    {
      reopenedCount: reopened.length,
      plannedCount: planned.length,
      autoDispatch: config.autoDispatchIssues,
      connectionId: ctx.connectionId,
    },
    "fillWorkers candidates"
  );

  // Prioridade explícita: Reopened (retrabalho pós-review) antes de Planned.
  // Assim a fila "desempaca" correções antes de abrir implementação nova.
  const tiers = [
    onlyIssueId ? reopened.filter((i) => i.id === onlyIssueId) : reopened,
    onlyIssueId ? planned.filter((i) => i.id === onlyIssueId) : planned,
  ];

  let dispatched = false;
  for (const tier of tiers) {
    for (const issue of tier) {
      if (free <= 0) break;
      const result = await tryDispatchImpl(ctx, issue.id, issue.stateName);
      if (result === "dispatched" || result === "estimating") {
        // `estimating` reserva o seat localmente: o footprint ainda vai rodar
        // em background, mas não liberamos a vaga pra um Planned "furar fila".
        free--;
        dispatched = true;
      }
    }
    if (free <= 0) break;
  }
  return dispatched;
}

// Identifiers das issues em Pending Merge (exclui a própria) — vira a linha
// `pendingMergeIssues:` do input do worker, que é OBRIGADO a checar se alguma
// dessas PRs pendentes sobrepõe o que ele vai implementar antes de criar
// branch da main (ver SOUL do Senior Engineer). Relevante sobretudo com
// AUTO_MERGE_ISSUES=false, quando PRs aprovadas acumulam aguardando o gate
// humano. Best-effort: falha na consulta vira lista vazia (não trava dispatch).
async function pendingMergeIssues(ctx: LinearContext, excludeId: string): Promise<string[]> {
  try {
    const lin = linearFor(ctx);
    return (await lin.listIssuesInState(S.pendingMerge))
      .filter((i) => i.id !== excludeId)
      .map((i) => i.identifier);
  } catch (e) {
    log.scheduler.warn({ excludeId, connectionId: ctx.connectionId, ...errFields(e) }, "pendingMergeIssues lookup failed (best-effort)");
    return [];
  }
}

/** Resultado de tryDispatchImpl — `estimating` = seat reservado, agent em background. */
type TryDispatchResult = "dispatched" | "estimating" | "skipped";

async function tryDispatchImpl(ctx: LinearContext, issueId: string, stateName: string): Promise<TryDispatchResult> {
  const lin = linearFor(ctx);

  // §7.4: budget pausar do harness do Dev — ANTES de qualquer moveState /
  // acquireLock / bumpAttempts. Issue fica onde está (igual seat cheio).
  if (isActiveHarnessPausedForRole("dev")) {
    log.scheduler.debug({ issueId, connectionId: ctx.connectionId }, "dev dispatch skipped: harness ativo com budget pausar");
    return "skipped";
  }
  if (await quotaCoolingDown(ctx, "dev", "dev dispatch")) return "skipped";

  // Hard exclusivity: never start a second Dev (or Orchestrator estimate) while
  // one is already in flight for this issue — covers webhook/tick races that
  // the Valkey lock alone used to miss (estimateThenDispatch runs outside the
  // tick mutex).
  if (store.findOpenRun(issueId, "dev") || agent.hasActiveDispatchForIssue(issueId)) {
    log.scheduler.debug({ issueId, connectionId: ctx.connectionId }, "dev dispatch skipped: issue already has an active run");
    return "skipped";
  }

  if (await locks.hasLock(ctx.connectionId, issueId)) {
    // Lock vivo + Planned é estado inconsistente: o lock só deveria coexistir
    // com o ciclo In Progress⇄Code Review⇄Reopened. Acontece quando a issue
    // volta pra Planned (manual / tick parcial após acquireLock) sem passar
    // por Completed. Sem liberar, o gate ready-to-implement nunca despacha —
    // cada tick vê o candidato e pula em silêncio (debug).
    if (stateName === S.planned) {
      log.scheduler.warn(
        { issueId, stateName, connectionId: ctx.connectionId },
        "orphaned lock on Planned — releasing it to honor ready-to-implement"
      );
      await locks.releaseLock(ctx.connectionId, issueId);
      await locks.clearAttempts(ctx.connectionId, issueId);
      await locks.clearStarted(ctx.connectionId, issueId);
    } else if (stateName !== S.reopened) {
      log.scheduler.debug({ issueId, stateName, connectionId: ctx.connectionId }, "dev dispatch skipped: lock held but not reopened");
      return "skipped";
    } else {
      const attempts = await locks.getAttempts(ctx.connectionId, issueId);
      if (attempts >= config.reliability.maxAttempts) {
        log.scheduler.warn(
          { issueId, attempts, maxAttempts: config.reliability.maxAttempts, connectionId: ctx.connectionId },
          "circuit breaker triggered"
        );
        await lin.comment(
          issueId,
          `${svcHeader("Reliability")}\n\n🛑 Circuit breaker: ${attempts} ciclos de retrabalho sem aprovação. Pausando para decisão humana. Resolva e mova para Reopened para retomar (com orçamento de tentativas novo).`
        );
        await locks.clearAttempts(ctx.connectionId, issueId);
        await moveState(lin, issueId, S.reopened, S.blocked, "circuit breaker");
        notify("circuit_breaker", {
          issueId,
          attempts,
          maxAttempts: config.reliability.maxAttempts,
          linearCtx: ctx,
        });
        return "skipped";
      }

      const n = await locks.bumpAttempts(ctx.connectionId, issueId);
      log.scheduler.info(
        { issueId, attempt: n, maxAttempts: config.reliability.maxAttempts, connectionId: ctx.connectionId },
        "re-dispatching dev for fix"
      );
      await lin.comment(
        issueId,
        `${svcHeader("Reliability")}\n\n🔁 Retry ${n}/${config.reliability.maxAttempts}: re-despachando para correção após retrabalho. Ao atingir o limite, a task vai para Blocked (decisão humana).`
      );
      await moveState(lin, issueId, S.reopened, S.inProgress, "dev fix retry");
      await locks.markStarted(ctx.connectionId, issueId);
      await safeLabel(lin.addLabel(issueId, AGENT_LABEL.dev), "addLabel(dev)", issueId);
      await safeLabel(lin.removeLabel(issueId, AGENT_LABEL.workerLegacy), "removeLabel(legacy-senior-engineer)", issueId);
      await assignToConnectionViewer(lin, issueId, ctx);
      fire(agent.dispatchWorker(issueId, "fix", await pendingMergeIssues(ctx, issueId), ctx), "dispatchWorker", issueId);
      return "dispatched";
    }
  }

  if (!(await depsSatisfied(ctx, issueId))) {
    log.scheduler.debug({ issueId, connectionId: ctx.connectionId }, "dev dispatch skipped: dependencies not satisfied");
    return "skipped";
  }

  let footprint = await locks.getFootprint(ctx.connectionId, issueId);
  if (!footprint) {
    // Dedup: without a reservation, every tick/webhook while Planned re-fired
    // estimateThenDispatch → multiple Orchestrator runs, then twin Dev commits.
    if (
      (await locks.isEstimating(ctx.connectionId, issueId)) ||
      store.findOpenRun(issueId, "orchestrator")
    ) {
      log.scheduler.debug(
        { issueId, connectionId: ctx.connectionId },
        "dev dispatch skipped: footprint estimate already in flight"
      );
      return "skipped";
    }
    if (!(await locks.tryBeginEstimate(ctx.connectionId, issueId))) {
      log.scheduler.debug(
        { issueId, connectionId: ctx.connectionId },
        "dev dispatch skipped: lost estimate reservation race"
      );
      return "skipped";
    }
    // NÃO awaita o Orchestrator aqui — segurava `running` do tick por dezenas
    // de segundos e os webhooks seguintes viravam "tick skipped".
    log.scheduler.info(
      { issueId, stateName, connectionId: ctx.connectionId },
      "estimating footprint before dispatch (async — the tick does not wait)"
    );
    fire(estimateThenDispatch(ctx, issueId, stateName), "estimateThenDispatch", issueId);
    return "estimating";
  }

  return (await commitNewImplementation(ctx, issueId, stateName, footprint)) ? "dispatched" : "skipped";
}

/**
 * Continuação pós-estimate em background. Revalida seats/deps/estado — o mundo
 * pode ter mudado enquanto o Orchestrator estimava.
 */
async function estimateThenDispatch(ctx: LinearContext, issueId: string, expectedState: string): Promise<void> {
  try {
    const footprint = await agent.estimateFootprint(issueId, ctx);
    await locks.setFootprint(ctx.connectionId, issueId, footprint);

    const lin = linearFor(ctx);
    const issue = await lin.getIssue(issueId);
    if (issue.stateName !== S.planned && issue.stateName !== S.reopened) {
      log.scheduler.info(
        { issueId, stateName: issue.stateName, expectedState, connectionId: ctx.connectionId },
        "estimate done but issue left Planned/Reopened — abort dispatch"
      );
      return;
    }

    if (isActiveHarnessPausedForRole("dev")) {
      log.scheduler.debug({ issueId, connectionId: ctx.connectionId }, "estimate done: harness Dev pausado — abort");
      return;
    }
    if (await quotaCoolingDown(ctx, "dev", "estimate done")) return;

    if (store.findOpenRun(issueId, "dev") || agent.hasActiveDispatchForIssue(issueId)) {
      log.scheduler.info(
        { issueId, connectionId: ctx.connectionId },
        "estimate done: Dev already active for issue — abort duplicate dispatch"
      );
      return;
    }

    const occupied = await lin.countInState(S.inProgress);
    if (occupied >= config.capacity.maxDevWorkers) {
      log.scheduler.info(
        { issueId, occupied, max: config.capacity.maxDevWorkers, connectionId: ctx.connectionId },
        "estimate done but no free Dev seats — next tick will retry"
      );
      return;
    }

    if (!(await depsSatisfied(ctx, issueId))) {
      log.scheduler.debug({ issueId, connectionId: ctx.connectionId }, "estimate done: deps not satisfied — abort");
      return;
    }

    // Se no meio tempo virou Reopened com lock (raro), o caminho de fix retry
    // do próximo tick cuida — aqui só implementação "nova" / sem lock.
    if (await locks.hasLock(ctx.connectionId, issueId) && issue.stateName === S.reopened) {
      log.scheduler.info({ issueId, connectionId: ctx.connectionId }, "estimate done: reopened with lock — defer to fix-retry path");
      return;
    }

    const active = (await locks.activeFootprints(ctx.connectionId)).map((a) => a.footprint);
    if (collidesWithActive(footprint, active)) {
      log.scheduler.debug({ issueId, footprint, connectionId: ctx.connectionId }, "estimate done: footprint collision — abort");
      return;
    }

    await commitNewImplementation(ctx, issue.id, issue.stateName, footprint);
  } finally {
    await locks.clearEstimating(ctx.connectionId, issueId);
  }
}

async function commitNewImplementation(
  ctx: LinearContext,
  issueId: string,
  stateName: string,
  footprint: Footprint
): Promise<boolean> {
  const lin = linearFor(ctx);

  if (store.findOpenRun(issueId, "dev") || agent.hasActiveDispatchForIssue(issueId)) {
    log.scheduler.info(
      { issueId, connectionId: ctx.connectionId },
      "dev dispatch skipped: issue already has an active Dev/run"
    );
    return false;
  }

  const active = (await locks.activeFootprints(ctx.connectionId)).map((a) => a.footprint);
  if (collidesWithActive(footprint, active)) {
    log.scheduler.debug({ issueId, footprint, connectionId: ctx.connectionId }, "dev dispatch skipped: footprint collision");
    return false;
  }

  // Exclusive claim — two estimateThenDispatch completions must not both spawn Dev.
  if (!(await locks.tryAcquireLock(ctx.connectionId, issueId, footprint))) {
    log.scheduler.info(
      { issueId, connectionId: ctx.connectionId },
      "dev dispatch skipped: lost exclusive lock race"
    );
    return false;
  }

  log.scheduler.info({ issueId, footprint, mode: "implement", connectionId: ctx.connectionId }, "dispatching dev");
  await moveState(lin, issueId, stateName, S.inProgress, "new implementation");
  await locks.markStarted(ctx.connectionId, issueId);
  if (stateName === S.planned) {
    // Consome o gate ready-to-implement (quando ativo) e decora com o Dev.
    await safeLabel(
      lin.mutateLabels(issueId, {
        remove: [
          ...(config.autoDispatchIssues ? [] : [config.labels.readyToImplement]),
          AGENT_LABEL.workerLegacy,
        ],
        add: [AGENT_LABEL.dev],
      }),
      "mutateLabels(ready→dev)",
      issueId
    );
  } else {
    await safeLabel(lin.addLabel(issueId, AGENT_LABEL.dev), "addLabel(dev)", issueId);
    await safeLabel(lin.removeLabel(issueId, AGENT_LABEL.workerLegacy), "removeLabel(legacy-senior-engineer)", issueId);
  }
  await assignToConnectionViewer(lin, issueId, ctx);
  fire(agent.dispatchWorker(issueId, "implement", await pendingMergeIssues(ctx, issueId), ctx), "dispatchWorker", issueId);
  return true;
}

async function depsSatisfied(ctx: LinearContext, issueId: string): Promise<boolean> {
  const lin = linearFor(ctx);
  const issue = await lin.getIssue(issueId);
  for (const depId of issue.blockedBy) {
    const dep = await lin.getIssue(depId);
    if (dep.stateName !== S.completed) {
      log.scheduler.debug(
        { issueId, blockedBy: depId, depState: dep.stateName, connectionId: ctx.connectionId },
        "dependency not completed"
      );
      return false;
    }
  }
  return true;
}

async function fillReviewers(ctx: LinearContext, onlyIssueId?: string): Promise<boolean> {
  const lin = linearFor(ctx);
  const occupied = await lin.countInState(S.inReview);
  let free = config.capacity.maxReviewerWorkers - occupied;
  log.scheduler.debug({ occupied, free, max: config.capacity.maxReviewerWorkers, connectionId: ctx.connectionId }, "fillReviewers capacity");

  if (free <= 0) return false;

  const all = await lin.listIssuesInState(S.codeReview);
  const candidates = onlyIssueId ? all.filter((i) => i.id === onlyIssueId) : all;
  log.scheduler.debug({ candidateCount: candidates.length, connectionId: ctx.connectionId }, "fillReviewers candidates");

  // §7.4: budget pausar do harness do reviewer — NÃO move a issue.
  if (isActiveHarnessPausedForRole("reviewer")) {
    log.scheduler.debug("fillReviewers skipped: harness ativo do reviewer com budget pausar");
    return false;
  }
  if (await quotaCoolingDown(ctx, "reviewer", "fillReviewers")) return false;

  let dispatched = false;
  for (const issue of candidates) {
    if (free <= 0) break;
    if (!(await scopeCheckPasses(ctx, issue.id))) continue;
    log.scheduler.info({ issueId: issue.id, identifier: issue.identifier, connectionId: ctx.connectionId }, "dispatching reviewer");
    await moveState(lin, issue.id, S.codeReview, S.inReview, "fillReviewers");
    await locks.markStarted(ctx.connectionId, issue.id);
    await safeLabel(lin.addLabel(issue.id, AGENT_LABEL.reviewer), "addLabel(reviewer)", issue.id);
    fire(agent.dispatchReviewer(issue.id, ctx), "dispatchReviewer", issue.id);
    free--;
    dispatched = true;
  }
  return dispatched;
}

async function findPr(ctx: LinearContext, issueId: string): Promise<github.PrRef | null> {
  const lin = linearFor(ctx);
  for (const url of await lin.getAttachmentUrls(issueId)) {
    const pr = github.parsePrUrl(url);
    if (pr) {
      log.scheduler.debug({ issueId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, source: "attachment", connectionId: ctx.connectionId }, "PR found");
      return pr;
    }
  }
  for (const body of await lin.listCommentBodies(issueId)) {
    const pr = github.parsePrUrl(body);
    if (pr) {
      log.scheduler.debug({ issueId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, source: "comment", connectionId: ctx.connectionId }, "PR found");
      return pr;
    }
  }
  log.scheduler.debug({ issueId, connectionId: ctx.connectionId }, "PR not found");
  return null;
}

async function scopeCheckPasses(ctx: LinearContext, issueId: string): Promise<boolean> {
  const lin = linearFor(ctx);
  const pr = await findPr(ctx, issueId);
  if (!pr) {
    log.scheduler.warn({ issueId, connectionId: ctx.connectionId }, "scope-check failed: PR not found");
    await lin.comment(
      issueId,
      `${svcHeader("Scope-check")}\n\n🛑 PR não encontrada na issue. O worker precisa anexar o link da PR (Linear \`links\`) — ou ao menos postar a URL completa no comentário — para o scope-check rodar.\n\nMovendo para Reopened.`
    );
    await moveState(lin, issueId, S.codeReview, S.reopened, "scope-check: no PR");
    return false;
  }

  const authorizedOrgs = config.security.authorizedOrgs;
  if (authorizedOrgs.length > 0 && !authorizedOrgs.includes(pr.owner.toLowerCase())) {
    log.scheduler.error(
      { issueId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, authorizedOrgs, connectionId: ctx.connectionId },
      "scope-check failed: PR repo owner not in AGENT_AUTHORIZED_ORGS"
    );
    await lin.comment(
      issueId,
      `${svcHeader("Scope-check")}\n\n🛑 A PR está no repositório \`${pr.owner}/${pr.repo}\`, que **não está** na lista de organizações autorizadas (\`AGENT_AUTHORIZED_ORGS\`). Isso não é um problema que o worker corrige sozinho — pode ser um repositório errado (ex.: fork/clone equivocado) ou a lista de organizações autorizadas precisa ser atualizada.\n\nMovendo para Blocked até uma decisão humana.`
    );
    await moveState(lin, issueId, S.codeReview, S.blocked, "scope-check: unauthorized repo owner");
    return false;
  }

  const footprint = (await locks.getFootprint(ctx.connectionId, issueId)) ?? [];
  if (footprint.length === 0) {
    log.scheduler.warn({ issueId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, connectionId: ctx.connectionId }, "scope-check skipped: no footprint");
    await lin.comment(
      issueId,
      `${svcHeader("Scope-check")}\n\n⚠️ Footprint não disponível para esta task — scope-check determinístico pulado. A auditoria de escopo fica a cargo do Reviewer (defesa em profundidade).`
    );
    return true;
  }

  // Modo App: mint/cache do installation token acontece aqui dentro — a mesma
  // credencial que o worker usou pra abrir a PR lê os arquivos dela.
  const githubToken = await resolveGithubAccessToken(ctx);
  const changed = await github.getChangedFiles(pr, githubToken);
  const outside = filesOutsideFootprint(changed, footprint, pr.repo);
  if (outside.length === 0) {
    log.scheduler.info(
      { issueId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, fileCount: changed.length, connectionId: ctx.connectionId },
      "scope-check passed"
    );
    return true;
  }

  log.scheduler.warn(
    { issueId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, outsideFiles: outside, connectionId: ctx.connectionId },
    "scope-check failed: files outside footprint"
  );
  const list = outside.map((f) => `- \`${f}\``).join("\n");
  await lin.comment(
    issueId,
    `${svcHeader("Scope-check")}\n\n🚧 Arquivos fora do footprint declarado (${pr.repo}):\n${list}\n\nA mudança de **código de feature/módulo** precisa caber no footprint da task (locks, config de toolchain e testes companion são exceção — protocolo §8.1 — e já foram ignorados neste check). Movendo para Reopened.`
  );
  await github.commentOnPr(
    pr,
    `${svcHeader("Scope-check")}\n\n🚧 Arquivos fora do footprint declarado (não-ancillary):\n${list}`,
    githubToken
  );
  await moveState(lin, issueId, S.codeReview, S.reopened, "scope-check: footprint violation");
  return false;
}

async function drainMerge(ctx: LinearContext, onlyIssueId?: string): Promise<boolean> {
  const lin = linearFor(ctx);
  if (config.capacity.maxOrchestratorWorkers <= 0) {
    log.scheduler.debug({ connectionId: ctx.connectionId }, "drainMerge skipped: MAX_ORCHESTRATOR_WORKERS=0");
    return false;
  }
  if (await locks.isMerging(ctx.connectionId)) {
    const issueId = await locks.mergingIssue(ctx.connectionId);
    log.scheduler.debug({ issueId, connectionId: ctx.connectionId }, "drainMerge skipped: merge in progress");
    return false;
  }

  // Terceiro gate humano (espelha ready-to-refine/ready-to-implement): com
  // AUTO_MERGE_ISSUES=false (default), só entra na fila de merge quem tiver a
  // label ready-to-merge — Pending Merge sem a label fica aguardando revisão
  // humana da PR. Com a flag ligada, Pending Merge basta (comportamento antigo).
  const all = config.autoMergeIssues
    ? await lin.listIssuesInState(S.pendingMerge)
    : await lin.listIssuesInStateWithLabel(S.pendingMerge, config.labels.readyToMerge);
  const pending = onlyIssueId ? all.filter((i) => i.id === onlyIssueId) : all;
  if (pending.length === 0) {
    log.scheduler.debug({ autoMerge: config.autoMergeIssues, connectionId: ctx.connectionId }, "drainMerge: no pending merge issues (gated by ready-to-merge when autoMerge=false)");
    return false;
  }

  // §7.4: budget pausar do harness do orchestrator — NÃO seta mutex de merge
  // nem consome a label ready-to-merge (issue fica em Pending Merge).
  if (isActiveHarnessPausedForRole("orchestrator")) {
    log.scheduler.debug("drainMerge skipped: harness ativo do orchestrator com budget pausar");
    return false;
  }
  if (await quotaCoolingDown(ctx, "orchestrator", "drainMerge")) return false;

  const issue = pending[0];
  log.scheduler.info({ issueId: issue.id, identifier: issue.identifier, queueSize: pending.length, autoMerge: config.autoMergeIssues, connectionId: ctx.connectionId }, "dispatching merge");
  await locks.setMerging(ctx.connectionId, issue.id);
  if (!config.autoMergeIssues) {
    // Consome o gate (já cumpriu o papel) — mesmo padrão de ready-to-refine/implement.
    await safeLabel(lin.removeLabel(issue.id, config.labels.readyToMerge), "removeLabel(ready-to-merge)", issue.id);
  }
  fire(agent.dispatchMerge(issue.id, ctx), "dispatchMerge", issue.id);
  return true;
}

/**
 * Dispatch manual (§8.2): antecipa o tick pra UMA issue, respeitando gates/
 * deps/footprint/seats — não é bypass, só não espera o próximo tick
 * periódico. Tenta as 4 filas na ordem do tick normal; a primeira que
 * reconhecer a issue como candidata válida despacha.
 */
export async function dispatchIssueNow(issueId: string, ctx?: LinearContext): Promise<{ dispatched: boolean; reason?: string }> {
  log.scheduler.info({ issueId, connectionId: ctx?.connectionId }, "manual dispatch requested via dashboard");

  if (ctx) {
    if (await fillRefiners(ctx, issueId)) return { dispatched: true };
    if (await fillWorkers(ctx, issueId)) return { dispatched: true };
    if (await fillReviewers(ctx, issueId)) return { dispatched: true };
    if (await drainMerge(ctx, issueId)) return { dispatched: true };
  } else {
    // Sem ctx explícito: tenta cada contexto ativo até um despachar.
    const contexts = resolveActiveContexts();
    for (const c of contexts) {
      if (await fillRefiners(c, issueId)) return { dispatched: true };
      if (await fillWorkers(c, issueId)) return { dispatched: true };
      if (await fillReviewers(c, issueId)) return { dispatched: true };
      if (await drainMerge(c, issueId)) return { dispatched: true };
    }
  }
  return {
    dispatched: false,
    reason:
      "the issue is not in a state/gate eligible for dispatch right now (check status, curation labels, dependencies, capacity and footprint) — nothing was moved",
  };
}

async function reclaimStale(ctx: LinearContext): Promise<void> {
  const lin = linearFor(ctx);
  const now = Date.now();
  const R = config.reliability;

  await reclaimPhase(ctx, S.refining, R.refiningTimeoutMs, now, async (id) => {
    log.scheduler.warn({ issueId: id, phase: S.refining, connectionId: ctx.connectionId }, "reclaiming stale seat");
    await lin.comment(
      id,
      `${svcHeader("Reliability")}\n\n⚠️ Refining parado além do limite — o PMO pode ter morrido/travado. Devolvendo para ${S.todo} (re-enfileira para refino).`
    );
    store.closeOpenRun(id, undefined, "timeout", "Reclaim: Refining parado além do timeout (agent morto/travado)");
    await safeLabel(lin.addLabel(id, config.labels.readyToRefine), "addLabel(ready)", id);
    await moveState(lin, id, S.refining, S.todo, "reclaim: refining timeout");
    notify("reclaim_timeout", { issueId: id, phase: S.refining, linearCtx: ctx });
  });

  await reclaimPhase(ctx, S.inProgress, R.inProgressTimeoutMs, now, async (id) => {
    log.scheduler.warn({ issueId: id, phase: S.inProgress, connectionId: ctx.connectionId }, "reclaiming stale seat");
    await lin.comment(
      id,
      `${svcHeader("Reliability")}\n\n⚠️ In Progress parado além do limite — o worker pode ter morrido/travado. Devolvendo para ${S.reopened}.`
    );
    store.closeOpenRun(id, undefined, "timeout", "Reclaim: In Progress parado além do timeout (agent morto/travado)");
    await moveState(lin, id, S.inProgress, S.reopened, "reclaim: in progress timeout");
    notify("reclaim_timeout", { issueId: id, phase: S.inProgress, linearCtx: ctx });
  });

  await reclaimPhase(ctx, S.inReview, R.inReviewTimeoutMs, now, async (id) => {
    log.scheduler.warn({ issueId: id, phase: S.inReview, connectionId: ctx.connectionId }, "reclaiming stale seat");
    await lin.comment(
      id,
      `${svcHeader("Reliability")}\n\n⚠️ In Review parado além do limite — o reviewer pode ter morrido/travado. Devolvendo para ${S.codeReview}.`
    );
    store.closeOpenRun(id, undefined, "timeout", "Reclaim: In Review parado além do timeout (agent morto/travado)");
    await moveState(lin, id, S.inReview, S.codeReview, "reclaim: in review timeout");
    notify("reclaim_timeout", { issueId: id, phase: S.inReview, linearCtx: ctx });
  });

  const since = await locks.mergingSince(ctx.connectionId);
  if (since !== null && now - since > R.mergeTimeoutMs) {
    const id = await locks.mergingIssue(ctx.connectionId);
    if (id) {
      try {
        log.scheduler.warn({ issueId: id, staleMs: now - since, connectionId: ctx.connectionId }, "reclaiming stale merge");
        await lin.comment(
          id,
          `${svcHeader("Reliability")}\n\n⚠️ Merge parado além do limite — liberando o mutex de merge e devolvendo para ${S.reopened}.`
        );
        store.closeOpenRun(id, undefined, "timeout", "Reclaim: merge parado além do timeout (agent morto/travado)");
        await moveState(lin, id, S.pendingMerge, S.reopened, "reclaim: merge timeout");
        notify("reclaim_timeout", { issueId: id, phase: S.pendingMerge, linearCtx: ctx });
      } catch (e) {
        log.scheduler.error({ issueId: id, connectionId: ctx.connectionId, ...errFields(e) }, "reclaim merge failed");
      }
    }
    await locks.clearMerging(ctx.connectionId);
  }
}

async function reclaimPhase(
  ctx: LinearContext,
  state: string,
  limitMs: number,
  now: number,
  action: (id: string) => Promise<void>
): Promise<void> {
  const lin = linearFor(ctx);
  for (const issue of await lin.listIssuesInState(state)) {
    try {
      const started = await locks.getStarted(ctx.connectionId, issue.id);
      if (started === null) {
        await locks.markStarted(ctx.connectionId, issue.id);
        continue;
      }
      if (now - started <= limitMs) continue;

      // O timeout é de INATIVIDADE, não de duração total: um agent saudável
      // pode legitimamente passar de 10min numa task — o que denuncia agent
      // morto/travado é ficar `limitMs` sem NENHUM evento (tool call/chunk).
      // Só o Goose emite trace; sem run aberto com eventos (Hermes, ou run já
      // fechado), o critério continua sendo a duração total acima.
      const activity = store.openRunActivity(issue.id);
      if (activity && now - activity.lastActivityAt <= limitMs) {
        log.scheduler.debug(
          { issueId: issue.id, state, idleMs: now - activity.lastActivityAt, totalMs: now - started, connectionId: ctx.connectionId },
          "reclaim skipped: run antigo mas com atividade recente (agent vivo)"
        );
        continue;
      }

      // Mata o processo do agent ANTES de reenfileirar. Sem isso, o processo
      // antigo (vivo porém lento) continuava trabalhando na issue em paralelo
      // com o novo dispatch — dois agents na mesma task, comentários/edições
      // duplicados e eventos "póstumos" gravados no run já fechado.
      if (activity) {
        const killed = agent.cancelRun(activity.runId);
        if (killed) log.scheduler.warn({ issueId: issue.id, runId: activity.runId, state, connectionId: ctx.connectionId }, "reclaim: processo do agent antigo encerrado");
      }

      await action(issue.id);
      await locks.clearStarted(ctx.connectionId, issue.id);
    } catch (e) {
      log.scheduler.error({ issueId: issue.id, state, connectionId: ctx.connectionId, ...errFields(e) }, "reclaim phase failed");
    }
  }
}

/**
 * Self-heal: Valkey footprint locks have no TTL (by design — Blocked may hold
 * them for days). Release is normally driven by the Completed webhook. When
 * that webhook is missed (or the issue left lock-holding states some other
 * way), Planned candidates stay blocked forever by "active lock" collisions.
 * Ask Linear for each lock holder's current state and drop orphans.
 */
async function reconcileStaleLocks(ctx: LinearContext): Promise<void> {
  const active = await locks.activeFootprints(ctx.connectionId);
  if (active.length === 0) return;

  const lin = linearFor(ctx);
  const holding = lockHoldingStates();
  let released = 0;

  for (const { issueId } of active) {
    try {
      const issue = await lin.getIssue(issueId);
      if (holding.has(issue.stateName)) continue;

      log.scheduler.warn(
        {
          issueId,
          identifier: issue.identifier,
          stateName: issue.stateName,
          connectionId: ctx.connectionId,
        },
        "stale footprint lock — issue left lock-holding states without release; releasing"
      );
      await locks.releaseLock(ctx.connectionId, issueId);
      await locks.clearFootprint(ctx.connectionId, issueId);
      await locks.clearAttempts(ctx.connectionId, issueId);
      await locks.clearStarted(ctx.connectionId, issueId);
      await locks.clearMergingIf(ctx.connectionId, issueId);
      released++;
    } catch (e) {
      if (isLinearRateLimitError(e)) throw e;
      // Network / transient errors must NOT release — only confirmed non-holding
      // states do. Log and keep the lock for the next tick.
      log.scheduler.warn(
        { issueId, connectionId: ctx.connectionId, ...errFields(e) },
        "stale lock check failed — keeping lock until next tick"
      );
    }
  }

  if (released > 0) {
    log.scheduler.info(
      { released, remaining: active.length - released, connectionId: ctx.connectionId },
      "stale footprint locks reconciled"
    );
  }
}

/**
 * Self-heal: issue workspaces under WORKSPACE_ROOT survive until Completed.
 * If the Completed webhook is missed (or the pipeline is tick-only), dirs for
 * issues that left workspace-holding states would leak disk forever.
 * Broader than lock reconcile — Planned/Refining keep workspaces without locks.
 */
async function reconcileStaleWorkspaces(ctx: LinearContext): Promise<void> {
  const issueIds = listIssueWorkspaceIssueIds(ctx.connectionId);
  if (issueIds.length === 0) return;

  const lin = linearFor(ctx);
  const holding = workspaceHoldingStates(S);
  const busy = agent.activeDispatchCwds();
  let removed = 0;

  for (const issueId of issueIds) {
    try {
      const cwd = issueWorkspaceCwd(issueId, ctx.connectionId);
      if (busy.has(cwd)) continue;

      const issue = await lin.getIssue(issueId);
      if (holding.has(issue.stateName)) continue;

      log.scheduler.warn(
        {
          issueId,
          identifier: issue.identifier,
          stateName: issue.stateName,
          connectionId: ctx.connectionId,
        },
        "stale issue workspace — issue left workspace-holding states; removing from disk"
      );
      removeIssueWorkspace(issueId, ctx.connectionId);
      removed++;
    } catch (e) {
      if (isLinearRateLimitError(e)) throw e;
      log.scheduler.warn(
        { issueId, connectionId: ctx.connectionId, ...errFields(e) },
        "stale workspace check failed — keeping directory until next tick"
      );
    }
  }

  if (removed > 0) {
    log.scheduler.info(
      { removed, remaining: issueIds.length - removed, connectionId: ctx.connectionId },
      "stale issue workspaces reconciled"
    );
  }
}

async function reconcileAgentLabels(ctx: LinearContext): Promise<void> {
  const lin = linearFor(ctx);
  const active = new Set<string>([S.refining, S.inProgress, S.inReview]);
  const tagged = await lin.listIssuesWithLabelPrefix(config.labels.agentPrefix);
  let removed = 0;

  for (const issue of tagged) {
    if (active.has(issue.stateName)) continue;
    for (const name of issue.matchingLabels) {
      await safeLabel(lin.removeLabel(issue.id, name), "removeLabel(orphan)", issue.id);
      removed++;
    }
  }

  if (removed > 0) {
    log.scheduler.info({ orphanLabelsRemoved: removed, connectionId: ctx.connectionId }, "orphan agent labels reconciled");
  }
}

// §8.1: notifica "budget estourado" no máximo 1x/hora por harness (evita spam
// a cada tick de 15s enquanto o budget continuar excedido).
const lastBudgetNotify = new Map<string, number>();
function checkBudgetBanners(): void {
  const now = Date.now();
  for (const banner of budgetBanners()) {
    const last = lastBudgetNotify.get(banner.harnessId) ?? 0;
    if (now - last < 3_600_000) continue;
    lastBudgetNotify.set(banner.harnessId, now);
    notify("budget_exceeded", { harnessId: banner.harnessId, spend: banner.spend, limit: banner.limit, window: banner.window, action: banner.action });
  }
}

function fire(p: Promise<unknown>, label: string, issueId: string): void {
  p.catch((e) =>
    log.scheduler.error({ issueId, operation: label, ...errFields(e) }, "agent dispatch failed")
  );
}
