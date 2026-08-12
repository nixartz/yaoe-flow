---
type: "Feature Spec"
title: "release.ts: wait for the publish + auto-open a merge-back PR"
description: "bun scripts/release.ts now polls gh release view (bounded) after pushing the tag and, when the release was cut off-main, opens a PR back into main — both best-effort and skippable (--no-wait / --no-pr)."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, release, scripts, gh-cli]
timestamp: "2026-08-11T00:00:00Z"
---

# release.ts: wait for the publish + auto-open a merge-back PR

## Issues / PRs

- Both items from `knowledge/changes/2026-08-10/release-script/README.md`'s Deferred section: "`gh release view` / wait-for-workflow polling after push" and "Auto-opening a PR when not on `main` (currently `--allow-branch` only)". No Linear issue — picked directly from that bundle's Deferred section at the user's request.

## Problem

`bun scripts/release.ts` pushed the branch + tag and stopped — the operator had to manually watch GitHub Actions to know whether the cross-compile/checksum/publish workflow actually succeeded, and if the release was cut from a non-`main` branch (`--allow-branch`, e.g. hotfixing off a release branch), nothing brought the version bump + CHANGELOG promotion commit back into `main` — that merge had to be remembered and done by hand.

## What changed

### `scripts/release.ts`

- New flags: `--no-wait` (default: wait) and `--no-pr` (default: open a PR when off-main), both documented in `--help` and reflected in the "Release plan" printout's new `post-push:` line.
- New pure/testable functions:
  - `pollReleasePublished(tag, opts)` — bounded poll of `gh release view <tag> --json url` (default 10 attempts, backoff `min(2s × attempt, 20s)`, both injectable via `opts` for testing). Stops as soon as a response includes a `url`; gives up after the attempt budget instead of hanging indefinitely — the release workflow can take several minutes, so a timeout is an expected, not exceptional, outcome. `viewFn`/`sleepMs` are injectable so the test suite never shells out to a real `gh` or waits in real time.
  - `repoSlugFromRemote(remoteUrl)` — parses `org/repo` out of either the SSH (`git@github.com:org/repo.git`) or HTTPS (`https://github.com/org/repo[.git]`) origin URL shape, used to print a "check the Actions tab" link when polling times out.
  - `tryOpenReleasePr(branch, tag)` (internal, not exported — it shells out directly like the existing `git()`/`run()` helpers) — `gh pr create --base main --head <branch> --title "release: vX.Y.Z" --body ...`; any failure (no `gh`, not authenticated, PR already exists) is caught and reported as a manual fallback command, never as a script failure.
- Wired into `main()`, after the existing push block, only when `args.push` is true (nothing to poll or PR against without a push):
  1. Probe `gh --version`; if missing, print a one-line note (with the install URL) and skip both steps entirely — this was already an optional dependency for the release workflow (Actions runs `gh`-free), so its absence locally must not fail the script.
  2. If `--no-wait` wasn't passed: poll for the release to publish; on success print the release URL, on timeout print the repo's Actions URL instead of hanging.
  3. If `--no-pr` wasn't passed **and** the branch isn't `main`/`master` (i.e., this release was only reachable via `--allow-branch` in the first place): attempt to open the merge-back PR; on any failure, print the exact `gh pr create` command to run by hand.

### Layers

| Layer | Changed? |
| --- | --- |
| Scripts | Yes — `scripts/release.ts` |
| Tests | Yes — `app/test/release-script.test.ts` (new cases, same file/pattern as the existing release-script unit tests) |
| API / CLI / Dashboard / Harness | No |

## FLOW

**Normal release from `main`, `gh` installed**: `bun scripts/release.ts` → version bump, CHANGELOG promotion, commit, tag, push (unchanged) → `gh --version` succeeds → polls `gh release view vX.Y.Z` every couple seconds (capped backoff) until the workflow's `softprops/action-gh-release` step creates the release, then prints its URL → branch is `main`, so the PR step is skipped (nothing to merge back).

**Hotfix release cut from a branch (`--allow-branch`)**: same as above, but after publish-polling, since `branch !== "main"`, opens `gh pr create --base main --head <branch> --title "release: vX.Y.Z"` so the version bump/CHANGELOG commit isn't left stranded off `main`.

**`gh` not installed**: push succeeds exactly as before this change; a one-line note explains both post-push steps were skipped and how to get `gh`. The release itself is unaffected — GitHub Actions builds and publishes it regardless of whether the local machine has `gh`.

**Workflow slower than the poll budget**: after ~10 bounded attempts (well under the workflow's own 10-minute timeout), polling gives up and prints the repo's `/actions` URL instead of blocking the terminal indefinitely — the operator checks manually, the script still exits normally (not an error).

**PR already exists / not authenticated**: `tryOpenReleasePr` fails, `gh`'s stderr is captured and shown alongside a copy-pasteable manual `gh pr create` command — the release script's own exit code is unaffected (the release itself already succeeded by this point).

## Validation

- `bun test` (260 pass, 0 fail, up from 254) — 6 new cases in `app/test/release-script.test.ts`: `parseArgs` default/`--no-wait`/`--no-pr` flag flips; `repoSlugFromRemote` for SSH/HTTPS-with-.git/HTTPS-without-.git/non-GitHub-host; `pollReleasePublished` — succeeds on first call, retries then succeeds, exhausts its bounded attempts and reports `published:false` (proving it does NOT hang forever), and treats malformed JSON from `gh` as not-yet-ready rather than crashing. All four `pollReleasePublished` cases inject `sleepMs: () => 0` so the test suite doesn't actually wait — network/time-free per `AGENTS.md`.
- `bun run typecheck` — clean.
- Manual runs (this repo, real `gh` 2.92.0 installed and authenticated):
  - `bun scripts/release.ts --help` — new `--no-wait`/`--no-pr` flags documented correctly.
  - `bun scripts/release.ts --dry-run --allow-branch --allow-dirty --allow-empty` — "Release plan" prints `post-push:  wait for publish: yes, open PR if off-main: yes`.
  - Same command + `--no-wait --no-pr --no-push` — prints `post-push:  n/a (--no-push)`, confirming the post-push line correctly reflects `--no-push` short-circuiting the whole block regardless of the wait/pr flags.
  - No real release was cut during this validation (dry-run only — a real run would push a tag and trigger CI).

## Deferred

None carried forward from this bundle — both items from the `release-script` bundle's Deferred section are now shipped.
