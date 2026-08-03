# Changelog

All notable changes to YAOE-FLOW are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Each entry mirrors an OKF change bundle under `knowledge/changes/<yyyy-MM-dd>/<change-name>/` — deep detail lives there; this file stays macro.

## [Unreleased]

## [0.1.3] - 2026-08-03

Patch release: fixes harness CLIs (Claude Code, Codex) failing silently when running as a systemd/launchd service on a machine where `node` is only reachable via a version manager. OKF bundle: [knowledge/changes/2026-08-03/nvm-node-path-under-service-manager](knowledge/changes/2026-08-03/nvm-node-path-under-service-manager/README.md).

### Fixed

- **ACP adapters (`claude-code-acp`, `codex-acp`) failing under systemd/launchd when `node` is managed by nvm/Volta**: these adapters are npm packages with a `#!/usr/bin/env node` shebang. A service manager only gets the PATH set in its unit file — not `~/.bashrc`/`~/.profile` — so if `node` is only reachable via a version manager, the adapter fails to even execute, surfacing as a confusing ACP write `EPIPE` at boot or an `acp timeout: initialize` during a run, instead of a clear "not installed". `harnessPathCandidates()` (used before every harness spawn, detection or real run) now also looks for nvm's default (or highest installed) Node version and Volta's shim directory automatically — no systemd/launchd unit edit needed, just update the binary.
- **Harness detection false-positive**: a missing shebang interpreter produced non-empty `env: 'node': No such file or directory` output, which the generic "produced some output → installed" heuristic misreported as "installed, auth unknown" instead of "not installed" with a clear hint.
- **Stale wizard step numbers in docs/harnesses.md**: still referenced "steps 6–7" from before 0.1.2 renumbered the wizard to 11 steps (Network binding added as step 2) — corrected to steps 7–8.

## [0.1.2] - 2026-08-03

Patch release: makes the bind address a first-class setup question, and documents the (already-working) path to a custom domain. OKF bundle: [knowledge/changes/2026-08-03/network-binding-and-reverse-proxy-docs](knowledge/changes/2026-08-03/network-binding-and-reverse-proxy-docs/README.md).

### Added

- **`yaoe-flow setup` Network binding step** (new step 2/11): asks whether yaoe-flow should be reachable only from this machine (`HOST=localhost`, default) or from other machines/containers (`HOST=0.0.0.0`), with a "custom bind address" escape hatch. Available on first run and later from the configuration menu ("Network binding").
- **[docs/networking.md](docs/networking.md)**: explains the `HOST` bind choice, and how to put yaoe-flow behind a reverse proxy on a custom domain — no rebuild or extra config needed, since the dashboard SPA always calls its API with relative paths (same origin as whatever domain served the page). Includes sample Caddy/nginx configs and a note on the session cookie's `Secure` flag under HTTPS.

## [0.1.1] - 2026-08-03

Patch release: fixes a crash on x64 CPUs older than 2013. OKF bundle: [knowledge/changes/2026-08-03/avx2-baseline-builds](knowledge/changes/2026-08-03/avx2-baseline-builds/README.md).

### Fixed

- **`Illegal instruction (core dumped)` on pre-Haswell x64 CPUs**: the compiled `yaoe-flow-linux-x64`/`yaoe-flow-darwin-x64`/`yaoe-flow-windows-x64.exe` binaries used Bun's default x64 target, which requires AVX2 (2013+ CPUs) and crashes immediately on any older CPU (e.g. a 2012-era Core i7-3xxx). Release now also builds and publishes `-baseline` variants (no AVX2 required, Nehalem/2008+) for all three x64 platforms; `install.sh`/`install.ps1` detect the host's AVX2 support and pick the matching asset automatically (override with `YAOE_FORCE_BASELINE=1`/`0`).

## [0.1.0] - 2026-08-02

First public release, extracted from the `nixartz/ai-agents` monorepo (fresh history). OKF bundle: [knowledge/changes/2026-08-02/repo-migration-and-rename](knowledge/changes/2026-08-02/repo-migration-and-rename/README.md).

### Added

- **Standalone binary** `yaoe-flow`: API + scheduler + observability dashboard in a single executable, with `setup`, `daemon`, `status`, `doctor`, `stop`, `update`, `install-local` and `version` subcommands.
- **First-run setup wizard** with per-credential instructions (where to create each API key and which permissions are required), REQUIRED/OPTIONAL marking, and — after the first completion — a navigable configuration menu.
- **First-run gate**: `yaoe-flow daemon` refuses to start until `yaoe-flow setup` has completed once (pure-ENV deployments such as Docker pass automatically).
- **MCP presets** on the dashboard agent editor: Linear, GitHub (read/write and read-only), Developer (builtin), Hindsight, plus the existing fully custom flow.
- **`AGENT_OUTPUT_LANGUAGE` setting**: the language of the agents' human-facing output (Linear/PR comments) is now operator-configurable (default English) instead of hard-coded.
- **Install scripts** for Linux/macOS (`scripts/install.sh`) and Windows (`scripts/install.ps1`) with checksum validation, update-in-place and uninstall instructions.
- **Release pipeline**: tag `vX.Y.Z` → cross-compiled binaries for Linux, macOS and Windows (x64 + arm64 where Bun supports it), per-platform execution verification (all targets except darwin-x64 — the `macos-13` GitHub-hosted runner queue is unreliable; that binary is still built and released, just not smoke-tested on real hardware), GitHub Release with this changelog's section as the body. Every CI/release job has a 10-minute timeout so a stuck runner queue fails fast instead of hanging indefinitely.
- English pass: documentation (README, guides, CONTRIBUTING, SECURITY, `knowledge/`, misc READMEs and scripts), CLI, settings registry, backend runtime-visible strings (Pino log messages, thrown errors, OpenAPI `summary`/`description`, CLI-visible text) and Markdown paragraphs reflowed to one line each (avoids GitHub rendering soft line breaks as hard ones). The dashboard UI stays Portuguese by design (see `knowledge/product/roadmap.md` — react-intl is the real fix, not hardcoding); most `app/src` code comments are also still Portuguese (opportunistic follow-up).

### Changed

- Service, binary, env prefix and disk layout renamed: `orchestrator`/`ORCHESTRATOR_*`/`~/.orchestrator` → `yaoe-flow`/`YAOE_*`/`~/.yaoe-flow`. (Settings that refer to the *orchestrator agent role* — e.g. `ORCHESTRATOR_ENABLED`, `MAX_ORCHESTRATOR_WORKERS` — intentionally keep their names.)
- `YAOE_HOME` resolves to `~/.yaoe-flow` in every mode (dev and installed), so config, data and worktrees never fork between modes.
- Agent run workspaces moved from the service working directory to `$YAOE_HOME/worktrees/run-<id>` (`WORKSPACE_ROOT` setting, replacing `GOOSE_WORKING_DIR`).

### Removed

- Legacy `.env`-based setup script (`app/setup.ts`) — superseded by `yaoe-flow setup`.
- Hermes profile-shim collision handling (the binary no longer shares the `orchestrator` name with the Hermes profile shim).
- Deprecated settings and fallbacks (`MAX_REFINERS`, `MAX_WORKERS`, `MAX_REVIEWERS`, `HERMES_WORKER_*`, `GOOSE_WORKER_RECIPE` legacy reads).
- Hard-coded references to the previous operator (Infleux/SIMSDEV test workspaces) and the 63 MB committed binary from the old repo history.

