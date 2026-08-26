---
type: concept
title: "Harness failure must free the Linear occupied seat immediately"
description: "SQLite failed + Valkey dispatch lease released is not enough — fillWorkers counts In Progress / In Review / Refining. Reopen on catch; 60s abandoned scan is the net. Do not steal a live lease."
tags: [scheduler, reliability, linear, acp, seats]
---

# Harness failure must free the Linear occupied seat immediately

Linear occupied statuses (**In Progress**, **In Review**, **Refining**) **are** the worker seats. `fillWorkers` / `fillReviewers` / `fillRefiners` count `countInState` of those statuses. The dashboard run row and the Valkey dispatch lease (`orch:conn:<id>:dispatching:<role>:<issueId>`) are observability + exclusivity, not capacity.

A harness error that only calls `finishRun(failed)` and `releaseDispatchLock` therefore leaves the pipeline **full with nobody working**. The inactivity reclaim (`IN_PROGRESS_TIMEOUT_MS`, default 45min) was the only path back. Quota handling already reopened on `"You've hit your limit"`; generic ACP errors (`Connection stalled`) and Cursor `[resource_exhausted]` (now quota) did not.

Shared reopen map (`occupiedReopenTarget`, same as timeout reclaim):

| From | To | Why the footprint lock stays |
| --- | --- | --- |
| Refining | To Do | no lock yet |
| In Progress | Reopened | lock-holding — next Dev reuses the branch |
| In Review | Code Review | lock-holding |
| Pending Merge | Reopened | lock-holding; also clear merge mutex |

**When to reopen (dispatch catch):** this attempt holds `dispatchLockToken`, `kind === "dispatch"`, not `HarnessNotReadyError`. Twin "already in progress" denials must not move Linear out from under the process that still holds the lease.

**When to reopen (tick):** `shouldReclaimAbandonedDispatch` — no open run, no in-memory process, no dispatch lease, `startedAt` older than 60s. The grace covers `fire()` without await (Linear already occupied, `startRun` not yet). Missing `startedAt` is not abandonment (`reclaimPhase` will mark it).

**Not a seat leak:** `IGNORE_FOOTPRINT_LOCKS` still `tryAcquireLock`s. That hash is the per-issue exclusive lock (duplicate Dev), not the cross-issue collision the flag skips. Active lock keys for Reopened/In Progress issues are expected.

Related: `knowledge/rules/secrets-and-best-effort-writes.md` (self-healing rule), `app/src/occupied-reclaim.ts`.
