# Agents: roles, behavior and issue structure

What each agent role does, how it is configured today, and the issue structure the pipeline expects/produces.

## Summary

- [The four roles](#the-four-roles)
- [SOULs and versions](#souls-and-versions)
- [The issue structure PMO produces](#the-issue-structure-pmo-produces)
- [Capacity and gates](#capacity-and-gates)
- [Output language](#output-language)
- [Editing agents on the dashboard](#editing-agents-on-the-dashboard)

## The four roles

**PMO — task refinement.** Pulls `To Do` issues (with `ready-to-refine`). Normalizes scope, declares the **footprint**, records dependencies (blockedBy/blocks), writes the out-of-scope list and the acceptance checklist, then moves the issue to `Planned` (or `Blocked` when a human decision is missing). Never writes code. Default MCPs: Linear, GitHub (read-only), Developer.

**Dev — implementation.** Pulls `Planned` (implement mode) and `Reopened` (fix mode). Respects the footprint as a scope ceiling and the SOUL's plan-gate; opens the PR and attaches its link to the issue before moving to `Code Review`. Default MCPs: Linear, GitHub (read/write), Developer.

**Reviewer — PR audit.** Pulls `Code Review`. Read-only audit: traceability to the checklist/acceptance criteria, scope audit (diff ⊆ footprint), bugs and security. Approves (→ `Pending Merge`) or rejects pointing at specific files/lines (→ `Reopened`). Default MCPs: GitHub (read/write for review comments), Linear, Developer.

**Orchestrator — planning & merge.** Two modes: *planning* (estimates the footprint of an issue and replies with ONLY the footprint JSON) and *merge* (merges the PR of a `Pending Merge` issue). Merges are serialized by a mutex. Never writes code.

## SOULs and versions

Behavior is defined by **SOULs** — versioned system prompts. `agents/*.SOUL.md` are the seed/interchange copies in git; at runtime the source of truth is the database (dashboard → Agents → versions). Every SOUL is concatenated with `agents/COMMUNICATION_PROTOCOL.md`, the pipeline contract every role obeys (comment format, status transitions, scope isolation rules).

## The issue structure PMO produces

A refined issue contains, in its description/comments:

- **Context & expected result** — what and why, in reviewable form.
- **`## Footprint`** — `repo:path` globs the implementation may touch. This is simultaneously the collision-lock key and the scope-check ceiling. `**` is globstar; trailing `/*` means the whole subtree.
- **Dependencies** — Linear blockedBy/blocks relations (the scheduler will not dispatch an issue whose blockers are open).
- **Out of scope** — explicit guardrails.
- **Checklist** — acceptance criteria the Reviewer traces against.

You can also write this structure by hand and skip PMO — the pipeline only cares that the structure exists.

## Capacity and gates

Per-role seat caps: `MAX_PMO_WORKERS`, `MAX_DEV_WORKERS`, `MAX_REVIEWER_WORKERS`, `MAX_ORCHESTRATOR_WORKERS` (0 disables a stage). Human gates via labels (see [linear-setup.md](linear-setup.md)). Inactivity timeouts and the `MAX_ATTEMPTS` circuit breaker keep the pipeline self-healing.

## Output language

`AGENT_OUTPUT_LANGUAGE` (Config screen; default English) sets the language of human-facing output — Linear comments, PR descriptions, review verdicts. SOULs stay English internally.

## Editing agents on the dashboard

Dashboard → **Agents**: each role is an entity with SOUL versions, the active **harness** (see [harnesses.md](harnesses.md)), model, and its **MCP servers** (see [mcp-configuration.md](mcp-configuration.md)). Changes apply on the next dispatch — no restart.

