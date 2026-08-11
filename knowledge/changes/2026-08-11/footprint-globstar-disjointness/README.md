---
type: "Enhancement"
title: "Smarter footprint globstar disjointness"
description: "Two mid-globstar footprint entries with the same literal prefix no longer over-collide when their next literal segment differs."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, footprint, globstar, scope-check, collision]
timestamp: "2026-08-11T00:00:00Z"
---

# Smarter footprint globstar disjointness

## Issues / PRs

- Follow-up to [knowledge/changes/2026-08-10/footprint-globstar](../../2026-08-10/footprint-globstar/README.md) (Deferred: "Smarter disjointness for two patterns that share a literal prefix but cannot match the same file").
- No Linear issue — internal backlog item picked up directly from `knowledge/product/roadmap.md`.

## Root cause

`app/src/dag.ts`'s `entriesCollide` fallback treats two glob footprint entries as colliding whenever their literal prefixes nest (`literalPrefixesNest`), even when both patterns still contain wildcards and neither's "witness path" falls inside the other. This was correct-but-conservative for the general case, but concretely over-collided two mid-globstar patterns that share a literal prefix and differ only in the literal segment right after the globstar — e.g. `src/app/**/perfil/**` vs `src/app/**/billing/**`: both collapse to literal prefix `src/app`, so the fallback marked them as colliding, even though no real file path segment can equal both `perfil` and `billing` at once.

This mattered because such pairs would unnecessarily serialize independent Dev dispatches (footprint collision blocks concurrent work), even when the PMO had already scoped two features into disjoint subtrees under the same parent directory.

## The fix

`app/src/dag.ts` adds two pure helpers:

- `firstLiteralSegmentAfterLeadingGlobstar(pattern)`: returns the literal segment immediately following a pattern's first globstar, when that globstar sits right after the literal prefix (`<prefix>` + globstar + `<segment>` + ...). Returns `null` when there's no such globstar, the next segment is itself a wildcard, or the globstar is trailing (`<prefix>` + globstar alone still matches everything under it — deliberately ambiguous).
- `disjointAfterSharedGlobstar(a, b)`: `true` only when both patterns share the exact same literal prefix (not just nesting) AND both have a literal next-segment AND those segments differ. Any other shape (unequal-but-nesting prefixes, an ambiguous next segment) stays conservative.

`entriesCollide`'s fallback now additionally requires `!disjointAfterSharedGlobstar(a, b)` before declaring a collision. The general "literal prefixes nest" fallback is unchanged for every other shape — this is a narrow, provable carve-out, not a general glob-intersection solver.

## What changed & where

| Layer | Changed? | Notes |
| --- | --- | --- |
| API | No | — |
| CLI | No | — |
| Dashboard | No | — |
| Harness | No | — |
| Scheduler / scope | **Yes** | `app/src/dag.ts` — two new pure helpers, one added condition in `entriesCollide`'s fallback |
| Tests | **Yes** | `app/test/footprint-globstar.test.ts` (+4 cases) |
| Docs | **Yes** | This bundle; `2026-08-10/footprint-globstar/README.md` Deferred section updated |

## Validation

- Manual: confirmed the pre-fix bug directly (`footprintsCollide(["app:src/app/**/perfil/**"], ["app:src/app/**/billing/**"])` returned `true` before the change).
- Unit: `app/test/footprint-globstar.test.ts` — disjoint literal-segment case, near-miss literal case (`perfil` vs `perfil-extra`), the still-conservative bare-trailing-globstar case, and the still-conservative nesting-but-unequal-prefix case. All 4 pre-existing tests in the same file continue to pass unchanged (none of them exercise this fallback branch — they resolve via the earlier `isWithinFootprint`/witness-path checks or via unequal, non-nesting prefixes).
- `bun test` (226/226) and `bun run typecheck` pass for the full suite.

## Deferred

- None — this was itself the deferred item from the prior bundle. No further glob-intersection generalization planned; the narrow carve-out covers the reported real-world shape.
