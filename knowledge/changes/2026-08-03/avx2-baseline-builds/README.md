---
type: "Feature Spec"
title: "AVX2 baseline binary builds"
description: "Fixed compiled binaries crashing with 'Illegal instruction' on x64 CPUs older than 2013 by publishing -baseline variants and auto-detecting which one to install."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, release, install, bugfix]
timestamp: "2026-08-03T00:00:00Z"
---

# AVX2 baseline binary builds

**Date:** 2026-08-03. **Version:** 0.1.1 (patch release off 0.1.0).

## Summary

- [The bug](#the-bug)
- [The fix](#the-fix)
- [What changed and where](#what-changed-and-where)
- [Dependency audit (why nothing else changed)](#dependency-audit-why-nothing-else-changed)
- [Deliberately deferred](#deliberately-deferred)

## The bug

A user installed `yaoe-flow` via `install.sh` on an Ubuntu 24.04 x64 server running on a Mac Mini with an Intel Core i7-3xxx (Ivy Bridge, 2012). The install succeeded (correct checksum, correct binary), but every invocation — `yaoe-flow`, `yaoe-flow daemon`, `yaoe-flow setup` — crashed instantly with `Illegal instruction (core dumped)`, before printing anything.

Root cause: `bun build --compile --target=bun-linux-x64` (and the equivalent darwin-x64/windows-x64 targets) compiles Bun's SIMD-optimized codepaths assuming AVX2 support, which only became standard with Intel Haswell (2013) and later CPUs. Any x64 CPU older than that — Ivy Bridge, Sandy Bridge, Nehalem, and further back — executes an unsupported instruction the moment the binary starts, which the kernel reports as SIGILL. There was no diagnostic path for this: the crash happens before the binary can print an error, and `yaoe-flow doctor` can't help either, since `doctor` is a subcommand of the very binary that can't start.

## The fix

Bun ships a `-baseline` variant of each x64 compile target (`bun-linux-x64-baseline`, `bun-darwin-x64-baseline`, `bun-windows-x64-baseline`) built against Nehalem (2008+) instead of Haswell — no AVX2 required, marginally slower. arm64 has no such split (NEON is baseline on all arm64 hardware Bun supports).

The release pipeline now builds and publishes all three baseline variants alongside the existing standard ones (6 x64 assets total, plus the 2 arm64 assets — 8 binaries per release instead of 5). `install.sh` and `install.ps1` probe the host CPU for AVX2 support and silently pick the matching asset; `YAOE_FORCE_BASELINE=1`/`0` overrides the auto-detection in both scripts for cases where the probe itself is unreliable (e.g. inside some VMs/containers that mask CPUID).

## What changed and where

| File | Change |
|---|---|
| [.github/workflows/release.yml](../../../../.github/workflows/release.yml) | Build step: 3 new `name:target` pairs (`linux-x64-baseline`, `darwin-x64-baseline`, `windows-x64-baseline`). Smoke test step now runs both Linux x64 flavors on the build runner (a modern CPU, so this only proves the baseline binary itself isn't broken — not that it helps on an old CPU, which GitHub-hosted runners don't offer). Verify matrix: added `linux-x64-baseline` (ubuntu-latest) and `windows-x64-baseline` (windows-latest); `darwin-x64-baseline` is NOT verified for the same reason `darwin-x64` already wasn't (`macos-13` runner queue unreliable, and `macos-latest` is Apple Silicon — can't run x64 binaries without Rosetta, which these hosted runners don't have). |
| [scripts/install.sh](../../../../scripts/install.sh) | New `has_avx2()`: `grep -qm1 '\bavx2\b' /proc/cpuinfo` on Linux, `sysctl -n machdep.cpu.leaf7_features \| grep -qi avx2` on macOS. Appends `-baseline` to the asset name when AVX2 is absent (x64 only — skipped entirely on arm64). `YAOE_FORCE_BASELINE` env var overrides. |
| [scripts/install.ps1](../../../../scripts/install.ps1) | New `Test-Avx2Supported`: P/Invokes `kernel32!IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE=17)` — chosen over `[System.Runtime.Intrinsics.X86.Avx2]::IsSupported` because that type needs .NET Core and doesn't exist under Windows PowerShell 5.1 (the default on most Windows installs); the Win32 API works identically on both. If the probe itself fails (wrapped in try/catch, returns `$null`), the script assumes a modern CPU (matches prior behavior) and prints a hint to retry with `YAOE_FORCE_BASELINE=1` if that guess was wrong. |
| `app/package.json`, `dashboard/package.json` | Version bumped `0.1.0` → `0.1.1`. |
| `CHANGELOG.md` | New `[0.1.1]` section. |

## Dependency audit (why nothing else changed)

Before fixing just the AVX2 case, audited what else `yaoe-flow` needs from the host to run, in case there were other silent-crash classes worth fixing in the same pass:

- **Harness CLIs** (Claude Code, Cursor, Codex, Copilot, Goose): already fully handled by `yaoe-flow setup`'s `harnessDeps.ts` — probes with `which`, offers one-click install, manages its own PATH entry for daemon/systemd contexts.
- **Valkey/Redis**: already fully handled by the setup wizard's `stepValkey` (`app/src/cli/setup/steps.ts`) — pings, offers brew/apt/dnf/docker/manual install, and `yaoe-flow doctor` re-checks reachability with a fix hint.
- **git**: already checked in both `setup` and `doctor`, with a hard error and an OS-specific install hint if missing.
- **SQLite**: no external dependency — `bun:sqlite` is built into the Bun runtime, not a native npm module.
- **glibc version (Linux)**: NOT checked anywhere, and NOT fixed in this pass — see [Deliberately deferred](#deliberately-deferred). Distinct from the AVX2 issue (a dynamic-linker error, not SIGILL), lower observed likelihood (Ubuntu 24.04 and every mainstream distro from the last several years ship a new enough glibc), and no ready-made "baseline" build to fall back to the way Bun provides for AVX2.

Conclusion: AVX2 was the one real gap causing a silent, unexplained crash with no fallback available; everything else already has a guided remediation path.

## Deliberately deferred

- **glibc version probing in `install.sh`**: would need to actually compare `ldd --version` output against a minimum, with no baseline binary to fall back to if it's too old (unlike AVX2). Revisit if this is ever reported in practice.
- **Standalone troubleshooting doc**: `docs/` still has no single "my binary won't start" page; the AVX2 case is now documented only in `README.md`'s Install section and this OKF bundle. Worth a dedicated doc once there are 2-3 known failure classes to consolidate.
