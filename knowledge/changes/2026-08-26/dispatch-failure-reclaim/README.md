---
type: "Bugfix"
title: "Reopen occupied Linear seats on harness failure (not only on inactivity timeout)"
description: "ACP/Cursor failures left issues In Progress with no live agent. Dispatch catch reopens immediately; resource_exhausted is quota; tick abandoned-seat scan is the safety net. AppUser assign is skipped."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, scheduler, reliability, linear, acp, locks]
timestamp: "2026-08-26T00:00:00Z"
---

# Reopen occupied Linear seats on harness failure

## Issues / PRs

- No Linear issue: operator logs — seats stuck In Progress / In Review with zero live agents; Linear GraphQL `issue.assign` `"App user not valid"` / `"One or more app users lack the required scope."`; ACP `"Connection stalled"` and `"[resource_exhausted] Error"`; second process `"dispatch já em andamento"`.

## What changed & where

| Layer | Changed? | Notes |
| --- | --- | --- |
| API | No | — |
| CLI | No | — |
| Dashboard | No | — |
| Harness | **Yes** | `QUOTA_PATTERNS` includes Cursor `[resource_exhausted]` / `resource exhausted`. `Connection stalled` stays a generic failure (retry next tick, no cooldown). |
| Agent dispatch | **Yes** | `runDispatch` try/finally now wraps `buildRunEnv` → `run.result`. Catch reopens occupied Linear when **this** attempt owns the dispatch lease. `HarnessNotReadyError` (lease denied / pause / quota gate) does not reopen. |
| Scheduler | **Yes** | `reclaimAbandonedOccupied` after timeout reclaim: occupied + no open run + no live process + no dispatch lease + `startedAt` older than 60s → same reopen map. Skip assign when Linear `viewer.__typename !== User`. `assignIssue(..., { bestEffort: true })`. |
| Linear client | **Yes** | `viewer { __typename }`; GraphQL/HTTP errors with `bestEffort` log at **warn** and do not include `bestEffort` in Pino fields. |
| Locks | **Yes** | `hasDispatchLock` (`EXISTS` on the per-issue/role lease). Footprint `tryAcquireLock` **unchanged** when `IGNORE_FOOTPRINT_LOCKS` is on (duplicate-dispatch guard, not collision). |
| Shared reopen | **Yes** | New `app/src/occupied-reclaim.ts`; quota reaction calls `reopenOccupiedIssue`. |
| Config | No | — |
| SOULs / protocol | No | — |
| CI | No | — |
| Tests | **Yes** | `app/test/occupied-reclaim.test.ts` (policy matrix); `app/test/harness-quota.test.ts` (`resource_exhausted` vs `Connection stalled`). |

## FLOW (failure → seat free)

1. Scheduler moves Planned → **In Progress**, `markStarted`, `fire(dispatchWorker)` without awaiting.
2. `runDispatch` acquires the Valkey dispatch lease, runs the harness.
3. ACP fails (`Connection stalled`, crash, quota, …). SQLite run → `failed`. `finally` releases the lease.
4. **This change:** catch comments on Linear and moves to the retry state (**Reopened** from In Progress, **Code Review** from In Review, **To Do** from Refining). Quota also sets the harness cooldown.
5. Next tick: `fillWorkers` sees a free In Progress seat and the issue in Reopened (or the quota gate skips until reset).

### Abandoned-seat scan (already stuck)

If step 4 never ran (older binary, or throw before the old inner `try`), the next tick after **60s** of `startedAt` with no open run / process / lease runs the same reopen. Grace exists because `fire()` is not awaited: a tick can observe occupied Linear before `startRun`.

Does **not** reopen when the lease is held (second process's `HarnessNotReadyError` "already in progress" must not steal the live dispatch).

### Linear assign (noise, not the seat bug)

OAuth **AppUser** viewers cannot be assignees (`INPUT_ERROR` / missing scope). Skip assign when `__typename !== User`. Remaining assign failures stay best-effort (`warn` in `gql`, scheduler catch unchanged).

### `IGNORE_FOOTPRINT_LOCKS` vs "active locks"

The flag skips **collision** with other issues' footprints and the files-outside-footprint scope-check. It still calls `tryAcquireLock` (one exclusive lock per issue so two Dev runs cannot share a worktree) and still records the lock while the issue is in a lock-holding state (In Progress, Reopened, Code Review, In Review, Pending Merge, Blocked). Dashboard "Locks ativos" showing those keys is expected. Those locks do **not** pin seats; Linear occupied status does. This change does not skip lock acquire.

## Bugs found during manual validation

- Inspected `~/.yaoe-flow/data/dashboard.sqlite`: **zero** `running`/`dispatched` rows; failed runs matched the ACP log `runId`s. Valkey `orch:conn:…:dispatching:*` empty (lease released). `orch:conn:…:locks` still held the two In Progress issue ids — lock-holding states, not a leaked dispatch lease.
- `gql()` logged GraphQL assign failures at **error** before the scheduler's best-effort catch — looked like a blocking Linear outage. Downgraded when `bestEffort` is set.
- Inner `try` started only at `run.result`: `buildRunEnv` throw leaked the dispatch lease until 2h TTL.
- Dashboard **Stop** writes `cancelled` then kills the process; that kill rejects `run.result` and would have reopened Linear (fighting `manualStopRun` → Blocked). Catch now skips notify/reopen when the run is already `cancelled`.

## Deferred / follow-ups

- Issues **already** stuck stay occupied until this binary is installed **and** a tick passes the 60s grace (or the 45min inactivity timeout). This change does not mutate the operator's live Linear/Valkey by hand.
- Pending Merge abandonment still uses the merge-mutex timeout only (`markStarted` is not set on `drainMerge`).
- Quota comment body for the Claude-era Portuguese template was rewritten in English when `reactToHarnessQuotaError` was folded into `reopenOccupiedIssue`.
- Dispatch-lease TTL remains 2h (must outlast a long healthy run). A crash that leaves the lease without a process waits on inactivity timeout (45min) rather than the 60s abandoned scan, by design (`hasDispatchLock` is a live-dispatch signal).
