# Linear setup

How to prepare a Linear workspace so YAOE-FLOW can read statuses and labels correctly — and which agent pulls issues from which step.

## Summary

- [What you need](#what-you-need)
- [1. API key](#1-api-key)
- [2. Team workflow statuses](#2-team-workflow-statuses)
- [3. Curation labels](#3-curation-labels)
- [4. Webhook (optional but recommended)](#4-webhook-optional-but-recommended)
- [5. Multiple workspaces](#5-multiple-workspaces)
- [Who pulls what](#who-pulls-what)
- [Troubleshooting](#troubleshooting)

## What you need

- A Linear workspace and a team whose workflow the pipeline will orchestrate.
- A personal API key (ideally from a dedicated service-account user, so agent comments are clearly attributed).

The `yaoe-flow setup` wizard automates most of this section: it validates the key, lets you pick the team, reports status divergences and offers to create the missing labels. This page explains what it is doing.

## 1. API key

Create at **Linear → Settings → Security & access → Personal API keys** (https://linear.app/settings/account/security). Store it via the wizard or the dashboard Config screen (`LINEAR_API_KEY`) — it is encrypted at rest and also forwarded to agent MCPs as `LINEAR_API_TOKEN`.

## 2. Team workflow statuses

The pipeline expects these statuses to exist in the team workflow (names are configurable via the `STATE_*` settings; defaults shown):

| Status | Meaning in the pipeline |
|---|---|
| `To Do` | Refinement queue |
| `Refining` | PMO working (transient) |
| `Planned` | Refined, waiting for implementation |
| `In Progress` | Dev working |
| `Code Review` | PR open, waiting for a reviewer seat |
| `In Review` | Reviewer working |
| `Pending Merge` | Approved, waiting for merge |
| `Reopened` | Rejected — goes back to Dev in fix mode |
| `Completed` | Merged |
| `Blocked` | Needs a human decision (circuit breaker parks issues here) |

Create the missing columns in Linear (the wizard only *reports* divergences — creating/renaming workflow states is a human decision), or point the `STATE_*` settings at your existing names on the Config screen.

## 3. Curation labels

Three labels act as human gates (safe to auto-create; the wizard offers to):

| Label | Gate |
|---|---|
| `ready-to-refine` | To Do → Refining (PMO only pulls labeled issues) |
| `ready-to-implement` | Planned → In Progress |
| `ready-to-merge` | Pending Merge → merge |

With `AUTO_DISPATCH_ISSUES=true` the first two gates are skipped (status is enough); with `AUTO_MERGE_ISSUES=true` the merge gate is skipped. Status is always the source of truth — labels only restrict.

Two more opt-in flags (Config → Automação e confiabilidade, default off, hot — no restart):

- `IGNORE_FOOTPRINT_LOCKS` — Planned → In Progress even when the footprint overlaps an in-flight lock; Code Review → In Review no longer rejects PRs that escape the declared footprint. Linear `blockedBy`/`blocks` still apply. The Reviewer SOUL is not rewritten: a per-run prompt overlay tells the agent not to Reopen *solely* for a footprint leak (see [pipeline-policy-overlay.md](../knowledge/product/pipeline-policy-overlay.md)).
- `IGNORE_BLOCKING_ISSUES` — Planned/Reopened dispatch even if other issues block this one (or this one blocks others). Footprint locks and the scope-check still apply. The Linear **Blocked** status is unchanged (human gate). PMO still writes `blockedBy`/`blocks`; the overlay tells Dev not to `🙋`+Blocked for unmet deps.

## 4. Webhook (optional but recommended)

Without a webhook the pipeline still works — the scheduler reconciles every `TICK_INTERVAL_MS` (30s default). A webhook adds instant push:

- The wizard creates it for you when you provide a public URL (`https://your-host/webhook/linear`) and stores the generated secret (`LINEAR_WEBHOOK_SECRET`) used to validate delivery signatures.
- Manual path: Linear → Settings → API → Webhooks → new webhook pointing at `https://your-host/webhook/linear`, then set the same secret in the config.

## 5. Multiple workspaces

The dashboard's **Linear Connections** screen (and the wizard) support extra workspaces: each connection stores its own API key, webhook secret, org and optional team filter. Issues from every connection flow through the same pipeline and locks.

## Who pulls what

| Step (status) | Agent | Requires label |
|---|---|---|
| To Do | PMO | `ready-to-refine` (unless AUTO_DISPATCH_ISSUES) |
| Planned | Dev (implement) | `ready-to-implement` (unless AUTO_DISPATCH_ISSUES) |
| Reopened | Dev (fix) | — |
| Code Review | Reviewer | — |
| Pending Merge | Orchestrator (merge) | `ready-to-merge` (unless AUTO_MERGE_ISSUES) |

## Troubleshooting

- `yaoe-flow doctor` validates the API key and reachability.
- The dashboard **Webhooks** screen audits every received event (including signature failures).
- The dashboard **Readiness** screen shows, per candidate issue, exactly why it is or is not dispatchable (missing label, colliding footprint, no seat…).

