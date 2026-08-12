---
type: "Feature Spec"
title: "Automated release script (bump, changelog, tag, push)"
description: "scripts/release.ts cuts a semver release: bump package.json versions, promote CHANGELOG Unreleased, commit, annotated tag, optional push to trigger GitHub Actions."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, release, scripts, changelog]
timestamp: "2026-08-10T00:00:00Z"
---

# Automated release script

## Issues / PRs

- (local) Operator request: automate the CONTRIBUTING “Cutting a release” flow (version bump, changelog, commit/push, tag).

## What changed

### Script — `scripts/release.ts`

- Default `--patch` bump, or `--minor` / `--major` / exact `0.2.0`.
- Promotes `CHANGELOG.md` `[Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`.
- Bumps `app/package.json` and `dashboard/package.json`.
- Runs `bun test` (unless `--skip-tests`), commits `release: vX.Y.Z`, annotated tag, pushes branch + tag (unless `--no-push`).
- Guards: clean tree, `main`/`master`, non-empty Unreleased; overrides via `--allow-dirty` / `--allow-branch` / `--allow-empty`.
- `--dry-run` / `--yes` for preview and skipping the final proceed prompt.
- `--replace-tag` / interactive prompt: delete existing local+remote tag before recreating (republish broken releases). `--yes` alone does not delete tags.
- `bun scripts/release.ts 0.1.4 --replace-tag` can retag when package.json is already at that version.

### Docs / npm

- `CONTRIBUTING.md` documents the script as the preferred path.
- `app/package.json` script `release` → `bun ../scripts/release.ts`.

### Layers

| Layer | Changed? |
| --- | --- |
| API / CLI / Dashboard / Harness | No |
| Scripts / CI docs | Yes |
| Tests | Yes — pure helpers in `app/test/release-script.test.ts` |

## Deferred

- ~~`gh release view` / wait-for-workflow polling after push.~~ — shipped: [knowledge/changes/2026-08-11/release-script-polling-and-pr](../../2026-08-11/release-script-polling-and-pr/README.md).
- ~~Auto-opening a PR when not on `main` (currently `--allow-branch` only).~~ — shipped: [knowledge/changes/2026-08-11/release-script-polling-and-pr](../../2026-08-11/release-script-polling-and-pr/README.md).
