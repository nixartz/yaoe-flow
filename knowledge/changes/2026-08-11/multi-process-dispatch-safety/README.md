---
type: "Feature Spec"
title: "Cross-process dispatch exclusivity + orphan run cleanup"
description: "Redis-backed per-issue dispatch lease and a boot-time daemon instance lock close the two gaps flagged as deferred in exclusive-dispatch-and-stop-siblings: activeRuns is single-instance in-memory, and a killed process leaves 'running' rows behind forever."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, scheduler, locks, dispatch, valkey, boot, dashboard-store]
timestamp: "2026-08-11T00:00:00Z"
---

# Cross-process dispatch exclusivity + orphan run cleanup

## Issues / PRs

- Deferred items from [knowledge/changes/2026-08-08/exclusive-dispatch-and-stop-siblings](../../2026-08-08/exclusive-dispatch-and-stop-siblings/README.md): "Multi-process / multi-replica exclusivity (in-memory `activeRuns` is single-instance by design)" and "Closing orphan DB `running` rows for dead processes without a Linear transition". No Linear issue — picked directly from that bundle's Deferred section at the user's request.

## Problem

`app/src/agent/dispatch.ts`'s `activeRuns` map is process-local by construction: it exists to let the dashboard `kill()` a live harness process, which is inherently impossible across processes without IPC. But the *dispatch exclusivity* the map incidentally provided (via `hasActiveDispatchForIssue`) was **also** only process-local — two daemon processes pointed at the same `YAOE_HOME` + Valkey (an operator running `yaoe-flow daemon` twice by mistake, or a supervisor restart racing an old process that hasn't exited) could both dispatch the same issue+role at once. Separately, if a process died (`kill -9`, OOM) mid-run, its `runs` rows stayed `status='running'` in SQLite forever — nothing was watching for that on the next boot.

## What changed

### Cross-process per-issue dispatch lease (`app/src/locks.ts`, `app/src/agent/dispatch.ts`)

- New `tryAcquireDispatchLock(connectionId, issueId, role)` / `releaseDispatchLock(connectionId, issueId, role, token)` — `SET orch:conn:{id}:dispatching:{role}:{issueId} <token> EX 7200 NX`, mirroring the existing `tryBeginEstimate` NX+EX pattern (`locks.ts:73-82`). Returns an opaque per-acquisition token; release is a Lua compare-and-delete (only removes the key if it still holds *this* token), so a lease that already expired and was re-claimed by a different process can never be released out from under the new owner.
- `runDispatch` (`dispatch.ts`) acquires this lease **before** any DB row is created or network call is made (before `buildRunEnv`/`store.startRun`/`adapter.createRun`) whenever `opts.issueId` is set — in addition to, not instead of, the existing footprint lock (this is a narrower, dispatch-specific guard). Denial throws `HarnessNotReadyError`, which the scheduler already treats as "seat stays occupied, retry next tick" (same path as the harness-budget-paused case a few lines above). Released in the existing `finally` block alongside `activeRuns.delete(runId)`.
- 2h TTL is a crash-only safety net (normal path always releases in `finally`): must comfortably outlast the longest legitimate run. `IN_PROGRESS_TIMEOUT_MS` (45min default) is an *inactivity* clock that resets on every harness event, so a long but active run can exceed it — 2h errs on the side of never stealing a live run's lease.
- `activeRuns`'s doc comment updated: it stays single-instance for cancel/kill (genuinely impossible without IPC, out of scope), but dispatch exclusivity itself no longer depends on it.

### Boot-time daemon instance lock (`app/src/locks.ts`, `app/src/server.ts`)

- New `acquireDaemonInstanceLock(leaseMs)` / `renewDaemonInstanceLock(leaseMs)` — global (not connection-scoped) `orch:daemon:lock` key, `SET <token> PX <leaseMs> NX`; renewal is the same CAS pattern as the dispatch lease (Lua `GET==token → PEXPIRE`, else no-op).
- `bootServer()` acquires it right after opening the app DB, before anything else. Lease = `max(tickIntervalMs * 3, 60s)`, computed fresh on every renewal so it tracks a hot-reloaded `TICK_INTERVAL_MS`. Renewed once per scheduler tick (`server.ts`'s `runScheduledTick`, right before calling `tick()`).
- **Not a hard crash on denial**: if another live process already holds the lock, `bootServer()` logs a loud warning and boots the API/dashboard normally — only `runScheduledTick` additionally checks `instanceLockOwned` before calling `tick()`, so dispatch/reconciliation stay off on the losing instance until it's restarted (matches the existing `ORCHESTRATOR_ENABLED=false` philosophy: config/API stays reachable, only the pipeline itself pauses).
- **Fail-open on a Valkey error** (not a denial): if the acquire/renew call itself throws (Valkey unreachable), the instance proceeds as if it owns the lock — everything else in this daemon already depends on Valkey being reachable, so refusing to tick because of a transient connectivity blip would be a regression, not a safety improvement, and it wouldn't survive being permanent (no retry-later path). A denial (Valkey *responded* naming another owner) is a hard signal; an error (Valkey unreachable) is not.
- If the lock is lost mid-run (a renewal explicitly returns "not owner" — this instance missed enough renewals for the lease to lapse and a different process grabbed it), the instance permanently stops ticking and logs at `error` level; recovery requires a restart. Rare edge case (would need a Valkey outage longer than the lease), not worth an automatic re-acquire loop.

### Orphan `running` row cleanup (`app/src/dashboard/store.ts`, `app/src/server.ts`)

- New `store.closeOrphanRunningRows(): { closed: number }` — `UPDATE runs SET status='failed', error_message=COALESCE(error_message, 'orphaned: process restarted while run was in flight'), ended_at=?, duration_ms=? WHERE status='running'`. Deliberately **no Linear transition** — matches the deferred item's exact wording and `AGENTS.md` ("Linear is the source of truth ... local state is observability, not authority"). `reconcileStaleLocks()` already self-heals the Linear/Valkey side independently on the next tick if the issue actually left a lock-holding state.
- Called from `bootServer()` **only when the instance lock was actually acquired** (not on denial, not on a Valkey error) — a `running` row left by a genuinely different, still-live process (the one holding the instance lock) must not be reclassified as an orphan out from under it. Exclusivity has to be *confirmed*, not assumed, before this runs.

### `bootServer` becomes async

- Acquiring the instance lock and closing orphan rows both need to happen before the scheduler starts ticking, so `bootServer(): void` became `bootServer(): Promise<void>`. Both call sites (`app/src/index.ts`, `app/src/cli/daemon.ts`) already used `await import(...)` to load the module — added `await` in front of the call itself, no other changes.

### Layers

| Layer | Changed? |
| --- | --- |
| API | No |
| CLI | No (daemon boot sequence only) |
| Dashboard | No |
| Scheduler / boot | Yes — instance lock acquire + renew, orphan cleanup at boot |
| Locks (Valkey) | Yes — dispatch lease, daemon instance lock |
| Dispatch | Yes — `runDispatch` acquires/releases the dispatch lease |

## FLOW

**Cross-process dispatch collision** (two daemons, same `YAOE_HOME` + Valkey): both reconcile the same Planned issue → both call `runDispatch({ issueId, role: "dev", ... })` → one wins `tryAcquireDispatchLock` (Redis `SET NX`), proceeds to spawn the harness → the other gets `null`, throws `HarnessNotReadyError`, scheduler treats it as "seat still occupied, try again next tick" — no duplicate harness process, no duplicate `runs` row.

**Two daemons, one `YAOE_HOME`**: instance A boots first, acquires `orch:daemon:lock`, ticks normally, renews the lease every tick. Instance B boots against the same Valkey, `SET NX` fails (A already holds it) → B logs a loud warning, keeps API/dashboard up, never calls `tick()`. If A dies, its lease lapses (no more renewals) and after `~3× TICK_INTERVAL_MS` a subsequent boot (or, if B were still polling — it isn't, in this design; recovery requires restarting B) can acquire it.

**Orphan cleanup**: process A is `kill -9`'d while a `runs` row for issue X sits `status='running'`. On the next `yaoe-flow daemon` boot (same `YAOE_HOME`), the new process acquires the (now-free) instance lock, confirms sole ownership, and `closeOrphanRunningRows()` flips that row to `failed` with `error_message='orphaned: process restarted while run was in flight'`. Linear itself is untouched — if issue X is still actually `In Progress` in Linear, `reconcileStaleLocks()`/normal reconciliation picks it back up on the next tick exactly as if the row had never existed.

## Validation

- `bun test` (240 pass, 0 fail, up from 230) — two new files:
  - `app/test/dispatch-lock-lease.test.ts` (6 tests): pure mirror of the NX-acquire / CAS-release / CAS-renew semantics embedded in the two Lua scripts (`RELEASE_DISPATCH_LOCK_IF_OWNER`, `RENEW_DAEMON_LOCK_IF_OWNER`) and the `SET NX` acquire calls — no real Valkey, per `AGENTS.md`'s network-free requirement for the contract suite (confirmed: CI's `ci.yml` runs no Redis/Valkey service).
  - `app/test/orphan-running-rows.test.ts` (4 tests): `closeOrphanRunningRows` against the real (temp-file) test SQLite DB — flips a `running` row with the right `error_message`/`ended_at`/`duration_ms`, preserves a pre-existing `error_message` instead of overwriting it, leaves terminal-state rows untouched, returns `{ closed: 0 }` once nothing is running.
  - **Confirmed no hidden Valkey dependency**: stopped the local Valkey service (`brew services stop valkey`) and re-ran the full suite — 240 pass, 0 fail, ~4.6s, no hangs or errors. This specifically verifies the new dispatch-lock code in `runDispatch` isn't exercised by any existing test (no test currently calls `runDispatch` — the ACP contract tests call the harness adapter directly, bypassing `dispatch.ts` entirely).
- `bun run typecheck` (app) — clean.
- **Full manual three-instance validation** against an isolated `YAOE_HOME` + a dedicated Valkey DB index (`redis://127.0.0.1:6379/3`, flushed before/after — no real data touched), `ORCHESTRATOR_ENABLED=false`/`DASHBOARD_ENABLED=false` to keep the run minimal:
  1. Instance A boots → logs `daemon instance lock acquired`; `GET orch:daemon:lock` in Valkey matches its instance id.
  2. Instance B boots concurrently (same `YAOE_HOME`/Valkey, different port) → logs `daemon instance lock DENIED` + the "dispatch/tick stay OFF" warning, then finishes booting normally: `/health` returns `200` on **both** A and B, confirming the "not a hard crash" behavior — the losing instance stays reachable, it just never ticks.
  3. `kill -9` both instances (simulating a crash — the lease is left behind, confirmed via `TTL orch:daemon:lock` still counting down). Deleted the stale lease directly (equivalent to waiting out its TTL) and seeded a `status='running'` row directly into the SQLite file (simulating a run in flight when the process died).
  4. Instance C boots solo → logs `daemon instance lock acquired`, immediately followed by `closed orphan 'running' rows left by a previous process` naming that exact row id; re-querying the DB confirms `status='failed'`, the expected `error_message`, and a non-null `ended_at`/`duration_ms`.
  5. Cleaned up: killed instance C, flushed the isolated Valkey DB index, deleted the temp `YAOE_HOME` and all scratch files — verified `git status` shows only the intended source/test files.
- **Bug found and fixed during that manual pass (test-setup, not product)**: the first attempt at instance B crashed with `EADDRINUSE` on port 4792 — the OpenRouter reconcile proxy binds a fixed port independent of `PORT`/`config.port`. Not a defect in this feature (two full daemon stacks on one host sharing default derived ports was never a supported topology; the real scenario this guards is a supervisor restart or two hosts sharing one Valkey) — worked around by setting `OPENROUTER_PROXY_PORT` distinctly for the test instance, confirming the instance-lock-denial path itself was never at fault.

## Deferred

None carried forward from this bundle.
