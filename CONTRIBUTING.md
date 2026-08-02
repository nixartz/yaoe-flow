# Contributing to YAOE-FLOW

Everything you need to run the project locally, modify it, and ship a PR.

## Summary

- [Prerequisites](#prerequisites)
- [Run locally (dev loop)](#run-locally-dev-loop)
- [Modify the dashboard](#modify-the-dashboard)
- [Build & install a local binary](#build--install-a-local-binary)
- [Tests and checks](#tests-and-checks)
- [PR flow](#pr-flow)
- [Cutting a release](#cutting-a-release)

## Prerequisites

- [Bun](https://bun.sh) (runtime, package manager, test runner, compiler)
- git
- A local Valkey or Redis (`brew install valkey` / `docker run -p 6379:6379
  valkey/valkey:8-alpine`)

## Run locally (dev loop)

```bash
git clone https://github.com/nixartz/yaoe-flow.git
cd yaoe-flow/app
bun install
bun dev          # watch mode: API :4790 + dashboard API/SPA :4791
```

Dev mode uses the same home as the installed binary — `~/.yaoe-flow` — so your
wizard-created config/database work in both. To experiment against a throwaway
home: `YAOE_HOME=/tmp/yaoe-dev bun dev`.

First time? Run the wizard once: `bun src/index.ts setup`.

Useful dev scripts (in `app/`): `bun run start:debug` (inspector),
`bun run log` (pretty pino), `bun run seed:demo` (demo data),
`bun run test:smoke` (manual smoke against a REAL harness — costs tokens, see
`sandbox/README.md`).

## Modify the dashboard

```bash
cd dashboard
bun install
bun run dev      # Vite dev server with hot reload, proxying the API
```

Conventions live in [DESIGN.md](DESIGN.md) (tokens, components, UI rules) —
notably: all data via TanStack Query in `src/lib/api.ts`, Tabler icons,
badge opacity patterns.

To ship a new dashboard build inside the binary: nothing special — the build
scripts run `bun run build` + `bun run embed-assets` for you (next section).
If you only changed the SPA and want to refresh the embedded copy manually:

```bash
cd dashboard && bun run build
cd ../app && bun run embed-assets
```

## Build & install a local binary

From the repo root:

```bash
bun scripts/build-and-install.ts        # or: yaoe-flow install-local
```

This builds the SPA, embeds migrations/SOULs/SPA, cross-compiles for your
platform and installs `~/.local/bin/yaoe-flow` (override `--dir` /
`YAOE_INSTALL_DIR`), printing the exact install path at the end.

## Tests and checks

```bash
cd app
bun test               # unit + ACP contract suite (mock agent — no LLM cost)
bun run typecheck
cd ../dashboard
bunx tsc -b            # frontend typecheck
```

Gotcha: **after adding a Drizzle migration or editing a SOUL, run
`bun run embed-assets`** — dev/tests read migrations from the embedded bundle,
not from disk (see `knowledge/rules/migrations-and-embedded-assets.md`).

## PR flow

1. Branch from `main` (`main` is protected — no direct pushes).
2. Implement following [AGENTS.md](AGENTS.md) and `knowledge/rules/`.
3. For every feature/fix set, add:
   - an OKF bundle in `knowledge/changes/<yyyy-MM-dd>/<change-name>/`
     (kebab-case) — see AGENTS.md for the required content;
   - a `CHANGELOG.md` entry under `[Unreleased]` (keepachangelog categories);
   - README/docs updates when the change is visible to users.
4. Make CI green: `bun test` + typechecks + gitleaks run on every PR.
5. Open the PR with an English description; squash-merge after review.

## Cutting a release

1. Move the `[Unreleased]` section of `CHANGELOG.md` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section; bump `version` in `app/package.json`.
2. Merge that to `main`, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The [release workflow](.github/workflows/release.yml) cross-compiles
   Linux/macOS/Windows (x64+arm64 where supported), verifies each binary runs
   on its real platform, and publishes a GitHub Release using the CHANGELOG
   section as the body.
