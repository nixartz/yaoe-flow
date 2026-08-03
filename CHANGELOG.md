# Changelog

All notable changes to YAOE-FLOW are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

Each entry mirrors an OKF change bundle under
`knowledge/changes/<yyyy-MM-dd>/<change-name>/` — deep detail lives there;
this file stays macro.

## [Unreleased]

## [0.1.0] - 2026-08-02

First public release, extracted from the `nixartz/ai-agents` monorepo
(fresh history). OKF bundle:
[knowledge/changes/2026-08-02/repo-migration-and-rename](knowledge/changes/2026-08-02/repo-migration-and-rename/README.md).

### Added

- **Standalone binary** `yaoe-flow`: API + scheduler + observability dashboard
  in a single executable, with `setup`, `daemon`, `status`, `doctor`, `stop`,
  `update`, `install-local` and `version` subcommands.
- **First-run setup wizard** with per-credential instructions (where to create
  each API key and which permissions are required), REQUIRED/OPTIONAL marking,
  and — after the first completion — a navigable configuration menu.
- **First-run gate**: `yaoe-flow daemon` refuses to start until
  `yaoe-flow setup` has completed once (pure-ENV deployments such as Docker
  pass automatically).
- **MCP presets** on the dashboard agent editor: Linear, GitHub (read/write
  and read-only), Developer (builtin), Hindsight, plus the existing fully
  custom flow.
- **`AGENT_OUTPUT_LANGUAGE` setting**: the language of the agents'
  human-facing output (Linear/PR comments) is now operator-configurable
  (default English) instead of hard-coded.
- **Install scripts** for Linux/macOS (`scripts/install.sh`) and Windows
  (`scripts/install.ps1`) with checksum validation, update-in-place and
  uninstall instructions.
- **Release pipeline**: tag `vX.Y.Z` → cross-compiled binaries for Linux,
  macOS and Windows (x64 + arm64 where Bun supports it), per-platform
  execution verification (all targets except darwin-x64 — the `macos-13`
  GitHub-hosted runner queue is unreliable; that binary is still built and
  released, just not smoke-tested on real hardware), GitHub Release with this
  changelog's section as the body. Every CI/release job has a 10-minute
  timeout so a stuck runner queue fails fast instead of hanging indefinitely.
- English documentation set: README, guides (Linear, GitHub, agents, MCPs,
  harnesses), CONTRIBUTING, SECURITY and the `knowledge/` structure
  (rules / product / OKF changes).

### Changed

- Service, binary, env prefix and disk layout renamed:
  `orchestrator`/`ORCHESTRATOR_*`/`~/.orchestrator` →
  `yaoe-flow`/`YAOE_*`/`~/.yaoe-flow`. (Settings that refer to the
  *orchestrator agent role* — e.g. `ORCHESTRATOR_ENABLED`,
  `MAX_ORCHESTRATOR_WORKERS` — intentionally keep their names.)
- `YAOE_HOME` resolves to `~/.yaoe-flow` in every mode (dev and installed),
  so config, data and worktrees never fork between modes.
- Agent run workspaces moved from the service working directory to
  `$YAOE_HOME/worktrees/run-<id>` (`WORKSPACE_ROOT` setting, replacing
  `GOOSE_WORKING_DIR`).
- Settings registry, CLI output and wizard fully translated to English.

### Removed

- Legacy `.env`-based setup script (`app/setup.ts`) — superseded by
  `yaoe-flow setup`.
- Hermes profile-shim collision handling (the binary no longer shares the
  `orchestrator` name with the Hermes profile shim).
- Deprecated settings and fallbacks (`MAX_REFINERS`, `MAX_WORKERS`,
  `MAX_REVIEWERS`, `HERMES_WORKER_*`, `GOOSE_WORKER_RECIPE` legacy reads).
- Hard-coded references to the previous operator (Infleux/SIMSDEV test
  workspaces) and the 63 MB committed binary from the old repo history.
