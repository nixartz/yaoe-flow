---
type: "Bug Fix"
title: "Release must bake a fresh dashboard SPA; stop committing SPA embeds"
description: "Hard-fail release embed if dashboard/dist is empty; keep EMBEDDED_DASHBOARD_ASSETS empty in git; gitignore dashboard/dist explicitly."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, release, dashboard, embed-assets, ci]
timestamp: "2026-08-10T00:00:00Z"
---

# Release must bake a fresh dashboard SPA

## Issues / PRs

- (local) Operator report: GitHub tag releases shipped an outdated dashboard UI.

## Root cause

`app/src/embedded-assets.generated.ts` was committed with a full base64 SPA (~1.8 MB). The release workflow already ran `dashboard build` → `embed-assets` → compile, but:

1. A failed/empty embed only **warned**, so a bad/missing `dashboard/dist` could still produce a binary that fell back to the **stale committed** SPA from checkout.
2. Reviewers could not tell SPA freshness from git diffs of hashed Vite assets buried in the generated file.

## What changed

### Release workflow (`.github/workflows/release.yml`)

1. Build dashboard SPA and assert `dist/index.html` exists.
2. `bun run embed-assets -- --require-dashboard` (exit 1 if 0 SPA assets).
3. Explicit verify step: `EMBEDDED_DASHBOARD_ASSETS` must include `index.html`.
4. Then cross-compile.

### embed-assets (`app/scripts/generate-embedded-assets.ts`)

- `--require-dashboard` — CI/release/install-local.
- `--no-dashboard` — commit stub shape (migrations/SOULs only, SPA `{}`).

### Git / CI

- Root `.gitignore` explicitly lists `dashboard/dist/` (+ `dist-ssr/`).
- Committed embed regenerated with **0** SPA assets.
- CI asserts the stub stays empty.

### Layers

| Layer | Changed? |
| --- | --- |
| API / Dashboard SPA code | No |
| Release / CI / scripts | Yes |
| Committed embed stub | Yes — SPA stripped |

## Deferred

- Split migrations vs SPA into two generated files (optional clarity).
