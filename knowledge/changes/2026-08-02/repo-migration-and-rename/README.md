---
type: "Feature Spec"
title: "Repo extraction, rename to YAOE-FLOW and 0.1.0 cleanup"
description: "Migration from the nixartz/ai-agents monorepo to nixartz/yaoe-flow with fresh history, full rename, legacy cleanup, setup wizard revamp, MCP presets and release pipeline."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, migration, rename, cli, dashboard, ci, docs]
timestamp: "2026-08-02T00:00:00Z"
---

# Repo extraction, rename to YAOE-FLOW and 0.1.0 cleanup

**Date:** 2026-08-02 · **Release:** v0.1.0 (initial commit — fresh history by design; the previous history lives in the private `nixartz/ai-agents` monorepo).

## Summary

- [What changed and where](#what-changed-and-where)
- [Rename map](#rename-map)
- [New 0.1.0 behaviors](#new-010-behaviors)
- [Cleanup report (what was removed and why)](#cleanup-report-what-was-removed-and-why)
- [Security notes](#security-notes)
- [Deliberately deferred](#deliberately-deferred)

## What changed and where

| Layer | Changed? | What |
|---|---|---|
| CLI | ✅ | Full English rewrite; setup gate on `daemon`; first-run wizard + navigable menu; new naming |
| Backend (`app/src`) | ✅ | Bootstrap/home layout, `WORKSPACE_ROOT`, registry translated + `AGENT_OUTPUT_LANGUAGE`, legacy fallbacks removed |
| Dashboard | ✅ (surgical) | MCP preset picker in `McpServersEditor`; `descriptionPtBr`→`description` field rename; rest of the SPA untouched |
| Recipes/SOUL protocol | ✅ | Hard-coded PT-BR/Infleux language rule replaced by the configurable `{{OUTPUT_LANGUAGE}}` |
| CI | ✅ | New `ci.yml` (tests + gitleaks) and `release.yml` (tag `v*` → cross-compile, verify, release with CHANGELOG body) |
| Install scripts | ✅ | English rewrite, update-in-place detection, executable-location echo, uninstall instructions |
| Docs | ✅ | New English set (README, guides, CONTRIBUTING, SECURITY, knowledge/); Portuguese docs not migrated |
| DB schema | ❌ | No migrations added — schema untouched |
| Scheduler/locks/scope-check | ❌ | Pipeline semantics untouched (only string/name changes) |

## Rename map

Product identity: **YAOE-FLOW (Yet Another Orchestration Engine-Flow)**; executable and directories `yaoe-flow`; env prefix `YAOE_*`.

| Before | After |
|---|---|
| binary `orchestrator` / `orchestrator.exe` | `yaoe-flow` / `yaoe-flow.exe` |
| `~/.orchestrator` | `~/.yaoe-flow` (`YAOE_HOME`) |
| `ORCHESTRATOR_HOME/INSTALL_DIR/RELEASE_REPO/VERSION/COMMIT/DRY_RUN` | `YAOE_*` equivalents |
| release assets `orchestrator-<os>-<arch>`; tags `orchestrator-v*` | `yaoe-flow-<os>-<arch>`; tags `v*` |
| systemd `orchestrator.service`, launchd `dev.orchestrator.daemon`, schtasks `OrchestratorDaemon` | `yaoe-flow.service`, `dev.sims.yaoe-flow`, `YaoeFlowDaemon` |
| pid/log `orchestrator.pid` / `orchestrator.log` | `yaoe-flow.pid` / `yaoe-flow.log` |
| setting `GOOSE_WORKING_DIR` | `WORKSPACE_ROOT` (default `$YAOE_HOME/worktrees`) |
| registry field `descriptionPtBr` | `description` (English) |
| logger `service: "orchestration-service"` | `service: "yaoe-flow"` |

**Deliberately NOT renamed** (they name the *orchestrator agent role*, not the product): `ORCHESTRATOR_ENABLED`, `MAX_ORCHESTRATOR_WORKERS`, `GOOSE_ORCHESTRATOR_RECIPE`, `HERMES_ORCHESTRATOR_*`, the `orchestrator` SOUL/ recipe/role ids, `src/api/orchestrator/`.

## New 0.1.0 behaviors

1. **Setup gate** — `yaoe-flow daemon` refuses to start until the wizard has completed once (`YAOE_SETUP_COMPLETED_AT` marker in config.env). Pure-ENV deployments (Docker/K8s with `APP_ENCRYPTION_KEY` in the real environment) pass automatically (`bootstrap.encryptionKeyFromEnv`).
2. **Stable home** — `YAOE_HOME` defaults to `~/.yaoe-flow` in every mode (dev `bun --watch` and installed binary), so config/data/worktrees never fork.
3. **Worktrees under home** — run workspaces moved from the service cwd to `$YAOE_HOME/worktrees/run-<id>` (new `WORKSPACE_ROOT` setting).
4. **Install visibility** — installers and `build-and-install.ts` print the exact executable location; the wizard header always shows the resolved `YAOE_HOME` and config path.
5. **Wizard UX** — first run: guided steps with REQUIRED/OPTIONAL marking and where-to-create instructions for each credential (Linear personal API keys, GitHub fine-grained PAT permissions — Contents RW, Pull requests RW, Metadata R — or classic `repo` scope, OpenRouter keys). Subsequent runs: a menu (view current config with masked secrets, edit any section, re-run the full wizard).
6. **MCP presets (dashboard)** — the agent editor's "add integration" is now a preset picker: Linear, GitHub (read/write), GitHub (read-only), Developer (builtin), Hindsight, plus Custom (the previous fully manual flow). Presets mirror the known-good configs from `app/src/agent/recipe/defaults.ts`.
7. **Configurable output language** — new `AGENT_OUTPUT_LANGUAGE` setting (default English) injected into the communication protocol via `{{OUTPUT_LANGUAGE}}`; replaces the hard-coded "Infleux team reads in Portuguese" rule.

## Cleanup report (what was removed and why)

**Never copied from the monorepo (junk/state/secrets):**

- `app/.myenv` and `app/.env.bak` — contained a real OpenRouter API key and a real GitHub classic PAT. They were never git-tracked; they were not copied, and the operator was advised to **rotate both** anyway.
- `dist/orchestrator-darwin-arm64` — 63 MB binary that was committed in the monorepo; binaries now come only from GitHub Releases (`dist/` gitignored).
- `.data/` (6.7 MB of local runtime state), `app/run-<uuid>-home/` (leftover per-run HOME with `.gitconfig`/CLI configs), `.DS_Store`, `.notes.md` (personal notes mentioning SIMSDEV test workspaces).

**Removed during the cleanup pass:**

- `app/setup.ts` (1,599 lines) — the legacy ".env wizard" from the Hermes-only era; fully superseded by `yaoe-flow setup` (config.env + encrypted DB settings). The `bun run setup` script was dropped from `app/package.json`.
- Hermes profile-shim collision handling (`isHermesProfileShim` in `cli/paths.ts`, backup/rename logic in `build-and-install.ts` and the wizard) — existed only because the old binary shared the name `orchestrator` with a Hermes shim; impossible by construction now.
- Deprecated settings group and fallbacks: `MAX_REFINERS`, `MAX_WORKERS`, `MAX_REVIEWERS` registry entries, the `legacyKeys` mechanism in the config service, `HERMES_WORKER_*`/`GOOSE_WORKER_RECIPE` env fallbacks in the agents seed, deprecated `config.capacity.maxRefiners/maxWorkers/maxReviewers` and `hermes.profiles.worker`/`goose.recipes.worker` getters, and the test that asserted the legacy behavior. (`DASHBOARD_USER/PASSWORD` were kept as a Docker-only first-admin seed, no longer listed as settings.)
- Hard-coded Infleux references: the language rule in `agents/COMMUNICATION_PROTOCOL.md` and all four `recipes/*.yaml` (replaced by the configurable language above); the stale `embedded-assets.generated.ts` containing old Infleux-flavored content was regenerated from the cleaned sources.
- Portuguese root docs not migrated (superseded by the English set; originals remain in the private monorepo): `README/AGENTS/DESIGN/CLAUDE/ GETTING_STARTED/HOW_TO_RUN/ORCHESTRATION_SERVICE_OVERVIEW`, `blueprint-linear-hermes.md`, `blueprint-multi-harness.md`, and the Portuguese `docs/*.md` guides (dashboard screenshots under `docs/images/` were kept and reused).

**Verified after cleanup:** `grep -ri "infleux\|simsdev"` over the tree returns nothing; `bun test` 159/159 green; `tsc --noEmit` clean on app and dashboard.

## Security notes

- Fresh git history: the new repo starts from a single commit, so the old committed binary and any historical references never enter the public history.
- CI runs gitleaks on every PR/push; the operator was instructed to enable GitHub secret scanning + push protection and branch protection (see CONTRIBUTING/SECURITY).

## Deliberately deferred

See `knowledge/product/roadmap.md`: Dependabot/Renovate, Homebrew tap/winget, dashboard UI and backend log messages still partially Portuguese, atomic self-update, translation of project-map/sandbox/worker-image READMEs.

## Bugs found during validation

- The broad `orchestrator:` → `yaoe-flow:` rename initially broke two object property names (`config.hermes.profiles.orchestrator` and the `ROLE_METAS.orchestrator` key) — caught by typecheck and reverted; the role keys are intentionally still `orchestrator`.
- `bun test` caught the removed legacy-keys behavior still being asserted by `config.test.ts` — the obsolete test was removed with the feature.

