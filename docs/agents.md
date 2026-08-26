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

### Picking up the SOULs of a new version

The seed only runs on a **fresh** database: once agents exist, upgrading the binary does not touch the SOULs already in use — otherwise an upgrade would silently overwrite what you tuned on the dashboard. When a release changes agent behavior, apply it explicitly:

```bash
yaoe-flow sync-souls
```

It prints, per role, the active version against the SOUL bundled in the running binary (`v3 (a1b2c3…, 120 lines) → v4 (…)`) and only writes after you confirm — `--yes` for scripted upgrades, `--role dev,reviewer` for a subset. The dashboard has the same action: **Agents → Aplicar SOUL padrão**, with the same plan and confirmation.

Either way, the SOUL being replaced is **kept in the agent's history** as its own version (Agents → edit → versions) and can be reactivated at any time. Local edits are *not* merged: the bundled text becomes a new active version on top of yours. No restart is needed — the next dispatch already uses it.

## Your repo's conventions (`AGENTS.md`, `CLAUDE.md`, …)

Agents do **not** inherit your repo's rules from the harness: the ACP session opens on the empty issue workspace and the repository is cloned into it afterwards, so `cursor-agent`/Claude Code/Codex never auto-discover your `AGENTS.md`. The pipeline handles it explicitly instead — **protocol §14**: right after each clone, every role reads that repo's guide before planning, in priority order `AGENTS.md` → `CLAUDE.md` → `.cursor/rules/*` / `.github/copilot-instructions.md` → `CONTRIBUTING.md` / `PROJECT_MAP.md` / `README.md` → the repo's knowledge/doc directory (`knowledge/`, `.okf/`, `docs/`, `.docs/`, `configdocs/`, `adr/`, …), following any pointers those files contain.

Two consequences worth knowing when you write a guide for your own repo:

- **Conventions are per repo.** An issue may span several repositories (frontend + backend, plus one read only as reference); each one is judged by its own guide, and a reference-only repo is never written to.
- **Required deliverables are part of "done".** If your guide says every change ships a change bundle / OKF entry, a `CHANGELOG.md` line, or a doc describing how the feature works and what has to be configured, then a PR without them is incomplete: PMO turns them into explicit checklist items, Dev must write them in the same PR, and Reviewer rejects when they are missing. Be specific in the guide (name the directory and the format) — vague guides produce vague deliverables.

Process-doc paths are treated as **ancillary** (protocol §8.1): agents write them without declaring them in `## Footprint`, and the deterministic scope-check skips them. Which paths count is configurable — see `SCOPE_ANCILLARY_DOC_PATHS` in [github-setup.md](github-setup.md#process-docs-and-the-scope-check).

## The issue structure PMO produces

A refined issue contains, in its description/comments:

- **Context & expected result** — what and why, in reviewable form.
- **`## Footprint`** — `repo:path` globs the implementation may touch. This is simultaneously the collision-lock key and the scope-check ceiling. `**` is globstar; trailing `/*` means the whole subtree.
- **Dependencies** — Linear blockedBy/blocks relations (the scheduler will not dispatch an issue whose blockers are open, unless `IGNORE_BLOCKING_ISSUES=true`).
- **Out of scope** — explicit guardrails.
- **Checklist** — acceptance criteria the Reviewer traces against.

You can also write this structure by hand and skip PMO — the pipeline only cares that the structure exists.

## Capacity and gates

Per-role seat caps: `MAX_PMO_WORKERS`, `MAX_DEV_WORKERS`, `MAX_REVIEWER_WORKERS`, `MAX_ORCHESTRATOR_WORKERS` (0 disables a stage). Human gates via labels (see [linear-setup.md](linear-setup.md)). Inactivity timeouts and the `MAX_ATTEMPTS` circuit breaker keep the pipeline self-healing.

## Output language

`AGENT_OUTPUT_LANGUAGE` (Config screen; default English) sets the language of human-facing output — Linear comments, PR descriptions, review verdicts. SOULs stay English internally.

## Editing agents on the dashboard

Dashboard → **Agents**: each role is an entity with SOUL versions, the active **harness** (see [harnesses.md](harnesses.md)), model, and its **MCP servers** (see [mcp-configuration.md](mcp-configuration.md)). Changes apply on the next dispatch — no restart.

Operator flags that change **scheduler enforcement** without changing the default SOUL (`IGNORE_FOOTPRINT_LOCKS`, `IGNORE_BLOCKING_ISSUES`) inject a short per-run overlay at prompt assembly. The overlay is omitted when the flags are off. This assembly is a stopgap — see [knowledge/product/pipeline-policy-overlay.md](../knowledge/product/pipeline-policy-overlay.md) before adding another flag the same way.

