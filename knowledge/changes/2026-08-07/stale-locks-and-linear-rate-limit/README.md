---
type: "Feature Spec"
title: "Stale footprint locks + Linear rate-limit cooldown"
description: "Self-heal Valkey locks left behind after Completed (missed webhook), and respect Linear GraphQL rate-limit headers/errors so the tick stops thrashing the 5000 req/h budget."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, scheduler, locks, linear, rate-limit, readiness]
timestamp: "2026-08-07T00:00:00Z"
---

# Stale footprint locks + Linear rate-limit cooldown

## Issues / PRs

- (local) Operator report: Planned readiness candidates blocked by "active lock" collisions against **Completed** issues (INF-15, INF-16); reconciliation tick flooding Linear with `RATELIMITED` / 5000 req/h errors.

## What changed

### Harness / Scheduler / Linear client

- **`reconcileStaleLocks()`** runs at the start of each connection reconcile: for every Valkey footprint lock, fetches the issue state from Linear; if it is outside the lock-holding set (`In Progress`, `Code Review`, `In Review`, `Reopened`, `Pending Merge`, `Blocked`), releases lock + footprint cache + attempts/started/merge mutex. Root cause of zombies: locks have **no TTL** (Blocked may hold them for days) and release was webhook-only (`onStatusChange` → Completed); a missed webhook left locks forever and Planned never dispatched.
- **Linear rate-limit awareness** in `app/src/linear.ts`:
  - Tracks `X-RateLimit-Requests-Limit` / `Remaining` / `Reset` per API key.
  - Parses GraphQL `RATELIMITED` (HTTP 400 body) into `LinearRateLimitError` and enters cooldown until reset.
  - Tick skips a connection when cooldown is active or remaining budget `< 40` (estimated cost of one reconcile).
  - Readiness snapshot is also skipped while rate-limited (it alone is ~10 `listByState` calls).
- **Per-tick memoization** of `listIssuesInState` / `listIssuesInStateWithLabel` / `getIssue` so `fill*` + `reclaim` + `readiness` share the same lists within one connection reconcile.

### Layers

| Layer | Changed? |
| --- | --- |
| API | No |
| CLI | No |
| Dashboard | No (readiness already surfaced Completed holders) |
| Harness / Scheduler | Yes — stale lock reconcile + tick skip on rate limit |
| Linear client | Yes — headers, cooldown, tick cache |
| CI / docs | Yes — product architecture note, unit tests |

## FLOW

1. Issue merges → Linear `Completed`. If webhook is lost, Valkey still has `orch:conn:{id}:locks[issueId]`.
2. Next tick: `reconcileStaleLocks` sees `Completed` ∉ lock-holding → `HDEL` lock → Planned candidates with overlapping footprint become dispatchable.
3. When Linear returns `RATELIMITED` or `Remaining=0`, subsequent ticks for that API key log a warn and skip until `X-RateLimit-Requests-Reset` (instead of hammering every 15s).

## Deferred

- Broader reduction of Linear calls (single batched query for seat counts, longer `TICK_INTERVAL_MS` default).
- Per-field Redis TTL (`HEXPIRE`) as a secondary safety net — rejected for now because Blocked locks must outlive any short TTL.
- Dashboard control to manually release a lock.

## Validation notes

- Unit: `app/test/linear-rate-limit.test.ts`, `app/test/stale-locks.test.ts`.
- Manual: readiness showed INF-62/64/71/72 blocked by INF-15/INF-16 (Completed); after clearing zombie hash fields / deploying reconcile, collisions should clear on the next successful tick (once Linear budget recovers).
- Bugs found during validation: rate-limit thrash made readiness refresh fail every tick (`readiness snapshot failed`) — fixed by skipping readiness under cooldown.
