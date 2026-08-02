// Snapshot de prontidão: avalia candidatas Linear + locks Valkey SEM side-effects
// (não move status, não comenta, não adquire lock). Rodado no fim de cada
// reconciliação de connection no tick — a dashboard lê o cache, não o Linear.
import { config } from "../config";
import { log, errFields } from "../logger";
import { linearFor } from "../linear";
import type { LinearContext } from "../db/linearConnections";
import { getConnection } from "../db/linearConnections";
import * as locks from "../locks";
import * as github from "../github";
import { collidingEntryPairs, footprintsCollide } from "../dag";
import { isActiveHarnessPausedForRole } from "../agent/harness/budget";
import type { LinearIssue } from "../types";
import type {
  ReadinessCollision,
  ReadinessDep,
  ReadinessIssue,
  ReadinessPhase,
  ReadinessReason,
  ReadinessReasonCode,
  ReadinessSnapshot,
} from "./types";
import { deriveStatus, pickBlockedComment, statusRank } from "./status";

const S = config.states;

function seat(occupied: number, max: number) {
  return { occupied, max, free: Math.max(0, max - occupied) };
}

function reason(code: ReadinessReasonCode, detail: string, extra?: Partial<ReadinessReason>): ReadinessReason {
  return { code, detail, ...extra };
}

function idSet(issues: LinearIssue[]): Set<string> {
  return new Set(issues.map((i) => i.id));
}

async function findPrReadOnly(
  lin: ReturnType<typeof linearFor>,
  issueId: string
): Promise<github.PrRef | null> {
  for (const url of await lin.getAttachmentUrls(issueId)) {
    const pr = github.parsePrUrl(url);
    if (pr) return pr;
  }
  for (const body of await lin.listCommentBodies(issueId)) {
    const pr = github.parsePrUrl(body);
    if (pr) return pr;
  }
  return null;
}

async function unresolvedDeps(
  lin: ReturnType<typeof linearFor>,
  issueId: string
): Promise<ReadinessDep[]> {
  const issue = await lin.getIssue(issueId);
  const out: ReadinessDep[] = [];
  for (const depId of issue.blockedBy) {
    try {
      const dep = await lin.getIssue(depId);
      if (dep.stateName !== S.completed) {
        out.push({ issueId: dep.id, identifier: dep.identifier, stateName: dep.stateName });
      }
    } catch (e) {
      log.scheduler.debug({ issueId, depId, ...errFields(e) }, "readiness: falha ao ler dep");
      out.push({ issueId: depId, identifier: depId, stateName: "?" });
    }
  }
  return out;
}

async function resolveIssueLabel(
  lin: ReturnType<typeof linearFor>,
  issueId: string
): Promise<{ identifier: string; stateName: string | null }> {
  try {
    const issue = await lin.getIssue(issueId);
    return { identifier: issue.identifier, stateName: issue.stateName };
  } catch (e) {
    log.scheduler.debug({ issueId, ...errFields(e) }, "readiness: falha ao resolver identifier");
    return { identifier: issueId, stateName: null };
  }
}

async function buildCollisions(
  lin: ReturnType<typeof linearFor>,
  footprint: string[],
  active: { issueId: string; footprint: string[] }[]
): Promise<ReadinessCollision[]> {
  const out: ReadinessCollision[] = [];
  for (const a of active) {
    if (!footprintsCollide(footprint, a.footprint)) continue;
    const pairs = collidingEntryPairs(footprint, a.footprint);
    const meta = await resolveIssueLabel(lin, a.issueId);
    out.push({
      issueId: a.issueId,
      identifier: meta.identifier,
      stateName: meta.stateName,
      overlappingEntries: pairs,
    });
  }
  return out;
}

export async function buildReadinessSnapshot(ctx: LinearContext): Promise<ReadinessSnapshot> {
  const lin = linearFor(ctx);
  const row = getConnection(ctx.connectionId);
  const organizationKey = row?.organizationKey ?? null;

  const [
    refiningCount,
    inProgressCount,
    inReviewCount,
    todoAll,
    plannedAll,
    reopened,
    codeReview,
    pendingAll,
    blocked,
  ] = await Promise.all([
    lin.countInState(S.refining),
    lin.countInState(S.inProgress),
    lin.countInState(S.inReview),
    lin.listIssuesInState(S.todo),
    lin.listIssuesInState(S.planned),
    lin.listIssuesInState(S.reopened),
    lin.listIssuesInState(S.codeReview),
    lin.listIssuesInState(S.pendingMerge),
    lin.listIssuesInState(S.blocked),
  ]);

  // Conjuntos com a label de gate — pra marcar missing_label sem N getIssueLabels.
  let todoLabeled = new Set<string>();
  let plannedLabeled = new Set<string>();
  let pendingLabeled = new Set<string>();
  if (!config.autoDispatchIssues) {
    const [t, p] = await Promise.all([
      lin.listIssuesInStateWithLabel(S.todo, config.labels.readyToRefine),
      lin.listIssuesInStateWithLabel(S.planned, config.labels.readyToImplement),
    ]);
    todoLabeled = idSet(t);
    plannedLabeled = idSet(p);
  } else {
    todoLabeled = idSet(todoAll);
    plannedLabeled = idSet(plannedAll);
  }
  if (!config.autoMergeIssues) {
    pendingLabeled = idSet(await lin.listIssuesInStateWithLabel(S.pendingMerge, config.labels.readyToMerge));
  } else {
    pendingLabeled = idSet(pendingAll);
  }

  const active = await locks.activeFootprints(ctx.connectionId);
  const mergingIssueId = await locks.mergingIssue(ctx.connectionId);
  const mergeBusy = mergingIssueId !== null;

  const capacity = {
    refine: seat(refiningCount, config.capacity.maxPmoWorkers),
    implement: seat(inProgressCount, config.capacity.maxDevWorkers),
    review: seat(inReviewCount, config.capacity.maxReviewerWorkers),
    merge: {
      max: config.capacity.maxOrchestratorWorkers,
      busy: mergeBusy,
      mergingIssueId,
    },
  };

  const issues: ReadinessIssue[] = [];

  // ── Refine (To Do) ──
  {
    const budgetPaused = isActiveHarnessPausedForRole("pmo");
    for (const issue of todoAll) {
      const reasons: ReadinessReason[] = [];
      if (budgetPaused) {
        reasons.push(reason("budget_paused", "Harness do PMO pausado por budget — issue não é movida."));
      }
      if (!config.autoDispatchIssues && !todoLabeled.has(issue.id)) {
        reasons.push(
          reason("missing_label", `Falta a label de curadoria \`${config.labels.readyToRefine}\`.`, {
            label: config.labels.readyToRefine,
          })
        );
      }
      if (capacity.refine.free <= 0) {
        reasons.push(
          reason("no_capacity", `Sem seats de PMO livres (${capacity.refine.occupied}/${capacity.refine.max} em ${S.refining}).`)
        );
      }
      if (reasons.length === 0) {
        reasons.push(reason("ready", "Pronta para refino no próximo tick com seat livre."));
      }
      issues.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        stateName: issue.stateName,
        phase: "refine",
        status: deriveStatus(reasons),
        reasons,
        tier: null,
        attempts: 0,
        maxAttempts: config.reliability.maxAttempts,
        hasFootprint: false,
        hasLock: false,
        blockedComment: null,
      });
    }
  }

  // ── Implement (Reopened → Planned) ──
  {
    const budgetPaused = isActiveHarnessPausedForRole("dev");
    const evaluateImpl = async (issue: LinearIssue, tier: "reopened" | "planned") => {
      const reasons: ReadinessReason[] = [];
      const hasLock = await locks.hasLock(ctx.connectionId, issue.id);
      const attempts = await locks.getAttempts(ctx.connectionId, issue.id);
      const footprint = await locks.getFootprint(ctx.connectionId, issue.id);
      const hasFootprint = footprint !== null && footprint.length > 0;

      if (budgetPaused) {
        reasons.push(reason("budget_paused", "Harness do Dev pausado por budget — issue não é movida."));
      }

      if (tier === "planned" && !config.autoDispatchIssues && !plannedLabeled.has(issue.id)) {
        reasons.push(
          reason("missing_label", `Falta a label de curadoria \`${config.labels.readyToImplement}\`.`, {
            label: config.labels.readyToImplement,
          })
        );
      }

      if (hasLock && tier === "reopened") {
        if (attempts >= config.reliability.maxAttempts) {
          reasons.push(
            reason(
              "circuit_breaker",
              `Circuit breaker: ${attempts}/${config.reliability.maxAttempts} tentativas — no próximo pick a issue iria para Blocked.`,
              { attempts, maxAttempts: config.reliability.maxAttempts }
            )
          );
        }
      } else if (hasLock && tier !== "reopened" && tier !== "planned") {
        // planned+lock órfão é liberado no pick — não reportamos como bloqueio duro
      } else if (hasLock && tier === "planned") {
        // Orphan lock: tick libera; tratamos como não-bloqueante.
      }

      // Deps / footprint só no caminho “nova implementação” (sem lock) ou Planned.
      // Reopened com lock usa fix path — deps já foram satisfeitas antes.
      if (!hasLock || tier === "planned") {
        try {
          const deps = await unresolvedDeps(lin, issue.id);
          if (deps.length > 0) {
            reasons.push(
              reason(
                "deps_unsatisfied",
                `Dependências Linear não concluídas: ${deps.map((d) => `${d.identifier} (${d.stateName})`).join(", ")}.`,
                { deps }
              )
            );
          }
        } catch (e) {
          log.scheduler.debug({ issueId: issue.id, ...errFields(e) }, "readiness: deps check failed");
        }

        if (!hasFootprint) {
          reasons.push(
            reason("estimating_footprint", "Footprint ainda não estimado — o próximo tick dispara o planning async.")
          );
        } else if (footprint) {
          const collisions = await buildCollisions(
            lin,
            footprint,
            active.filter((a) => a.issueId !== issue.id)
          );
          if (collisions.length > 0) {
            const labels = collisions
              .map((c) => {
                const entries = c.overlappingEntries
                  .slice(0, 4)
                  .map((p) => `\`${p.ours}\` ∩ \`${p.theirs}\``)
                  .join("; ");
                const more =
                  c.overlappingEntries.length > 4
                    ? ` (+${c.overlappingEntries.length - 4} pares)`
                    : "";
                return `${c.identifier}${c.stateName ? ` (${c.stateName})` : ""}${entries ? `: ${entries}${more}` : ""}`;
              })
              .join(" · ");
            reasons.push(
              reason(
                "footprint_collision",
                `Footprint colide com issue(s) que ainda têm lock ativo: ${labels}.`,
                {
                  collisions,
                  collidingIssueIds: collisions.map((c) => c.issueId),
                }
              )
            );
          }
        }
      }

      if (capacity.implement.free <= 0) {
        reasons.push(
          reason(
            "no_capacity",
            `Sem seats de Dev livres (${capacity.implement.occupied}/${capacity.implement.max} em ${S.inProgress}).`
          )
        );
      }

      if (reasons.length === 0) {
        reasons.push(
          reason(
            "ready",
            tier === "reopened"
              ? "Pronta para correção (Reopened) no próximo tick com seat livre."
              : "Pronta para implementação no próximo tick com seat livre."
          )
        );
      }

      issues.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        stateName: issue.stateName,
        phase: "implement",
        status: deriveStatus(reasons),
        reasons,
        tier,
        attempts,
        maxAttempts: config.reliability.maxAttempts,
        hasFootprint,
        hasLock,
        blockedComment: null,
      });
    };

    for (const issue of reopened) await evaluateImpl(issue, "reopened");
    for (const issue of plannedAll) await evaluateImpl(issue, "planned");
  }

  // ── Review (Code Review) ──
  {
    const budgetPaused = isActiveHarnessPausedForRole("reviewer");
    const authorizedOrgs = config.security.authorizedOrgs;
    for (const issue of codeReview) {
      const reasons: ReadinessReason[] = [];
      if (budgetPaused) {
        reasons.push(reason("budget_paused", "Harness do Reviewer pausado por budget — issue não é movida."));
      }
      try {
        const pr = await findPrReadOnly(lin, issue.id);
        if (!pr) {
          reasons.push(
            reason("missing_pr", "PR não encontrada nos attachments nem nos comentários — o scope-check devolveria para Reopened.")
          );
        } else if (authorizedOrgs.length > 0 && !authorizedOrgs.includes(pr.owner.toLowerCase())) {
          reasons.push(
            reason(
              "unauthorized_repo",
              `PR em \`${pr.owner}/${pr.repo}\` fora de AGENT_AUTHORIZED_ORGS — iria para Blocked.`,
              { prOwner: pr.owner }
            )
          );
        }
      } catch (e) {
        log.scheduler.debug({ issueId: issue.id, ...errFields(e) }, "readiness: PR lookup failed");
      }
      if (capacity.review.free <= 0) {
        reasons.push(
          reason(
            "no_capacity",
            `Sem seats de Reviewer livres (${capacity.review.occupied}/${capacity.review.max} em ${S.inReview}).`
          )
        );
      }
      if (reasons.length === 0) {
        reasons.push(reason("ready", "Pronta para review no próximo tick com seat livre."));
      }
      const fp = await locks.getFootprint(ctx.connectionId, issue.id);
      issues.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        stateName: issue.stateName,
        phase: "review",
        status: deriveStatus(reasons),
        reasons,
        tier: null,
        attempts: await locks.getAttempts(ctx.connectionId, issue.id),
        maxAttempts: config.reliability.maxAttempts,
        hasFootprint: fp !== null && fp.length > 0,
        hasLock: await locks.hasLock(ctx.connectionId, issue.id),
        blockedComment: null,
      });
    }
  }

  // ── Merge (Pending Merge) ──
  {
    const budgetPaused = isActiveHarnessPausedForRole("orchestrator");
    for (const issue of pendingAll) {
      const reasons: ReadinessReason[] = [];
      if (config.capacity.maxOrchestratorWorkers <= 0) {
        reasons.push(
          reason("orchestrator_workers_disabled", "MAX_ORCHESTRATOR_WORKERS=0 — merges automáticos desligados.")
        );
      }
      if (budgetPaused) {
        reasons.push(reason("budget_paused", "Harness do Orchestrator pausado por budget — merge não dispara."));
      }
      if (!config.autoMergeIssues && !pendingLabeled.has(issue.id)) {
        reasons.push(
          reason("missing_label", `Falta a label de curadoria \`${config.labels.readyToMerge}\`.`, {
            label: config.labels.readyToMerge,
          })
        );
      }
      if (mergeBusy) {
        let mergingIssueIdentifier: string | null = null;
        if (mergingIssueId) {
          mergingIssueIdentifier = (await resolveIssueLabel(lin, mergingIssueId)).identifier;
        }
        reasons.push(
          reason(
            "merge_mutex_held",
            mergingIssueIdentifier
              ? `Outro merge em andamento: ${mergingIssueIdentifier} (mutex serial — uma issue por vez).`
              : "Outro merge em andamento (mutex serial — uma issue por vez).",
            { mergingIssueId, mergingIssueIdentifier }
          )
        );
      }
      if (reasons.length === 0) {
        reasons.push(reason("ready", "Pronta para merge (fila serial — uma por vez)."));
      }
      issues.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        stateName: issue.stateName,
        phase: "merge",
        status: deriveStatus(reasons),
        reasons,
        tier: null,
        attempts: 0,
        maxAttempts: config.reliability.maxAttempts,
        hasFootprint: (await locks.getFootprint(ctx.connectionId, issue.id)) !== null,
        hasLock: await locks.hasLock(ctx.connectionId, issue.id),
        blockedComment: null,
      });
    }
  }

  // ── Blocked (aguarda humano) ──
  for (const issue of blocked) {
    let blockedComment: string | null = null;
    try {
      const bodies = await lin.listCommentBodies(issue.id);
      blockedComment = pickBlockedComment(bodies);
    } catch (e) {
      log.scheduler.debug({ issueId: issue.id, ...errFields(e) }, "readiness: comment fetch failed");
    }
    const reasons: ReadinessReason[] = [
      reason(
        "waiting_human",
        blockedComment
          ? "Em Blocked — aguarda ação humana no Linear (ver comentário)."
          : "Em Blocked — o orquestrador não puxa este estado; mova para Reopened ou To Do para retomar."
      ),
    ];
    issues.push({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      stateName: issue.stateName,
      phase: "blocked",
      status: "waiting_human",
      reasons,
      tier: null,
      attempts: await locks.getAttempts(ctx.connectionId, issue.id),
      maxAttempts: config.reliability.maxAttempts,
      hasFootprint: (await locks.getFootprint(ctx.connectionId, issue.id)) !== null,
      hasLock: await locks.hasLock(ctx.connectionId, issue.id),
      blockedComment,
    });
  }

  // Ordenação estável: fase → status (travadas primeiro) → Reopened antes de Planned → identifier.
  const phaseOrder: Record<ReadinessPhase, number> = {
    refine: 0,
    implement: 1,
    review: 2,
    merge: 3,
    blocked: 4,
  };
  issues.sort((a, b) => {
    const ph = phaseOrder[a.phase] - phaseOrder[b.phase];
    if (ph !== 0) return ph;
    const st = statusRank(a.status) - statusRank(b.status);
    if (st !== 0) return st;
    if (a.tier === "reopened" && b.tier !== "reopened") return -1;
    if (b.tier === "reopened" && a.tier !== "reopened") return 1;
    return a.identifier.localeCompare(b.identifier);
  });

  return {
    updatedAt: Date.now(),
    connectionId: ctx.connectionId,
    connectionName: ctx.name,
    organizationId: ctx.organizationId,
    organizationKey,
    capacity,
    flags: {
      autoDispatchIssues: config.autoDispatchIssues,
      autoMergeIssues: config.autoMergeIssues,
      orchestratorEnabled: config.orchestratorEnabled,
    },
    issues,
  };
}
