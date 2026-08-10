# AGENTS.md — yaoe-flow

Agent-facing guide for this repository. Follow existing project patterns unless the task introduces something genuinely new.

**Language:** everything committed to this repo — code comments, docs, OKF entries, CHANGELOG, CLI output, dashboard strings — is written in **English**. Chat with humans may use another language; artifacts in the repo stay in English.

## Before you start

1. Read this file.
2. Read every `knowledge/rules/*.md` file **except** `knowledge/rules/README.md` (agent-agnostic always-on rules — works outside any specific IDE/agent).
3. Skim relevant `knowledge/product/` docs when the task touches that domain.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Bun (app + scripts + tests) |
| HTTP | Hono (`hono`, `hono-openapi`, Scalar for docs UI) |
| Data | SQLite via Drizzle ORM (`drizzle-orm`), Valkey/Redis (`ioredis`) for locks |
| Agents | ACP (`@zed-industries/agent-client-protocol`), Goose recipes, Hermes HTTP |
| Observability | Pino (structured logs), SSE to the dashboard |
| Dashboard | React 19 + Vite + Tailwind 4 + Radix UI (see [DESIGN.md](DESIGN.md)) |
| Tests | `bun test` (contract suite against a mock ACP agent — no LLM cost) |

## Project structure

```
app/
  src/
    index.ts            # thin entrypoint: no argv → server; argv → CLI
    server.ts           # boot: API + scheduler + dashboard
    scheduler.ts        # reconciliation tick + dispatch decisions
    config.ts           # config facade (getters over config service)
    config/             # bootstrap (ENV), registry (metadata), service (ENV>db>default)
    cli/                # yaoe-flow subcommands (setup wizard in cli/setup/)
    agent/              # dispatch, harness adapters (ACP/goose/hermes), recipes
    api/                # dashboard API + orchestrator webhook API
    dashboard/          # dashboard server, store, SSE bus, retention
    db/                 # drizzle schema, agents, users, secrets (AES-256-GCM)
    readiness/          # readiness queue evaluation
  test/                 # bun test suites
dashboard/              # React SPA (embedded into the binary at build)
agents/                 # SOULs (*.SOUL.md) + COMMUNICATION_PROTOCOL.md
recipes/                # static Goose recipes (seed; DB agents build at runtime)
scripts/                # install.sh/.ps1, build-and-install.ts
knowledge/
  rules/                # short always-on rules (any agent)
  product/              # durable product knowledge
  changes/              # OKF change bundles
docs/                   # user-facing guides + dashboard screenshots
CHANGELOG.md            # macro history (keepachangelog)
```

## Non-negotiable invariants

- **Only `app/src/config/` reads `process.env`.** Everything else goes through the `config` facade / config service (precedence ENV > db > default). Adding a setting = registry entry (`config/registry.ts`) + facade getter.
- **Secrets are never written in plain text**: settings marked `secret` are AES-256-GCM encrypted at rest (`db/secrets.ts`) and masked in the API. MCP configs reference secrets by env-var NAME (`envKeys`), never by value.
- **`YAOE_HOME` (`~/.yaoe-flow`) is the only disk layout** — dev and installed binary resolve the same home. Never write runtime state into the repo tree.
- **Linear is the source of truth** of pipeline state. The scheduler reconciles from Linear; local state is observability, not authority.
- **The communication protocol (`agents/COMMUNICATION_PROTOCOL.md`) is a pipeline contract** — concatenated to every SOUL; changes to it affect every role on every harness.
- The entrypoint `app/src/index.ts` must stay free of static app imports (light CLI commands must run without a database).

## Commands

```bash
cd app && bun install
bun dev                # watch mode (API :4790 + dashboard API :4791)
bun test               # contract + unit suites (seconds, no network)
bun run typecheck
cd ../dashboard && bun run dev    # SPA hot reload (proxies to :4791)
bun scripts/build-and-install.ts  # from repo root: full build + install
```

## Knowledge

### Always-on rules — `knowledge/rules/`

Short, **agent-agnostic** rules. Load them at task start. Add a new short rule here when a constraint should apply to every future task; keep files focused.

### Product knowledge — `knowledge/product/`

When a task introduces or changes **durable product behavior** (pipeline semantics, harness contracts, lock model, security premises), create or update `knowledge/product/<topic>.md`. Stable "how the product works" lives here; change-specific notes go to `knowledge/changes/`.

### OKF changes — `knowledge/changes/` (required for every feature or fix set)

Spec: [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

```
knowledge/changes/<yyyy-MM-dd>/<change-name>/   # kebab-case names
  README.md          # summary, issues/PRs, what changed & where, deferred items
  *.md               # OKF concepts (frontmatter: type required; prefer title/description/tags)
```

1. One directory = **one implementation set**. Follow-up fixes stay in the **same** directory.
2. The bundle `README.md` lists issues/PRs (id **and** URL) and states explicitly which layers changed (API/CLI/Dashboard/Harness/CI) — and which did NOT.
3. For UI changes, describe the FLOW (screen → action → result) and the fields/parameters, not just "added screen X".
4. Record bugs found during manual validation (their presence is evidence the verification was real) and what was consciously deferred.

### CHANGELOG.md (macro history)

After each feature/fix set, append an entry under `[Unreleased]` (or the dated release section) using [Keep a Changelog](https://keepachangelog.com/) categories (`Added`, `Changed`, `Fixed`, `Removed`). Mirror the OKF identity (same date + change-name) and link the bundle path. Macro only — depth stays in OKF.

### README.md

When a change matters to humans using or onboarding to the repo (structure, scripts, env vars, commands, new major modules), update `README.md` in the same change set.

## Code quality bar

- Prefer simple, explicit, well-structured code; reuse existing helpers (config service, dashboard store, harness adapters) before inventing parallel abstractions.
- Every new/changed dashboard API route gets typed schemas (the OpenAPI doc at `/api/docs` must stay accurate).
- Add or extend `bun test` suites for new behavior and regression cases; the contract suite must stay LLM-free and network-free.
- Never log secrets; respect the masking rules of the settings API.
- Do not commit secrets or real `.env` values (only `.env.example`).
- Releases: never commit binaries — `dist/` is gitignored; releases are cut by tag via `.github/workflows/release.yml`.

## What not to do

- Do not read `process.env` outside `app/src/config/`.
- Do not bypass the footprint/lock model "just this once" — collision-freedom is the product.
- Do not edit `app/src/embedded-assets.generated.ts` by hand (run `bun run embed-assets`). Commit migrations/SOULs with `--no-dashboard`; never commit a non-empty `EMBEDDED_DASHBOARD_ASSETS` (SPA is baked at release/install-local only).
- Do not put always-on rules only in `.cursor/rules` or CLAUDE.md — use `knowledge/rules/` (portable).
- Do not leave a feature without OKF bundle + CHANGELOG entry.

