---
type: "Product Knowledge"
title: "YAOE-FLOW architecture"
description: "How the autonomous pipeline works: state machine, roles, locks, harnesses, self-healing."
tags: [architecture, pipeline, scheduler, harness]
timestamp: "2026-08-02T00:00:00Z"
---

# YAOE-FLOW architecture

## Summary

- [The pipeline in one paragraph](#the-pipeline-in-one-paragraph)
- [State machine (Linear statuses)](#state-machine-linear-statuses)
- [Roles](#roles)
- [Collision-freedom: footprints and locks](#collision-freedom-footprints-and-locks)
- [Harnesses](#harnesses)
- [Self-healing](#self-healing)
- [Storage and disk layout](#storage-and-disk-layout)

## The pipeline in one paragraph

Linear is the source of truth: issue **statuses** drive the pipeline, humans curate with **labels** (`ready-to-refine`, `ready-to-implement`, `ready-to-merge`), and every agent action lands as a Linear comment. The `yaoe-flow` daemon (one process: API + scheduler + dashboard) receives Linear webhooks and, as a safety net, reconciles on a periodic tick (`TICK_INTERVAL_MS`, default 30s). For each dispatchable issue it picks the role's **active agent** (dashboard entity: SOUL + harness + model + MCPs), clones the target repo into an **issue-scoped workspace** (`$YAOE_HOME/worktrees/issue-<issueId>`), runs the harness, and records the full run (trace, usage, cost) for the dashboard.

## State machine (Linear statuses)

```
To Do ──► Refining ──► Planned ──► In Progress ──► Code Review ──► In Review
  ▲          (PMO)                    (Dev)                          (Reviewer)
  │                                                                     │
  │                     Reopened ◄── rejected ◄─────────────────────────┤
  │                        │ (Dev, fix mode)                   approved │
  │                        └──────────► In Progress                     ▼
  └─ Blocked (circuit breaker / human decision)              Pending Merge ──► Completed
                                                              (Orchestrator, serialized merge)
```

- Entry stages (To Do→Refining, Planned→In Progress) require the human gate label unless `AUTO_DISPATCH_ISSUES=true`.
- Pending Merge→merge requires `ready-to-merge` unless `AUTO_MERGE_ISSUES=true`.
- Reopened and Code Review dispatch on status alone.
- Blocked leaves the active pipeline (frees the seat) but keeps the footprint lock until a human resolves it. Manual stop from the dashboard only moves to Blocked when **no other run** is still live for that issue (duplicate-dispatch safety).
- At most one in-flight Dev (and one footprint estimate) per issue: Valkey NX estimate reservation + exclusive lock claim, plus checks against open dashboard runs / in-memory active processes.

## Roles

| Role | Trigger | Seat cap | What it does |
|---|---|---|---|
| PMO | To Do (+label) | `MAX_PMO_WORKERS` | Refines: dependencies, footprint, out-of-scope, checklist. Moves to Planned/Blocked. |
| Dev | Planned (+label) / Reopened | `MAX_DEV_WORKERS` | Implements (`implement`) or fixes (`fix`), footprint as scope ceiling, opens the PR. |
| Reviewer | Code Review | `MAX_REVIEWER_WORKERS` | Read-only audit: traceability, scope (diff ⊆ footprint), bugs, security. Approves or reopens. |
| Orchestrator | Pending Merge (+label) & planning | `MAX_ORCHESTRATOR_WORKERS` | Footprint planning (JSON-only reply) and the final merge, serialized by a mutex. |

Behavior lives in **SOULs** (`agents/*.SOUL.md` as seed; database as runtime source of truth) concatenated with `agents/COMMUNICATION_PROTOCOL.md` — the pipeline contract shared by every role. The seed only populates an EMPTY `agents` table, so an upgrade never rewrites a tuned SOUL by itself: bringing the bundled SOULs into an existing install is an explicit, confirmed step (`yaoe-flow sync-souls` or Agents → *Aplicar SOUL padrão*), and it appends a new active version while keeping the replaced one in history (`app/src/agent/soulSync.ts`). Human-facing output language is configurable (`AGENT_OUTPUT_LANGUAGE`). Agents reserve `🙋` + Linear **Blocked** for protocol §5 (product/safety/access / empty repo); within a named repo they prefer `📝` + proceed. Scheduler footprint locks only delay dispatch — they are not a Blocked transition.

## Collision-freedom: footprints and locks

Each issue declares a **footprint** (`repo:path` globs — the files it is allowed to touch). Valkey holds footprint **locks**; the scheduler only dispatches issues whose footprints do not collide with in-flight runs (`app/src/dag.ts`), and the deterministic **scope-check** (`app/src/scope.ts`) rejects PRs whose diff escapes the declared footprint. Glob semantics (`app/src/dag.ts`): `**` is globstar (zero or more segments), mid-path `*` is one segment, and a trailing `/*` means the whole subtree (same as `/**`) so SOUL `<module>/*` entries stay recursive. `AGENT_AUTHORIZED_ORGS` is an anti-fork fail-safe on top. Merges are further serialized by a merge mutex.

Two **opt-in** hot flags (Config screen / ENV, default `false`, next tick, no restart) can independently relax those gates:

- `IGNORE_FOOTPRINT_LOCKS` — skip footprint-lock collision at Planned → In Progress and skip the files-outside-footprint half of the scope-check at Code Review → In Review. Still estimates the footprint, still acquires the per-issue exclusive lock (duplicate-dispatch guard), still requires a PR and `AGENT_AUTHORIZED_ORGS`. Does **not** skip Linear `blockedBy`/`blocks`.
- `IGNORE_BLOCKING_ISSUES` — skip Linear `blockedBy`/`blocks` when picking Planned/Reopened. Does **not** skip footprint collision or the scope-check, and does **not** pull issues in the Linear **Blocked** status (human gate).

The two flags combine: both on = both gates off. Default off = collision-freedom stays the product.

When a flag is on, a **per-run prompt overlay** (`app/src/agent/recipe/pipeline-policy.ts`) tells the agent about that exception so the Reviewer does not undo the skipped scope-check, and so Dev expects parallel overlap. The SOUL/protocol text is unchanged (default product). This overlay is a stopgap assembler — see [pipeline-policy-overlay.md](pipeline-policy-overlay.md) before adding a third flag the same way.

## Harnesses

The scheduler talks to a `HarnessAdapter` interface (`app/src/agent/harness/`). Available harnesses:

- **ACP adapters** (full step-by-step trace): Claude Code (`claude-code-acp`), Codex (`codex-acp`), Cursor (`cursor-agent acp`), Copilot, Goose (`goose acp`). Subscription CLIs use the operator's logged-in session, which is why the daemon runs as the logged-in user (never root).
- **Goose + OpenRouter (BYOK)**: recipes built at runtime from the agent entity; a local OpenRouter proxy captures generation ids for cost reconciliation.
- **Hermes HTTP**: fire-and-report gateway (no trace) — one profile per role.

Per-issue workspace: every harness (ACP, Goose, Hermes-adjacent local cwd users) reuses `$YAOE_HOME/worktrees/issue-<issueId>` (or `conn-<connectionId>/issue-<issueId>`) from the first dispatch until **Completed**. ACP HOME/config mirrors (`issue-*-home`, `-cursor-config`, …) sit beside that cwd; the code tree is not deleted between PMO → Dev → Review → Reopened/Blocked. Cleanup runs on the Completed webhook and via `reconcileStaleWorkspaces()` on the tick (missed webhook / tick-only). `GOOSE_KEEP_WORKSPACES=true` keeps dirs after Completed for debugging.

## Self-healing

- Inactivity timeouts per seat (`REFINING_TIMEOUT_MS`/`IN_PROGRESS_TIMEOUT_MS`/`IN_REVIEW_TIMEOUT_MS`/`MERGE_TIMEOUT_MS`) reclaim stuck seats — with trace, "activity" means run events, not wall time.
- `MAX_ATTEMPTS` circuit breaker sends looping issues to Blocked.
- `reclaimStale()` releases every acquired resource (locks, seats, run rows); a retention sweep prunes runs/webhooks/logs.
- The reconciliation tick survives missed webhooks — including **stale footprint locks**: if an issue reaches Completed (or otherwise leaves lock-holding states) without the release webhook landing, `reconcileStaleLocks()` drops the Valkey lock on the next tick so Planned candidates are not blocked forever. The same tick runs **`reconcileStaleWorkspaces()`** to delete on-disk `issue-*` dirs whose Linear state left the workspace-holding set (Refining/Planned/In Progress/…/Blocked).
- **Cross-process dispatch safety**: `runDispatch` claims a Valkey per-issue/role dispatch lease before spawning any harness process, so two daemon processes sharing a `YAOE_HOME`+Valkey can't double-dispatch the same issue. A boot-time `orch:daemon:lock` (renewed every tick) detects a second live instance and disables its tick/dispatch (API/dashboard stay up); on a confirmed solo boot, any `runs` row left `status='running'` by a killed process is flipped to `failed` (DB-only — no Linear transition, `reconcileStaleLocks()` handles the Linear side independently).
- Linear GraphQL rate limits (5 000 req/h per API key): the client tracks `X-RateLimit-Requests-*` headers and `RATELIMITED` errors, enters a cooldown until reset, and skips ticks / readiness snapshots when the remaining budget is too low. List/getIssue calls are memoized within a single connection reconcile.

## Storage and disk layout

Everything lives under `YAOE_HOME` (default `~/.yaoe-flow`, identical in dev and installed modes):

```
~/.yaoe-flow/
  config.env        # bootstrap keys (chmod 600) + YAOE_SETUP_COMPLETED_AT marker
  data/dashboard.sqlite  # runs, webhooks, logs, users, settings (secrets encrypted)
  logs/yaoe-flow.log
  worktrees/issue-<issueId>/   # durable clone until Completed (per connection: conn-<id>/…)
  worktrees/run-<runId>/       # rare ephemeral cwd when dispatch has no issueId
  yaoe-flow.pid
```

Valkey/Redis holds only coordination state (locks, counters) — safe to flush when the pipeline is idle.

