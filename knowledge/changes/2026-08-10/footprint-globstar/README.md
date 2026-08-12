---
type: "Bug Fix"
title: "Footprint globstar + OKF ancillary"
description: "Scope-check and collision matcher treat ** as globstar; CHANGELOG/OKF paths are ancillary (§8.1)."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, footprint, globstar, scope-check, ancillary, okf]
timestamp: "2026-08-10T00:00:00Z"
---

# Footprint globstar + OKF ancillary

## Issues / PRs

- Linear: [INF-23](https://linear.app/infleux/issue/INF-23/brands-tela-de-perfilconfiguracoes-conta-marca-time-tema-billing) (consumer issue blocked by the matcher; not fixed in that repo here)

## Root cause

The PMO footprint used `src/app/**/perfil/**`-style globs, but `app/src/dag.ts` only did prefix matching after stripping a trailing `/*`, leaving mid-path `**` as literal characters. The deterministic scope-check therefore rejected in-footprint files (e.g. `src/app/perfil/page.tsx`). The same check also rejected `CHANGELOG.md` and `knowledge/changes/**`, which AGENTS.md requires but protocol §8.1 did not treat as ancillary.

## What changed & where

| Layer | Changed? | Notes |
| --- | --- | --- |
| API | No | — |
| CLI | No | — |
| Dashboard | No | — |
| Harness | No | — |
| Scheduler / scope | **Yes** | `app/src/dag.ts` uses `Bun.Glob`; trailing `/*` ⇒ subtree; `**` = globstar |
| Ancillary | **Yes** | `app/src/footprint-ancillary.ts` + protocol §8.1: `CHANGELOG.md`, `knowledge/changes/**` |
| SOULs / protocol | **Yes** | PMO + Orchestrator seed notes; `COMMUNICATION_PROTOCOL.md` §8.1 row |
| CI | No | — |
| Tests | **Yes** | `app/test/footprint-globstar.test.ts` (+ ancillary cases) |

## Validation bugs found

- Confirmed INF-23 diagnosis: `normalize()` + `startsWith` treated `src/app/**/perfil` as a literal prefix, so `src/app/perfil/page.tsx` never matched.
- Collision membership for two mid-globstar patterns under the same literal prefix remains intentionally conservative (may serialize more than strictly needed).

## Deferred

- ~~Syncing active DB SOUL versions on deployed instances~~ — shipped: [knowledge/changes/2026-08-11/soul-sync](../../2026-08-11/soul-sync/README.md) (`yaoe-flow sync-souls` + dashboard button).
- ~~Smarter disjointness for two patterns that share a literal prefix but cannot match the same file~~ — shipped: [knowledge/changes/2026-08-11/footprint-globstar-disjointness](../../2026-08-11/footprint-globstar-disjointness/README.md).
