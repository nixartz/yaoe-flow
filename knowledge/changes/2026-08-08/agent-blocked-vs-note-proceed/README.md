---
type: "Feature Spec"
title: "Soften agent Blocked: prefer note+proceed; reserve 🙋 for human decisions"
description: "COMMUNICATION_PROTOCOL §5/§8/§11 and all four SOULs (reference + active DB versions) prefer evidence + 📝 + proceed; Blocked only for protocol §5 product/safety/access cases. Scheduler footprint locks unchanged."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, souls, communication-protocol, blocked, agents]
timestamp: "2026-08-08T00:00:00Z"
---

# Soften agent Blocked: prefer note+proceed

## Issues / PRs

- (local) Operator feedback: agents were too eager to `🙋` + `Blocked` on mild ambiguity / noisy comments / path tightening, stalling the pipeline for human approval when the issue + named repo already supported a decision. Scheduler footprint-collision gating must stay strict.

## What changed

### Pipeline contract — `agents/COMMUNICATION_PROTOCOL.md`

- **§5** — explicit allow/deny lists for `🙋` + `Blocked` vs `📝` + proceed; scheduler locks ≠ Blocked.
- **§8** — invent vs derive (empty repo → Blocked; footprint/deps from named repo → proceed); off-topic comments ignored by default; abort only on wrong-repo / large leakage.
- **§11** — Dev/Reviewer: new human comments after PMO `✅` are not automatic `🙋`.

### SOULs (git reference + runtime DB)

| Role | Highlights |
| --- | --- |
| PMO | Off-topic / contradicting comments and deps follow §5; derive footprint paths when repo is named; empty **repo** still Blocked |
| Dev | Issue-scoped workspace wording; help flow tied to §5 |
| Reviewer | Post-cutoff comments follow §5; help flow narrowed |
| Orchestrator | Planning stays non-Blocked; merge uses durable issue workspace |

Active DB versions bumped via `createVersion(..., { activate: true })` from disk `agents/*.SOUL.md` after `embed-assets` (operator `~/.yaoe-flow`: pmo→v4, dev→v11, reviewer→v7, orchestrator→v5). Note: `readSoulFile()` prefers the embed — sync from disk path when pushing to the DB after editing SOULs.

### Generated / embed

- `bun recipes/build.ts` regenerated Goose YAML seeds.
- `bun run embed-assets` refreshed `EMBEDDED_COMMUNICATION_PROTOCOL` + `EMBEDDED_SOULS` for the binary.

### Layers

| Layer | Changed? |
| --- | --- |
| API | No |
| CLI | No |
| Dashboard | No |
| Harness / Scheduler | No (lock/deps gating untouched) |
| Agents (SOUL + protocol) | Yes |
| Docs / product knowledge | Yes — short note in architecture |

## Deferred

- Optional dashboard action “re-seed SOUL from git file” without a one-off script.
- Further tuning if agents still Block too often on a specific pattern (capture Linear examples first).

## Bugs found in validation

- (none yet — behavior change is prompt-level; validate on next real refine/implement run.)
