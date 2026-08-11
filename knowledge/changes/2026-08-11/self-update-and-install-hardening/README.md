---
type: "Feature Spec"
title: "yaoe-flow update atomic self-swap + glibc probe in install.sh"
description: "`yaoe-flow update` now downloads, verifies, and atomically replaces the running binary instead of just printing instructions; install.sh warns loudly (advisory only) when the host's glibc is too old for the compiled binary."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, cli, install, release, self-update]
timestamp: "2026-08-11T00:00:00Z"
---

# yaoe-flow update atomic self-swap + glibc probe in install.sh

## Issues / PRs

- Two items from `knowledge/product/roadmap.md`: "`yaoe-flow update` atomic self-swap" and "glibc version probing in `install.sh`". No Linear issue — picked directly from the roadmap doc at the user's request.

## Problem

`yaoe-flow update` only ever checked the latest release tag and printed "re-run the install one-liner" — no actual update happened from the command itself. Separately, `install.sh` never checked the host's glibc version before installing a Bun-compiled binary that requires glibc ≥ 2.17; on an old/musl distro the binary would fail at first launch with an opaque dynamic-linker error, with nothing in the installer output hinting at the real cause.

## What changed

### `yaoe-flow update` atomic self-swap (`app/src/cli/selfUpdate.ts`, `app/src/cli/update.ts`, `app/src/cli/index.ts`)

- New pure/testable module `app/src/cli/selfUpdate.ts`:
  - `detectAssetName(os, arch, avx2)` — mirrors `install.sh`'s `asset="yaoe-flow-$os-$arch"` (+ `-baseline` for x64 without AVX2) and `install.ps1`'s `.exe` variant (baseline suffix inserted before `.exe`, not appended after).
  - `detectAvx2()` — same three platform probes as the shell installers: Linux reads `/proc/cpuinfo` for `avx2`, macOS spawns `sysctl -n machdep.cpu.leaf7_features`, Windows runs the same `IsProcessorFeaturePresent(17)` Win32-API PowerShell probe as `install.ps1`'s `Test-Avx2Supported`. Any probe failure assumes a modern CPU (matches install.sh's "unknown probe → assume modern").
  - `verifyChecksum(filePath, expectedSha256)` — SHA256 via `node:crypto`, case-insensitive compare.
  - `extractExpectedSha(sums, asset)` — parses the `<hash>  <filename>` SHA256SUMS format (also handles the `*filename` binary-mode marker some `sha256sum` builds emit), matching on the exact asset name so `yaoe-flow-linux-x64` and `yaoe-flow-linux-x64-baseline` are never confused.
  - `atomicReplace(targetPath, newFileTmpPath)` — POSIX: same-directory `renameSync` (atomic; a process that already exec'd the old inode keeps running against it). Windows: best-effort `rename(target → target.old)` then `rename(tmp → target)`, since a running `.exe` can hold its file locked; failure throws so the caller can print a manual fallback instead of silently doing nothing.
  - `isCompiledBinaryInvocation(argv1)` — same `$bunfs` heuristic already used by `paths.ts`'s `daemonStartArgv`, extracted here as a pure function of `argv1` so it's testable without touching `process.argv`.
- `cmdUpdate(flags)` rewritten: refuses immediately (exit 1) if not invoked from a compiled binary (`bun run`/dev has no binary file to replace); fetches the latest release; without `--force`, exits early if already on the latest version; otherwise downloads the platform asset + `SHA256SUMS` to a temp dir, verifies the checksum, copies the verified file next to the running binary under a `.yaoe-flow-update-<pid>` staging name, `chmod 0o755`, and `atomicReplace`s it over `process.execPath`. Never touches the running binary before the checksum passes.
- New `--force` flag (`flagBool(flags, "force")`, same convention as `stop.ts` — no short alias): re-downloads and re-installs even when already on the latest version, for repairing a corrupted binary.
- `app/src/cli/index.ts` help text updated for `update [--force]`; the `update` case now passes `flags` through (previously called with no arguments).

### glibc probe in `scripts/install.sh`

- Linux-only, right after the existing `has_avx2()` AVX2 block, before release-tag resolution: reads `getconf GNU_LIBC_VERSION` (falls back to parsing `ldd --version`'s first line), and if `< 2.17`, prints a loud warning **before downloading** naming the exact symptom ("this binary will likely fail to start with a dynamic-linker error, not a normal error message") and that musl distros (Alpine, Void) aren't supported by this installer. Advisory only — the install proceeds regardless, since (unlike AVX2) there is no fallback binary variant to switch to. `YAOE_SKIP_GLIBC_CHECK=1` silences it, mirroring the existing `YAOE_FORCE_BASELINE` precedent. If the version can't be determined at all, prints an informational (not alarming) note and proceeds.
- `scripts/install.ps1`: no functional change — added a one-line comment explaining why there's no equivalent check (glibc is a Linux libc concept, doesn't apply to Windows).

### Windows self-swap limitation (documented, not solved)

`atomicReplace` on Windows can fail if the running `.exe`'s file is locked by the OS. This is a genuine best-effort limitation: `cmdUpdate` catches the failure, leaves the verified-but-not-installed download in place conceptually (the staged temp file is removed, but nothing is lost — re-running `yaoe-flow update` re-downloads), and prints an explicit instruction to `yaoe-flow stop` first and retry. Not attempting a more invasive workaround (e.g. a spawned helper process) — out of scope for this change, and the failure mode is safe (verified download discarded, old binary untouched) rather than silent or corrupting.

### Layers

| Layer | Changed? |
| --- | --- |
| CLI | Yes — `update` command rewritten, `--force` flag, help text |
| Install scripts | Yes — glibc probe in `install.sh`, comment-only note in `install.ps1` |
| API / Dashboard | No |
| Scheduler | No |

## FLOW

**Normal update** (compiled binary, newer release available): `yaoe-flow update` → prints current version → fetches `GET /repos/{repo}/releases/latest` → latest tag ≠ current version → downloads `yaoe-flow-{platform}[-baseline]` + `SHA256SUMS` to a temp dir → verifies the SHA256 → stages the verified file next to the running binary → atomically renames it over `process.execPath` → prints success + a reminder to restart any running daemon (`yaoe-flow stop && yaoe-flow daemon -d`) so the swapped file actually takes effect for a live process.

**Already latest, no `--force`**: same flow up through the tag fetch, then exits immediately with "already on the latest version." — no download, no filesystem writes.

**`--force` repair**: same as normal update but proceeds even when the latest tag matches the current version — re-downloads and re-verifies the same-version asset and replaces the binary, for repairing a corrupted install without bumping a version.

**Dev-mode refusal**: `bun run src/index.ts update` (or any invocation where `process.argv[1]` isn't Bun's `$bunfs` virtual path) → `isCompiledBinaryInvocation` returns false → prints a clear refusal and exits 1 before any network call, since there is no binary file on disk to replace.

**Checksum mismatch (tampered or corrupted download)**: download succeeds, but the computed SHA256 doesn't match the `SHA256SUMS` entry → aborts with "checksum mismatch — aborting (nothing replaced)." and exit 1 — the running binary is never touched.

**glibc too old (`install.sh`, Linux only)**: before downloading anything, prints a warning naming the exact future symptom and the musl caveat, then proceeds with the install anyway (advisory, no fallback build exists).

## Validation

- `bun test` (254 pass, 0 fail, up from 240) — new `app/test/self-update.test.ts` (14 tests, no network): `detectAssetName` (all four `{os}×{avx2}` shapes incl. windows `.exe`/baseline-before-extension), `splitPlatformTriple`, `extractExpectedSha` (exact match, baseline-vs-non-baseline disambiguation, `*filename` marker, not-found → null), `verifyChecksum` (correct/case-insensitive/wrong), `atomicReplace` (existing target, and target-doesn't-exist-yet), `isCompiledBinaryInvocation` (bunfs paths on POSIX and the Windows `$bunfs`-embedded-in-backslash-path variant, dev script path, undefined).
- `bun run typecheck` — clean.
- `bash -n scripts/install.sh` — clean; manually exercised the glibc major/minor comparison logic in isolation (simulated `2.12` → triggers the warning, `2.31` → doesn't) since this dev machine is macOS and can't naturally produce an old-glibc `getconf` result.
- **Manual end-to-end run of the actual `cmdUpdate` control flow** (not just the isolated pure functions) against a local `Bun.serve` fake standing in for the GitHub API and release-asset URLs (`fetch` monkey-patched to redirect `api.github.com`/`github.com/.../releases/download/...` requests to it), a temp file standing in for `process.execPath`, and `process.argv[1]` set to a `$bunfs` path:
  1. Normal update (fake latest tag newer than dev's `package.json` version) → binary content replaced with the fake release's bytes, success message printed.
  2. Same fake tag as the current version, no `--force` → "already on the latest version.", file **untouched** (verified by a sentinel string still present after the call).
  3. Same version, `--force` → re-downloaded and replaced anyway (repair path).
  4. `argv[1]` pointed at a real dev script path (not `$bunfs`) → refused immediately, correct exit code, no network call attempted.
  5. `SHA256SUMS` served with a hash that doesn't match the asset bytes → "checksum mismatch — aborting", file **untouched** (sentinel still present), exit code 1.
  All five scenarios behaved exactly as designed; script discarded after the run (scratch-only, not committed).

## Deferred

- A more robust Windows self-swap (e.g. a spawned helper process that waits for the parent to exit before renaming) — the current best-effort rename-with-fallback-message is judged sufficient; revisit only if real-world reports show the lock actually triggers often enough to matter.
- musl-libc Linux builds (Alpine, Void) — the glibc probe is advisory-only precisely because no such build exists in the release matrix; adding one is a separate, larger change (new Bun build target, new release-matrix entry, new asset-naming convention) out of scope here.
