---
type: "Bug Fix"
title: "Exclusive dispatch per issue + stop must not Block live twins"
description: "Dedup Orchestrator estimate and Dev commit races (Valkey NX + open-run checks); manual stop skips Blocked when another run is live; revive failed runs that still emit events."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, scheduler, locks, dispatch, race, dashboard]
timestamp: "2026-08-08T00:00:00Z"
---

# Exclusive dispatch per issue + stop must not Block live twins

## Issues / PRs

- (local) Critical: moving to Planned spawned multiple Orchestrator estimate runs; Dev could start twice on the same issue/worktree. Stopping one run moved Linear to Blocked and marked the sibling run `failed` while its process kept writing history.

## Root cause

1. **Estimate is async outside the tick mutex** (`fire(estimateThenDispatch)`). Every subsequent tick/webhook while still Planned with no footprint re-fired another Orchestrator planning run.
2. **`acquireLock` was `HSET` (overwrite), not exclusive.** Two estimate completions could both pass collision checks and both `dispatchWorker`.
3. **`manualStopRun` always moved to Blocked.** `onStatusChange(Blocked)` closed the remaining open run as `failed` without killing its process.

## What changed

### Locks (`app/src/locks.ts`)

- `tryBeginEstimate` / `isEstimating` / `clearEstimating` — SET NX + TTL for planning exclusivity.
- `tryAcquireLock` — HSETNX for new implementation claims.

### Scheduler

- Skip Dev dispatch when an open Dev run or any in-memory active dispatch exists for the issue.
- Skip / reserve estimate only once; `estimateThenDispatch` clears the reservation in `finally`.
- `commitNewImplementation` uses `tryAcquireLock` + open-run guards.
- `manualStopRun` returns `{ movedToBlocked }`; skips Blocked when sibling runs are live.
- `onStatusChange(Blocked)` closes open runs except live process ids.

### Dispatch / store / stop API

- `activeRuns` tracks `issueId`; `hasActiveDispatchForIssue` / `listActiveRunIdsForIssue`.
- `reviveRunIfStillActive` on harness events (`failed`/`timeout` → `running`; never `cancelled`).
- `listOpenRuns` / `closeOpenRuns({ exceptRunIds })`.
- `/runs/:id/stop` passes `exceptRunId` and warns when Blocked was skipped.

### Layers

| Layer | Changed? |
| --- | --- |
| API | Yes — stop warning when siblings live |
| CLI | No |
| Dashboard | No (consumes existing SSE `run_updated`) |
| Harness / Scheduler | Yes |
| Docs | CHANGELOG + this OKF |

## Deferred

- Multi-process / multi-replica exclusivity (in-memory `activeRuns` is single-instance by design).
- Closing orphan DB `running` rows for dead processes without a Linear transition.

## Bugs found in validation

- (unit) Confirmed revive must not restore `cancelled` — intentional stop of *this* run stays cancelled.
