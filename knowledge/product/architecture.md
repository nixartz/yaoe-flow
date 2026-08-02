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

Linear is the source of truth: issue **statuses** drive the pipeline, humans
curate with **labels** (`ready-to-refine`, `ready-to-implement`,
`ready-to-merge`), and every agent action lands as a Linear comment. The
`yaoe-flow` daemon (one process: API + scheduler + dashboard) receives Linear
webhooks and, as a safety net, reconciles on a periodic tick
(`TICK_INTERVAL_MS`, default 15s). For each dispatchable issue it picks the
role's **active agent** (dashboard entity: SOUL + harness + model + MCPs),
clones the target repo into an isolated workspace
(`$YAOE_HOME/worktrees/run-<id>`), runs the harness, and records the full run
(trace, usage, cost) for the dashboard.

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

- Entry stages (To Do→Refining, Planned→In Progress) require the human gate
  label unless `AUTO_DISPATCH_ISSUES=true`.
- Pending Merge→merge requires `ready-to-merge` unless `AUTO_MERGE_ISSUES=true`.
- Reopened and Code Review dispatch on status alone.
- Blocked leaves the active pipeline (frees the seat) but keeps the footprint
  lock until a human resolves it.

## Roles

| Role | Trigger | Seat cap | What it does |
|---|---|---|---|
| PMO | To Do (+label) | `MAX_PMO_WORKERS` | Refines: dependencies, footprint, out-of-scope, checklist. Moves to Planned/Blocked. |
| Dev | Planned (+label) / Reopened | `MAX_DEV_WORKERS` | Implements (`implement`) or fixes (`fix`), footprint as scope ceiling, opens the PR. |
| Reviewer | Code Review | `MAX_REVIEWER_WORKERS` | Read-only audit: traceability, scope (diff ⊆ footprint), bugs, security. Approves or reopens. |
| Orchestrator | Pending Merge (+label) & planning | `MAX_ORCHESTRATOR_WORKERS` | Footprint planning (JSON-only reply) and the final merge, serialized by a mutex. |

Behavior lives in **SOULs** (`agents/*.SOUL.md` as seed; database as runtime
source of truth) concatenated with `agents/COMMUNICATION_PROTOCOL.md` — the
pipeline contract shared by every role. Human-facing output language is
configurable (`AGENT_OUTPUT_LANGUAGE`).

## Collision-freedom: footprints and locks

Each issue declares a **footprint** (`repo:path` globs — the files it is
allowed to touch). Valkey holds footprint **locks**; the scheduler only
dispatches issues whose footprints do not collide with in-flight runs
(`app/src/dag.ts`), and the deterministic **scope-check**
(`app/src/scope.ts`) rejects PRs whose diff escapes the declared footprint.
`AGENT_AUTHORIZED_ORGS` is an anti-fork fail-safe on top. Merges are further
serialized by a merge mutex.

## Harnesses

The scheduler talks to a `HarnessAdapter` interface
(`app/src/agent/harness/`). Available harnesses:

- **ACP adapters** (full step-by-step trace): Claude Code (`claude-code-acp`),
  Codex (`codex-acp`), Cursor (`cursor-agent acp`), Copilot, Goose
  (`goose acp`). Subscription CLIs use the operator's logged-in session, which
  is why the daemon runs as the logged-in user (never root).
- **Goose + OpenRouter (BYOK)**: recipes built at runtime from the agent
  entity; a local OpenRouter proxy captures generation ids for cost
  reconciliation.
- **Hermes HTTP**: fire-and-report gateway (no trace) — one profile per role.

Per-run isolation: each ACP run gets its own HOME mirror (Cursor/Claude
Code/Codex config dirs are per-run), the git credential comes from the run
token, and the workspace is deleted afterwards
(`GOOSE_KEEP_WORKSPACES=true` keeps it for debugging).

## Self-healing

- Inactivity timeouts per seat (`REFINING/IN_PROGRESS/IN_REVIEW/MERGE
  _TIMEOUT_MS`) reclaim stuck seats — with trace, "activity" means run events,
  not wall time.
- `MAX_ATTEMPTS` circuit breaker sends looping issues to Blocked.
- `reclaimStale()` releases every acquired resource (locks, seats, run rows);
  a retention sweep prunes runs/webhooks/logs.
- The reconciliation tick survives missed webhooks.

## Storage and disk layout

Everything lives under `YAOE_HOME` (default `~/.yaoe-flow`, identical in dev
and installed modes):

```
~/.yaoe-flow/
  config.env        # bootstrap keys (chmod 600) + YAOE_SETUP_COMPLETED_AT marker
  data/dashboard.sqlite  # runs, webhooks, logs, users, settings (secrets encrypted)
  logs/yaoe-flow.log
  worktrees/run-<id>/    # per-run isolated clones (ephemeral)
  yaoe-flow.pid
```

Valkey/Redis holds only coordination state (locks, counters) — safe to flush
when the pipeline is idle.
