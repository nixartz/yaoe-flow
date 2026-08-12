---
type: "Feature Spec"
title: "Auto-cut a release on every merge to main"
description: "New auto-release.yml workflow runs scripts/release.ts on push to main (skipped when CHANGELOG [Unreleased] is empty) and calls release.yml as a reusable workflow to build/verify/publish, instead of an operator running the release script by hand."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, ci, release, github-actions]
timestamp: "2026-08-11T00:00:00Z"
---

# Auto-cut a release on every merge to main

## Issues / PRs

- Operator request: releases were 100% manual (`bun scripts/release.ts` run by hand per [CONTRIBUTING.md](../../../CONTRIBUTING.md#cutting-a-release)) — trigger the same mechanism automatically whenever a PR merges into `main`.

## What changed

### New: `.github/workflows/auto-release.yml`

Triggered on `push: branches: [main]` (fires for any PR merge, squash, or rebase-merge into `main`, and for a direct push). Two guards keep it from firing where it shouldn't:

- **Empty `[Unreleased]` → skip, not fail.** Not every merge should ship (docs/chore/etc. PRs conventionally leave `CHANGELOG.md`'s `[Unreleased]` section empty). A job-level `if` on the downstream `release` job checks a gate step's output.
- **Its own release commit → skip.** The job's `if` checks `github.event.head_commit.message` does not start with `release: v` (the commit shape `scripts/release.ts` produces), so the bump commit it pushes to `main` cannot loop back into itself. This is defense-in-depth, not the actual loop-prevention mechanism — see below.

**Bump kind**: defaults to `patch`. Looks up the PR number from the merge/squash commit message (`grep -oE '#[0-9]+'`) and reads that PR's labels via `gh pr view`; `release:major` or `release:minor` on the PR overrides the default. Both labels were created in the repo (`gh label create`) as part of this change — without them the override has nothing to read and every auto-release is a patch bump.

**Mechanics**: checks out `main` with `fetch-depth: 0`, force-checks out a local `main` branch (`git checkout -B main` — `actions/checkout` leaves a detached HEAD, and `scripts/release.ts` asserts it is running on `main`/`master` the same way it would for a human operator), then runs `bun scripts/release.ts --<kind> --yes --no-wait --no-pr` as the `github-actions[bot]` identity. This is the *exact same script* the manual flow uses — it bumps `app/package.json` + `dashboard/package.json`, promotes `[Unreleased]` into a dated section, runs `bun test`, commits `release: vX.Y.Z`, creates an annotated tag, and pushes both.

**Manual trigger (`workflow_dispatch`, added during the fix-only follow-up below)**: same job, invocable on demand (`gh workflow run auto-release.yml` or the Actions UI "Run workflow" button) without waiting for a push-to-main event — useful for landing/testing a fix to this workflow itself, or re-running after a failed cut, without opening a throwaway PR. GitHub only exposes manual dispatch for a workflow whose `workflow_dispatch` trigger already exists on the *default* branch, so this still requires the workflow file to reach `main` once (a direct fast-forward push is fine — no PR strictly required). A `bump` choice input (`auto`/`patch`/`minor`/`major`, default `auto`) lets a manual run skip the PR-label lookup entirely (there's no merge commit to read labels from when triggered by hand) and pick the kind directly; the job-level `if` guard was also tightened to `github.event_name != 'push' || !startsWith(...)` so it no longer relies on `github.event.head_commit` being null-safe for non-push events.

### Changed: `.github/workflows/release.yml`

Added a `workflow_call` trigger alongside the existing `push: tags: ["v*"]`, with `version` (required) and `ref` (optional) inputs. `auto-release.yml` calls it directly (`uses: ./.github/workflows/release.yml`) instead of relying on its own tag push to retrigger `release.yml`'s `on: push: tags` — **a push made with the default `GITHUB_TOKEN` does not trigger other workflow runs**, by GitHub's own loop-prevention design, so that path would have silently never fired. Calling the reusable workflow directly sidesteps the issue entirely (no PAT/deploy-key secret needed). The `build` and `release` jobs' checkout steps now use `ref: ${{ inputs.ref || github.ref }}` (falls through to the tag ref on a normal tag push, unchanged for that path), and the version step accepts `inputs.version` as an override to deriving it from `GITHUB_REF_NAME`.

The manual flow (`bun scripts/release.ts` run locally, real `git push` of the tag from an operator's machine) is untouched — that push is not GITHUB_TOKEN-authored, so it still fires `release.yml`'s `push: tags` trigger normally.

### New GitHub labels

- `release:minor` — merge bumps MINOR instead of the default PATCH.
- `release:major` — merge bumps MAJOR instead of the default PATCH.

### Layers

| Layer | Changed? |
| --- | --- |
| API | No |
| CLI | No |
| Dashboard | No |
| CI | Yes — new workflow + `release.yml` gains a second trigger path |
| Docs | No (CONTRIBUTING.md's manual flow still works and is still the documented fallback) |

## FLOW

1. PR merges into `main` (any merge strategy) → `push` event on `main`.
2. `auto-release.yml` runs: if `[Unreleased]` is empty, it stops after logging a `::notice::` and does nothing else.
3. If non-empty: reads the merged PR's labels for `release:major`/`release:minor` (default `patch`), runs `scripts/release.ts` to bump, promote the changelog, commit, tag, and push.
4. Calls `release.yml` (reusable) with the new version/tag — same build → verify → publish pipeline as a manual release, ending in a published GitHub Release with binaries.

## Validation

- `actionlint .github/workflows/release.yml .github/workflows/auto-release.yml` (installed via `brew install actionlint` for this check): 0 findings on both files.
- `Bun.YAML.parse()` on both files: parses cleanly (caught and fixed one real bug this way — see below).
- Live run on the real repo (after PR #1 merged to `main`, [run 31549827172](https://github.com/nixartz/yaoe-flow/actions/runs/31549827172)): failed at the `cut` job's test step — see below. No CI harness or dry-run substitute catches this class of bug; only an actual push-to-main trigger does, since it's specifically about a step ordering gap in the job's own environment setup, not the workflow's YAML/expression correctness (which the earlier static checks do cover).

## Bugs found in validation

- **Unquoted `${{ }}` expression containing a colon broke YAML parsing.** `if: ${{ !startsWith(github.event.head_commit.message, 'release: v') }}` — the colon-space inside the single-quoted `'release: v'` literal, even though nested inside the expression, made YAML's flow-scalar parser treat it as the start of a nested mapping (`BLOCK_AS_IMPLICIT_KEY`). This is the well-known GitHub Actions gotcha where any `${{ }}` value containing a colon must have the *whole* value quoted. Fixed by wrapping the entire `if:` value in double quotes. Caught by `Bun.YAML.parse()` before ever reaching GitHub — `yaml`-parseable but semantically-invalid syntax would otherwise only surface as a workflow failing to even start.
- **`cut` job never installed `app/`'s dependencies before `scripts/release.ts` ran `cd app && bun test`.** The job only ran `oven-sh/setup-bun@v2` (the Bun runtime, not project deps) before invoking the release script — unlike `release.yml`'s own `build` job, which always runs `bun install --frozen-lockfile` in `app/` before touching anything that imports app code. Every test file that imports a package (`drizzle-orm`, `pino`, ...) failed with `error: Cannot find package '...'`; a couple of pure-logic test files with no such imports still passed, which is what made the failure read as "some tests failing" rather than an obviously-missing setup step. **Not caught by any of the static validation above** — `actionlint` and YAML parsing check the workflow's own syntax, not whether the steps it runs will actually have their runtime dependencies present; only a real push-to-main trigger surfaced it. Fixed by adding an explicit `bun install --frozen-lockfile` step (working-directory `app`) between `setup-bun` and the bump-kind/cut steps, gated on the same `steps.gate.outputs.empty == 'false'` condition as the rest of the non-trivial steps. No release was actually cut by the failed run — `scripts/release.ts` runs tests *before* bumping/committing/tagging/pushing, so `main` and the tag list were left untouched; confirmed via `git fetch` + `git ls-remote --tags` immediately after.

## Deferred

- The `cut` job's env now mirrors `release.yml`'s `build` job (`bun install --frozen-lockfile` in `app/`) but has not yet had its own full successful live run watched end-to-end (a fix-only PR is expected to exercise it next, since `main`'s `[Unreleased]` already has content pending).
- `act` (local GitHub Actions runner) is not installed here; a full local dry-run of `auto-release.yml` was not attempted, only static validation (`actionlint`, YAML parse) plus the live run above.
- Rebase-merged PRs whose commits don't carry `(#123)` in the message (rare, only when a contributor manually rebase-merges without GitHub's own button) fall back to a `patch` bump silently, since the PR-number lookup fails — acceptable degraded behavior, not treated as an error.
