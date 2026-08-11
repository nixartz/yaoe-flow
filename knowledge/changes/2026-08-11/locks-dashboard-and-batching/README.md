---
type: "Feature Spec"
title: "Manual lock release, batched Linear seat queries, longer tick interval"
description: "Dashboard control to manually release a stuck footprint lock, one batched GraphQL request for the per-tick seat-count lists instead of up to eight, and a longer TICK_INTERVAL_MS default — all aimed at cutting Linear API call volume."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, dashboard, locks, linear, scheduler, rate-limit]
timestamp: "2026-08-11T00:00:00Z"
---

# Manual lock release, batched Linear seat queries, longer tick interval

## Issues / PRs

- Deferred items from [knowledge/changes/2026-08-07/stale-locks-and-linear-rate-limit](../../2026-08-07/stale-locks-and-linear-rate-limit/README.md): "broader reduction of Linear calls", "dashboard control to manually release a lock". No Linear issue — picked directly from `knowledge/product/roadmap.md` + that bundle's Deferred section at the user's request.

## What changed

### Dashboard: manual lock release

- New route file `app/src/api/dashboard/locks.ts` (+ `locks.schema.ts`), mounted in `app/src/api/dashboard/app.ts`:
  - `GET /api/locks` — active footprint locks per Linear connection, from `locks.activeFootprints(connectionId)` (Valkey, already existed).
  - `POST /api/locks/:connectionId/:issueId/release` — calls `locks.hasLock` + `locks.releaseLock`. Best-effort: tolerant of an already-released lock (`{ ok: true, warning? }`), never a hard failure. Does **not** touch Linear — the next tick's `reconcileStaleLocks()` stays the authoritative self-heal; this is an escape hatch for when a webhook was lost *and* that self-heal hasn't run yet (e.g. the issue is stuck in a holding state only a human can resolve).
- Dashboard: `dashboard/src/pages/Readiness.tsx` gained a "Locks ativos" card (only rendered when the selected connection has active locks) listing each locked issue's UUID + footprint entries, with a "Liberar" button behind the existing `ConfirmDialog` component (same confirm pattern as `Config.tsx`/`Agents.tsx`). `dashboard/src/lib/api.ts` gained `locksApi.list()` / `locksApi.release()` + `LockEntry`/`ConnectionLocks`/`LocksListResponse` types, mirroring the existing `readinessApi` pattern.

### Batched Linear seat-count queries

- `app/src/linear.ts`: new `listIssuesInStates(stateNames: string[]): Promise<Record<string, LinearIssue[]>>` on `LinearClient`. Builds **one** GraphQL request with aliased sub-queries (`s0: issues(filter: $filter0) {...}, s1: ...`) for whichever of the requested states aren't already warm in the per-tick `tickListCache`; the response is fanned back out per-state into that same cache (keyed `state:<name>`, identical to `listIssuesInState`'s own key), so any later `listIssuesInState`/`countInState` call for one of those states — from `fillRefiners`, `fillWorkers`, `fillReviewers`, `reclaimStale`, `pendingMergeIssues` — reads the already-resolved promise instead of issuing its own request.
- `app/src/scheduler.ts`: new `prefetchTickStates(lin)`, called right after `lin.beginTickCache()` at the top of each connection's tick. Warms `Refining`, `In Progress`, `Reopened`, `In Review`, `Code Review`, `Pending Merge` unconditionally (all read via plain `listIssuesInState`/`countInState` somewhere in the tick), plus `Todo`/`Planned` when `AUTO_DISPATCH_ISSUES=true` (otherwise those two queues are read through the differently-keyed, label-gated `listIssuesInStateWithLabel`, which this batch does not cover). Best-effort: a prefetch failure is logged at debug and swallowed — every caller still has its own individual fallback fetch, so the tick's actual reconciliation is never blocked by the warm-up.
- Net effect: a normal tick that used to make up to 8 separate `listByState` GraphQL round-trips for these lists now makes 1.

### Longer `TICK_INTERVAL_MS` default

- `app/src/config/registry.ts`: default raised `15000` → `30000`; `app/.env.example` and the two docs referencing "15s" (`docs/linear-setup.md`, `knowledge/product/architecture.md`) updated to match. Most transitions are still webhook-driven — this only slows the safety-net poll. Still hot-reloadable, still overridable via `TICK_INTERVAL_MS` for setups that rely on the tick itself (webhooks disabled/unreliable).

### What was explicitly NOT implemented

- **Per-field Redis TTL (`HEXPIRE`)** — the user's own request quoted this as *rejected*, not requested: Blocked locks must be able to outlive any short TTL, so this stays unimplemented, same as the prior bundle's Deferred note.

### Layers

| Layer | Changed? |
| --- | --- |
| API | Yes — `GET /api/locks`, `POST /api/locks/:connectionId/:issueId/release` |
| CLI | No |
| Dashboard | Yes — Readiness page "Locks ativos" card |
| Harness / Scheduler | Yes — `prefetchTickStates`, `TICK_INTERVAL_MS` default |
| Linear client | Yes — `listIssuesInStates` |
| CI / docs | Yes — `.env.example`, `linear-setup.md`, `architecture.md` |

## FLOW

**Manual release**: Prontidão page → connection with an active lock shows a "Locks ativos" card → operator clicks "Liberar" on an issue row → `ConfirmDialog` ("this does not touch Linear...") → confirm → `POST /api/locks/:connectionId/:issueId/release` → card refetches (`locks` + `readiness` query keys invalidated) → row disappears (or a "lock já não estava mais ativo" warning shows if it raced with the tick's own self-heal).

**Batched seats**: tick starts for a connection → `beginTickCache()` clears the per-tick memo → `prefetchTickStates` issues one aliased GraphQL request for the states the tick is about to need → `fillRefiners`/`fillWorkers`/`fillReviewers`/`reclaimStale`/`pendingMergeIssues` each call their usual `listIssuesInState`/`countInState`, all served from cache, zero additional requests for those states this tick.

## Validation

- `bun test` (230 pass, 0 fail) — added `app/test/linear-batching.test.ts` (4 tests: single batched request for N distinct states, cache-hit on a state already warmed by the batch, a second batch call only fetching the not-yet-cached states, `beginTickCache` resetting the warm-up between ticks) via a mocked `global.fetch`.
- `bun run typecheck` (app) — clean.
- `cd dashboard && bun run build` — clean (`tsc -b && vite build`).
- Direct-module check against real local Valkey (no HTTP): `acquireLock` → `hasLock`/`activeFootprints` → `releaseLock`, then a second release on the now-gone key, confirming the tolerant `{ ok: true, warning }` behavior the route relies on.
- Full manual UI pass: booted the daemon + dashboard against an isolated `YAOE_HOME` (no real Linear/GitHub credentials touched), created the first-access admin, seeded a fake Linear connection (`createConnection`, no real API-key validation involved) and a real Valkey lock for it, then drove the actual Prontidão page in-browser: "Locks ativos" card renders the issue + both footprint entries, "Liberar" opens the `ConfirmDialog`, confirming calls `POST /api/locks/:connectionId/:issueId/release` and the card empties out; verified directly in Valkey (`HGETALL orch:conn:<id>:locks`) that the hash field was actually gone, not just hidden client-side.
- **Bug found and fixed during that manual pass**: the Locks card was first wired inside the `{snap && (...)}` block, so it only rendered once a readiness snapshot existed — but locks are a Valkey-only read, independent of the tick, and the snapshot can be legitimately absent (`ORCHESTRATOR_ENABLED=false`, tick hasn't run yet, connection just added). That's exactly when the manual-release escape hatch matters most. Moved `<LocksPanel>` out from under the snapshot gate so it renders whenever a connection is selected, regardless of readiness state.

## Deferred

None carried forward from this bundle beyond the explicitly-rejected `HEXPIRE` note above.
