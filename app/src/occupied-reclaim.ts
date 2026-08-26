// Shared reopen of an occupied Linear seat after the harness is gone.
//
// Quota handling (agent/harness/quota.ts) already did this for provider
// account limits. Generic ACP failures (Connection stalled, unclassified
// crashes after startRun) used to only mark the SQLite run `failed` and
// release the Valkey dispatch lease — Linear stayed In Progress / In Review
// until IN_PROGRESS_TIMEOUT_MS (default 45min), occupying a seat with no
// live agent. Cursor `[resource_exhausted]` is classified as quota.
import { config } from "./config";
import { log } from "./logger";
import * as locks from "./locks";
import { linearFor } from "./linear";
import type { LinearContext } from "./db/linearConnections";
import type { SchedulerRole } from "./agent/recipe/defaults";

/**
 * After moveState the scheduler `fire()`s dispatch without awaiting. A tick
 * can land in this window with Linear already occupied and no run row yet.
 * Do not treat that as abandoned. 60s is well above GitHub App token mint +
 * lock acquire; the inactivity timeout remains the backstop for a live agent.
 */
export const ABANDONED_DISPATCH_GRACE_MS = 60_000;

/** Same destinations as reclaimStale() — keep the footprint lock (Reopened / Code Review are lock-holding). */
export function occupiedReopenTarget(stateName: string): string | null {
  const S = config.states;
  if (stateName === S.refining) return S.todo;
  if (stateName === S.inProgress) return S.reopened;
  if (stateName === S.inReview) return S.codeReview;
  if (stateName === S.pendingMerge) return S.reopened;
  return null;
}

export function roleForOccupiedState(stateName: string): SchedulerRole | null {
  const S = config.states;
  if (stateName === S.refining) return "pmo";
  if (stateName === S.inProgress) return "dev";
  if (stateName === S.inReview) return "reviewer";
  if (stateName === S.pendingMerge) return "orchestrator";
  return null;
}

export function shouldReclaimAbandonedDispatch(opts: {
  hasOpenRun: boolean;
  hasActiveProcess: boolean;
  hasDispatchLock: boolean;
  startedAt: number | null;
  now: number;
  graceMs?: number;
}): boolean {
  if (opts.hasOpenRun || opts.hasActiveProcess || opts.hasDispatchLock) return false;
  if (opts.startedAt === null) return false;
  const grace = opts.graceMs ?? ABANDONED_DISPATCH_GRACE_MS;
  return opts.now - opts.startedAt > grace;
}

function svcHeader(phase: string): string {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `🤖 **Orchestrator** · \`yaoe-flow\` · ${now} UTC · ${phase}`;
}

/**
 * Comment + move to the retry state. Returns the target, or null if the issue
 * is not in an occupied phase (caller still posted the comment).
 */
export async function reopenOccupiedIssue(
  ctx: LinearContext,
  issueId: string,
  comment: string
): Promise<string | null> {
  const lin = linearFor(ctx);
  const issue = await lin.getIssue(issueId);
  const target = occupiedReopenTarget(issue.stateName);
  await lin.comment(issueId, comment);
  if (!target) return null;

  log.agent.info(
    { issueId, from: issue.stateName, to: target, connectionId: ctx.connectionId },
    "moving issue state (occupied-seat reclaim)"
  );
  await lin.setState(issueId, target);
  if (issue.stateName === config.states.pendingMerge) {
    await locks.clearMergingIf(ctx.connectionId, issueId);
  }
  await locks.clearStarted(ctx.connectionId, issueId);
  return target;
}

export function dispatchFailureComment(harnessId: string, error: string): string {
  return (
    `${svcHeader("Reliability")}\n\n` +
    `⚠️ The harness "${harnessId}" failed before finishing this turn:\n\n> ${error}\n\n` +
    `Returning the issue to the retry queue so the seat is not held with no live agent. ` +
    `The footprint lock is kept (same branch on the next attempt).`
  );
}

export function abandonedDispatchComment(): string {
  return (
    `${svcHeader("Reliability")}\n\n` +
    `⚠️ Occupied Linear status with no live harness process, no open run, and no dispatch lease ` +
    `(grace ${ABANDONED_DISPATCH_GRACE_MS / 1000}s). Returning the issue to the retry queue so seats are not pinned.`
  );
}
