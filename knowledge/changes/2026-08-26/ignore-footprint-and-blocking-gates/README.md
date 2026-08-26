---
type: "Feature"
title: "Opt-in IGNORE_FOOTPRINT_LOCKS and IGNORE_BLOCKING_ISSUES (hot, default off)"
description: "Two independent Config flags skip footprint-lock collision + deterministic scope-check, or Linear blockedBy/blocks, without a restart. Default false preserves collision-freedom."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, scheduler, footprint, scope-check, deps, config, readiness]
timestamp: "2026-08-26T00:00:00Z"
---

# Opt-in IGNORE_FOOTPRINT_LOCKS and IGNORE_BLOCKING_ISSUES

## Issues / PRs

- No Linear issue: operator request — enable two independent, hot-reloadable bypasses of the Planned → In Progress gates (footprint locks vs Linear blocking relations), default off.

## What changed & where

| Layer | Changed? | Notes |
| --- | --- | --- |
| API | **Yes** | `GET /api/readiness` snapshot `flags` gained `ignoreFootprintLocks` / `ignoreBlockingIssues` (OpenAPI schema) |
| CLI | No | — |
| Dashboard | **Yes** | Config labels for the two settings; Readiness header shows whether footprint locks / Linear deps are respected or ignored |
| Harness | **Yes** | ACP/native first-turn concat and Goose recipe `instructions` append the overlay; Goose cache key includes `recipeAssemblyKey()` |
| SOULs / protocol | **No rewrite** | Default SOUL/protocol unchanged. Per-run overlay (`app/src/agent/recipe/pipeline-policy.ts`) when a flag is on — see below |
| Scheduler | **Yes** | `tryDispatchImpl` / `estimateThenDispatch` / `commitNewImplementation` skip `collidesWithActive` when `IGNORE_FOOTPRINT_LOCKS`; skip `depsSatisfied` (Linear `blockedBy`) when `IGNORE_BLOCKING_ISSUES`; `scopeCheckPasses` skips the files-outside-footprint half (still requires a PR and `AGENT_AUTHORIZED_ORGS`) |
| Config | **Yes** | `IGNORE_FOOTPRINT_LOCKS` + `IGNORE_BLOCKING_ISSUES` in `config/registry.ts` (Reliability & merge, boolean, default `false`, no `requiresRestart`) + getters on `config.ts` + `.env.example` |
| Docs | **Yes** | `knowledge/product/architecture.md`, `knowledge/product/pipeline-policy-overlay.md` (stopgap map + redo checklist), `knowledge/rules/pipeline-semantics.md`, `docs/agents.md`, `docs/linear-setup.md`, `docs/github-setup.md` |
| Recipes | **Yes** | Goose `instructions` append the overlay; Goose recipe cache key includes `recipeAssemblyKey()` so a Config toggle is not sticky |
| CI | No | — |
| Tests | **Yes** | `app/test/dispatch-gates.test.ts` (independence matrix), `app/test/config.test.ts` (default false + hot), `app/test/pipeline-policy.test.ts` (overlay omitted when off; role bullets; flag independence), `app/test/setup.ts` clears the new ENV |

## FLOW (Config → next tick)

1. **Config screen** → Reliability & merge → toggle `IGNORE_FOOTPRINT_LOCKS` and/or `IGNORE_BLOCKING_ISSUES` (or set ENV / `.env.example`). Save. No restart.
2. **Next scheduler tick** (or the next webhook-driven pick) reads the getters. Planned issues that were queued behind a colliding lock and/or an open `blockedBy` become eligible independently, according to which flag is on.
3. **Readiness page** header shows `Footprint locks: respeitados|ignorados` and `Dependências Linear: respeitadas|ignoradas`, and no longer lists `footprint_collision` / `deps_unsatisfied` as blockers for the skipped gate(s).
4. **Next agent dispatch** (any role, Goose/ACP/native): if a flag is on, the prompt includes `## Current pipeline policy (operator Config — this run)` with role-specific bullets. Toggle the flag off → the next dispatch omits the block (Goose recipe cache key includes `recipeAssemblyKey()`, so the deeplink is rebuilt). Hermes HTTP still does not see the overlay.

### `IGNORE_FOOTPRINT_LOCKS=true` (default false)

- **Skips:** footprint-lock collision (`collidesWithActive`) at Planned → In Progress; files-outside-footprint half of the deterministic scope-check at Code Review → In Review.
- **Still runs:** Orchestrator footprint *estimate* (Dev's scope ceiling), per-issue exclusive lock (`tryAcquireLock` — duplicate-dispatch guard, not a cross-issue collision), PR-attached check, `AGENT_AUTHORIZED_ORGS`, Linear `blockedBy`/`blocks`, merge mutex, seat caps, labels, Blocked status.
- Linear blocking relations stay in force unless the other flag is also on.

### `IGNORE_BLOCKING_ISSUES=true` (default false)

- **Skips:** Linear `blockedBy` (an issue whose blockers are not Completed, and therefore also dependents of an issue that still blocks others).
- **Still runs:** footprint collision, scope-check, exclusive lock, seats, labels. Does **not** pull issues in the Linear **Blocked** status (human gate).

The flags are independent and combinable.

## Prompt overlay (stopgap — redo later)

When a flag is on, `appendPipelinePolicy` injects a short English block so the **agent** does not undo the scheduler (Reviewer would otherwise Reopen on footprint leak). SOULs are not edited. Map of today's split call sites (Goose vs ACP) and the intended single assembler: [knowledge/product/pipeline-policy-overlay.md](../../../product/pipeline-policy-overlay.md). Concept: [okf-pipeline-policy-overlay.md](okf-pipeline-policy-overlay.md).

## Bugs found during manual validation

- None yet (unit coverage of the independence matrix + hot config getters; no live Linear tick in this change).

## Deferred / follow-ups

- Footprint *estimate* still runs when `IGNORE_FOOTPRINT_LOCKS` is on (the lock collision is skipped, not the planning pass). Skipping estimate entirely would make Planned → In Progress faster but would leave Dev without a cached footprint; left as a follow-up if operators want that.
- **Redo the overlay assembly** (`knowledge/product/pipeline-policy-overlay.md`): collapse Goose vs ACP concatenation into one `assembleAgentInstructions` in `dispatch.ts`; give ACP the protocol as part of that (prompt-size change — verify separately); Hermes still will not see system-prompt overlays unless `promptText` grows a compact `pipelinePolicy:` line.
- Outgoing Linear `blocks` was never a scheduler gate (only incoming `blockedBy`); `IGNORE_BLOCKING_ISSUES` therefore unblocks the blocked issue, which is the "this one is blocking others" case from the dependent's side.
