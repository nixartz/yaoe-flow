# Changelog

All notable changes to YAOE-FLOW are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Each entry mirrors an OKF change bundle under `knowledge/changes/<yyyy-MM-dd>/<change-name>/` — deep detail lives there; this file stays macro.

## [Unreleased]

## [0.1.9] - 2026-08-24

### Fixed

- **Claude Code harness: `Authentication required` on every turn when running on macOS with a subscription login**: the per-run `CLAUDE_CONFIG_DIR` isolation (used to apply the `CLAUDE_CODE_ATTRIBUTION` toggle without touching the operator's real `~/.claude/settings.json`) pointed the CLI at a brand-new directory each run. On macOS, subscription/OAuth credentials live in the system Keychain under a service name keyed by the *literal* `CLAUDE_CONFIG_DIR` path, so a fresh path always landed on an empty, never-logged-in Keychain entry — even though `claude` worked fine when run manually with the same login. The harness now skips this isolation on macOS when no static credential (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) is configured, authenticating against the host's real `~/.claude` instead (attribution simply doesn't apply for that run); Linux and macOS-with-API-key runs are unaffected. OKF: [knowledge/changes/2026-08-24/claude-code-macos-keychain-auth](knowledge/changes/2026-08-24/claude-code-macos-keychain-auth/README.md).

## [0.1.8] - 2026-08-12

### Added

- **`yaoe-flow sync-souls` + dashboard button "Aplicar SOUL padrão"**: re-import the SOULs bundled with the running binary into the database. Until now the seed only ran on an empty `agents` table, so an upgrade that changed agent behavior never reached an existing install (the only workaround was pasting each SOUL into a new version by hand). Both surfaces show a read-only plan first — per role, active version vs. bundled SOUL with content hash and line counts — and write only after confirmation (`--yes` for scripts, `--role` for a subset; a non-TTY without `--yes` refuses). The replaced SOUL is kept in the agent's version history and can be reactivated; local dashboard edits are not merged. No restart needed. OKF: [knowledge/changes/2026-08-11/soul-sync](knowledge/changes/2026-08-11/soul-sync/README.md).
- **`SCOPE_ANCILLARY_DOC_PATHS`** (Config → GitHub & security): comma-separated globs telling the deterministic scope-check which process-doc paths are ancillary (change bundles / OKF / CHANGELOG / ADRs). Previously hardcoded to this repo's layout, so projects storing change bundles elsewhere (`docs/changes/**`, `.okf/**`, `configdocs/**`) had their required documentation rejected as out-of-footprint. Patterns use the footprint dialect and also match at any depth (monorepo packages); `*`/`**`/absolute paths are rejected. OKF: [knowledge/changes/2026-08-11/repo-conventions-binding](knowledge/changes/2026-08-11/repo-conventions-binding/README.md).
- **Manual footprint-lock release from the dashboard**: the Prontidão page now shows a "Locks ativos" card per Linear connection (independent of the readiness snapshot) with a "Liberar" action behind a confirm dialog, for the rare case a webhook was lost and the scheduler's own self-heal hasn't caught up yet. `GET /api/locks` + `POST /api/locks/:connectionId/:issueId/release`, tolerant of an already-released lock; never touches Linear. OKF: [knowledge/changes/2026-08-11/locks-dashboard-and-batching](knowledge/changes/2026-08-11/locks-dashboard-and-batching/README.md).
- **Cross-process dispatch exclusivity + orphan run cleanup**: `runDispatch` now claims a Redis-backed per-issue/role lease (`tryAcquireDispatchLock`) before spawning any harness process, so two daemon processes pointed at the same `YAOE_HOME`+Valkey can no longer double-dispatch the same issue — the previous guard (`activeRuns`) was in-memory and only protected within a single process. A new boot-time `orch:daemon:lock` (renewed every tick) detects a second live instance and disables its dispatch/tick (API/dashboard stay up, not a hard crash); on a *confirmed* solo boot, `closeOrphanRunningRows()` flips any `status='running'` row left by a killed process to `failed` with an explanatory `error_message` — DB-only, no Linear transition, since `reconcileStaleLocks()` already self-heals the Linear side. OKF: [knowledge/changes/2026-08-11/multi-process-dispatch-safety](knowledge/changes/2026-08-11/multi-process-dispatch-safety/README.md).
- **`yaoe-flow update` now actually updates**: downloads the release asset for the current platform + `SHA256SUMS`, verifies the checksum, and atomically replaces the running binary (same-directory rename; Windows falls back to rename-old-then-rename-new since a running `.exe` can be locked) — previously it only checked the latest tag and told the operator to re-run the install one-liner by hand. New `--force` flag re-installs even when already on the latest version, to repair a corrupted binary. Refuses under `bun run`/dev mode (no binary file to replace). `install.sh` now also warns — before downloading, advisory only, no fallback build exists — when the host's glibc is older than 2.17 (the binary would otherwise fail at first launch with an opaque dynamic-linker error); `YAOE_SKIP_GLIBC_CHECK=1` silences it. OKF: [knowledge/changes/2026-08-11/self-update-and-install-hardening](knowledge/changes/2026-08-11/self-update-and-install-hardening/README.md).
- **`scripts/release.ts` waits for the publish and offers to open the merge-back PR**: after pushing the tag, it now polls `gh release view` (bounded, never hangs — prints the Actions URL on timeout) until the release workflow publishes, and when the release was cut off-`main` (`--allow-branch`) it opens a `gh pr create` back into `main` so the version bump/CHANGELOG commit isn't left stranded. Both steps are best-effort (a `gh` failure never fails the release itself) and skippable via `--no-wait`/`--no-pr`; skipped entirely with a note if `gh` isn't installed. OKF: [knowledge/changes/2026-08-11/release-script-polling-and-pr](knowledge/changes/2026-08-11/release-script-polling-and-pr/README.md).
- **Run detail sheet shows the on-disk workspace path**: the "Configuração" tab of a run's detail sheet now shows a copyable, truncated path to where the harness ran (or would run) for that run's issue — computed on read from `issue_id`/`linear_connection_id` via the existing `issueWorkspaceCwd`, `null` for runs with no issue. Display + copy only (the dashboard may be viewed from a different machine than the daemon). OKF: [knowledge/changes/2026-08-11/dashboard-integration-and-workspace-affordances](knowledge/changes/2026-08-11/dashboard-integration-and-workspace-affordances/README.md).
- **Releases now cut themselves on merge to `main`**: a new `auto-release` workflow runs `scripts/release.ts` after every push to `main`, skipping (not failing) when `CHANGELOG.md`'s `[Unreleased]` section is empty so docs/chore-only merges don't produce empty releases. Bump kind defaults to patch; a `release:minor`/`release:major` label on the merged PR overrides it (both labels created in the repo). `release.yml` gained a `workflow_call` trigger so this can invoke the same build/verify/publish pipeline directly, instead of relying on a `GITHUB_TOKEN`-authored tag push to retrigger it (GitHub's own loop prevention means it wouldn't) — no new PAT/secret needed. The existing manual `bun scripts/release.ts` → tag push flow is unchanged. OKF: [knowledge/changes/2026-08-11/auto-release-on-merge](knowledge/changes/2026-08-11/auto-release-on-merge/README.md).

### Changed

- **A cloned repo's own agent guide is now binding (SOULs + `COMMUNICATION_PROTOCOL.md` §14)**: every role reads `AGENTS.md` → `CLAUDE.md` → `.cursor/rules/*` → `CONTRIBUTING.md`/`PROJECT_MAP.md` → the repo's knowledge/doc directory of **each** cloned repository, right after cloning and before planning — previously the Dev SOUL only asked for `AGENTS.md` when the repo was yaoe-flow itself, so features shipped without the OKF bundles, CHANGELOG entries and feature docs the target repo required. Deliverables the guide demands are part of "done": PMO writes them as per-repo checklist items, Dev announces the guide files in the ▶️ plan and ships the docs in the same PR, Reviewer rejects when they are missing. Same OKF bundle.
- **Footprint collision matcher no longer over-collides two mid-globstar patterns that share a literal prefix**: `src/app/**/perfil/**` and `src/app/**/billing/**` no longer serialize each other's dispatch — no real path segment can equal both literal next-segments at once, so they're now provably disjoint. Every other collision shape (unequal-but-nesting prefixes, ambiguous next segments) stays conservative. OKF: [knowledge/changes/2026-08-11/footprint-globstar-disjointness](knowledge/changes/2026-08-11/footprint-globstar-disjointness/README.md).
- **Fewer Linear API calls per tick**: `listIssuesInStates()` warms up to 8 distinct by-state issue lists (`Refining`, `In Progress`, `Reopened`, `In Review`, `Code Review`, `Pending Merge`, plus `Todo`/`Planned` when auto-dispatch is on) in a single aliased GraphQL request at the start of each connection's tick, instead of one request per state as `fillRefiners`/`fillWorkers`/`fillReviewers`/`reclaimStale` each ran their own lookup. `TICK_INTERVAL_MS` default raised `15s` → `30s` (still hot-reloadable) — most transitions are webhook-driven, so this only slows the safety-net poll. Same OKF bundle as the manual lock release above; per-field Redis TTL (`HEXPIRE`) stays deliberately unimplemented (Blocked locks must outlive any short TTL).

### Fixed
- **`auto-release`'s final publish step failed every time it actually ran**: `softprops/action-gh-release@v2` infers the release tag from `GITHUB_REF` by default, but inside a `workflow_call` invocation `github.ref` is the *caller's* ref (`refs/heads/main`, since the trigger was a push to `main`) — never the tag, even though `actions/checkout` was separately given the correct tag ref. Every auto-cut release hit `⚠️ GitHub Releases requires a tag` on publish. Fixed by passing `tag_name` explicitly. Also added a `workflow_dispatch` trigger to both `auto-release.yml` (on-demand cut, with a `bump` override since there's no merge commit to read PR labels from) and `release.yml` (republish an existing tag whose publish step failed, without a new tag push). OKF: [knowledge/changes/2026-08-11/auto-release-on-merge](knowledge/changes/2026-08-11/auto-release-on-merge/README.md).
- **Agent Integrations tab reset the selected MCP row on every tab switch, not just harness switch**: Radix `Tabs` unmounts inactive `TabsContent` by default, so `McpServersEditor` fully remounted whenever an operator left and returned to the Integrações tab, regenerating fresh random row ids that the previously-selected id could never match again. The row-id state is now lifted into `AgentEditor` alongside the selection (both keyed per harness), so switching tabs — or switching the active harness — no longer silently resets which MCP row was selected. Found by clicking through the running dashboard; `tsc`/`bun run build` stayed green on the broken version. OKF: [knowledge/changes/2026-08-11/dashboard-integration-and-workspace-affordances](knowledge/changes/2026-08-11/dashboard-integration-and-workspace-affordances/README.md).
- **`auto-release` failed on its first real run**: the `cut` job ran `scripts/release.ts` (which runs `cd app && bun test` before committing) without ever installing `app/`'s dependencies first, so every test importing a package failed with `Cannot find package`. Added the missing `bun install --frozen-lockfile` step (mirrors what `release.yml`'s own `build` job already does). No release was actually cut by the failed run — the script runs tests before any git mutation, so `main`/tags were untouched. OKF: [knowledge/changes/2026-08-11/auto-release-on-merge](knowledge/changes/2026-08-11/auto-release-on-merge/README.md).
- **Self-update on Windows could leave the daemon with no binary at all**: `atomicReplace` renames the running `.exe` aside before moving the new one in (POSIX doesn't need this); if that first rename succeeded but the second then failed (e.g. a transient AV lock), the old file was never restored — the daemon ended up with *no* binary, worse than skipping the update. It now rolls the old file back into place before reporting the failure. Same OKF bundle as "`yaoe-flow update` now actually updates" above.

## [0.1.6] - 2026-08-10

### Fixed

- **Footprint matcher ignored globstar `**`**: scope-check/collision used prefix match after stripping trailing `/*`, so patterns like `src/app/**/perfil/**` never matched `src/app/perfil/...` (INF-23 Reopened loop). Matcher now uses `Bun.Glob` (`**` = globstar; trailing `/*` still means whole subtree). `CHANGELOG.md` and `knowledge/changes/**` are §8.1 ancillary. OKF: [knowledge/changes/2026-08-10/footprint-globstar](knowledge/changes/2026-08-10/footprint-globstar/README.md).
- **Release binaries shipping a stale dashboard SPA**: `EMBEDDED_DASHBOARD_ASSETS` was committed with a baked UI, so releases could serve old screens. The SPA is no longer committed; release builds `dashboard/` → `embed-assets --require-dashboard` → compile, and CI asserts the git stub stays empty. OKF: [knowledge/changes/2026-08-10/release-dashboard-embed](knowledge/changes/2026-08-10/release-dashboard-embed/README.md).

## [0.1.5] - 2026-08-10

### Added

- **`scripts/release.ts`**: one-shot release cutter — bump (`--patch`/`--minor`/`--major` or exact version), promote CHANGELOG `[Unreleased]`, commit, annotated tag, push (triggers GitHub release workflow). Existing tags can be deleted after an explicit prompt or `--replace-tag` (for republishing a broken release). OKF: [knowledge/changes/2026-08-10/release-script](knowledge/changes/2026-08-10/release-script/README.md).

### Changed

- **Agent editor Integrations / Execution UX**: Integrations uses three equal-height cards (sortable MCP table 2/4 + detail 1/4 + advanced JSON 1/4, `min-h-[660px]`) with drag-and-drop reorder (`@dnd-kit`). Execution tab advanced JSON is also always open. OKF: [knowledge/changes/2026-08-08/agent-integrations-master-detail](knowledge/changes/2026-08-08/agent-integrations-master-detail/README.md).
- **Agent Blocked policy (SOULs + COMMUNICATION_PROTOCOL)**: agents prefer evidence + `📝` + proceed; `🙋` + `Blocked` is reserved for protocol §5 human/product/safety/access cases (empty repo, A vs B with no evidence, large footprint leakage, explicit gates). Mild ambiguity, noisy comments, and path tightening from a named repo no longer default to Blocked. Scheduler footprint locks unchanged. OKF: [knowledge/changes/2026-08-08/agent-blocked-vs-note-proceed](knowledge/changes/2026-08-08/agent-blocked-vs-note-proceed/README.md).
- **Issue-scoped durable workspaces**: every harness reuses `$YAOE_HOME/worktrees/issue-<issueId>` (or `conn-<connectionId>/…`) from the first dispatch until Completed, so Reopened/Blocked no longer wipe local clones. Cleanup on Completed webhook + tick `reconcileStaleWorkspaces()`. OKF: [knowledge/changes/2026-08-07/issue-scoped-workspaces](knowledge/changes/2026-08-07/issue-scoped-workspaces/README.md).

### Fixed

- **Duplicate Orchestrator/Dev runs on the same issue**: footprint estimate had no exclusive reservation (every tick re-fired planning) and `acquireLock` was not atomic, so two estimate completions could both spawn Dev on the same worktree. Added Valkey NX estimate reservation + `tryAcquireLock`, plus open-run / in-memory dispatch guards. OKF: [knowledge/changes/2026-08-08/exclusive-dispatch-and-stop-siblings](knowledge/changes/2026-08-08/exclusive-dispatch-and-stop-siblings/README.md).
- **Stopping one run marked the twin failed and Blocked Linear while it kept running**: manual stop no longer moves to Blocked if another run is still live; Blocked webhooks skip closing live processes; premature `failed`/`timeout` rows revive to `running` when events keep arriving. Same OKF.
- **Zombie footprint locks blocking Planned dispatch**: Valkey locks had no TTL and were only released on the Completed webhook — a missed webhook left Completed issues holding locks forever (e.g. INF-15/INF-16 blocking readiness). The tick now runs `reconcileStaleLocks()` and drops locks whose Linear state left the lock-holding set. OKF: [knowledge/changes/2026-08-07/stale-locks-and-linear-rate-limit](knowledge/changes/2026-08-07/stale-locks-and-linear-rate-limit/README.md).
- **Linear `RATELIMITED` thrash on the reconciliation tick**: the client now tracks `X-RateLimit-Requests-*` headers and GraphQL rate-limit errors, cools down until reset, skips ticks/readiness when the hourly budget is exhausted, and memoizes list/getIssue within a single connection reconcile. Same OKF bundle.

- **Cursor harness auth under isolated HOME / headless systemd**: the per-run HOME mirror made `cursor-agent` probe the `cursor-user` keychain (or open a browser) instead of the daemon user's session. Spawns now use `AGENT_CLI_CREDENTIAL_STORE=file`, pass `--api-key` when configured, and wait/retry with the login URL surfaced in the run chat. OKF: [knowledge/changes/2026-08-06/cursor-headless-auth-and-config-tabs](knowledge/changes/2026-08-06/cursor-headless-auth-and-config-tabs/README.md).
- **Config sidebar categories empty / dumped into "Somente leitura"**: UI category map still used Portuguese group names after the registry moved to English — restored EN mappings (and Harness card settings for Goose/Hermes/Cursor).

### Added

- **`CURSOR_API_KEY`** (secret, Config + Harness): User API Key for headless Cursor ACP auth, encrypted at rest.
- **Harness → Log in to Cursor**: browserless `cursor-agent login` with a URL to open on another machine.

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

