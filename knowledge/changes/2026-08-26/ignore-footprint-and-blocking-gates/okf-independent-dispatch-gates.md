---
type: concept
title: "Footprint-lock collision and Linear blockedBy are independent opt-in bypasses"
description: "IGNORE_FOOTPRINT_LOCKS skips collision + deterministic scope-check; IGNORE_BLOCKING_ISSUES skips Linear blockedBy. Default false. Hot. Combinable."
tags: [scheduler, footprint, scope-check, blockedBy, config]
---

# Footprint-lock collision and Linear blockedBy are independent opt-in bypasses

The scheduler has two distinct "do not start this Planned issue yet" gates:

1. **Footprint lock** — Valkey lock + `collidesWithActive` (`app/src/dag.ts`). Same-repo overlapping globs serialize Dev. After Code Review, the deterministic **scope-check** (`filesOutsideFootprint`) reopens PRs whose diff escaped the declared footprint.
2. **Linear relations** — `issue.blockedBy` must all be Completed (`depsSatisfied`). The PMO writes `blockedBy`/`blocks`; the scheduler only reads incoming `blockedBy`. An issue that *blocks* others is not itself skipped; its dependents are.

Those gates must not be collapsed. `IGNORE_FOOTPRINT_LOCKS` (default false) turns off (1) only — including the files-outside-footprint scope-check — and still estimates the footprint, still claims the per-issue exclusive lock, still requires a PR and `AGENT_AUTHORIZED_ORGS`. `IGNORE_BLOCKING_ISSUES` (default false) turns off (2) only. Both are config-service getters (ENV > db > default), no `requiresRestart`, so a Config-screen toggle applies on the next tick.

Policy lives in `app/src/dispatch-gates.ts` so scheduler and readiness cannot drift. The Linear **Blocked** status is a third thing (human/circuit-breaker park) and is not affected by either flag.

When a flag is on, a per-run **prompt overlay** (not a SOUL rewrite) tells the agent so Reviewer/Dev do not undo the scheduler — [okf-pipeline-policy-overlay.md](okf-pipeline-policy-overlay.md). Map for replacing that splice with one assembler: [knowledge/product/pipeline-policy-overlay.md](../../../product/pipeline-policy-overlay.md).

Related: collision-freedom remains the default product (`knowledge/product/architecture.md`, `knowledge/rules/pipeline-semantics.md`).
