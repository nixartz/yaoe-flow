# YAOE-FLOW

**Yet Another Orchestration Engine-Flow** — an autonomous development pipeline:
Linear issues in, reviewed and merged PRs out.

[![CI](https://github.com/nixartz/yaoe-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/nixartz/yaoe-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

YAOE-FLOW turns a Linear board into a self-driving delivery loop. Specialized AI
agents refine issues, implement them, review the PRs and merge — in parallel,
without stepping on each other — while **Linear stays the single source of
truth** (statuses, dependencies, comments) and you keep the human gates you
want (`ready-to-refine`, `ready-to-implement`, `ready-to-merge` labels).

## Why "YAOE"?

Because it *is* yet another orchestration engine — and it leans into it. The
value is not in inventing new concepts; it is in wiring proven ones (issue
trackers, worktrees, locks, code review) into a pipeline that ships while you
sleep.

## How it works

```
        Linear (source of truth: statuses, labels, deps, comments)
          │  webhooks + reconciliation tick
          ▼
┌───────────────────────────────────────────────────────────────┐
│  yaoe-flow daemon (single binary: API + scheduler + dashboard)│
│                                                               │
│  PMO ──► Dev ──► Reviewer ──► Orchestrator (merge)            │
│   refine   implement   review     serialize merges            │
│                                                               │
│  footprint locks (Valkey) keep parallel agents from colliding │
└───────────────────────────────────────────────────────────────┘
          │  each run: isolated clone in ~/.yaoe-flow/worktrees/run-<id>
          ▼
        GitHub (branches, PRs, merges)
```

Four agent roles, defined as **SOULs** (versioned system prompts):

| Role | What it does |
|---|---|
| **PMO** | Refines issues: dependencies, footprint, out-of-scope, checklist. Never writes code. |
| **Dev** | Implements or fixes, N in parallel, footprint as scope ceiling. Opens the PR. |
| **Reviewer** | Read-only PR audit: traceability, scope, bugs, security. Approves or reopens. |
| **Orchestrator** | Plans footprints and serializes the final merges. Never writes code. |

Each role runs on the **harness** you choose — your existing subscription CLIs
via ACP (Claude Code, Cursor, Codex, Copilot), Goose with your own OpenRouter
key (BYOK), or a Hermes HTTP gateway — configured per agent on the dashboard.

## Features

- **Linear-native** — statuses drive the pipeline; humans curate with labels;
  every agent action is a Linear comment you can audit.
- **Collision-free parallelism** — declared dependencies + footprint locks
  decide what can run at the same time; merges are serialized.
- **Multi-harness** — mix harnesses per role: your Claude Code subscription for
  Dev, Goose+OpenRouter for review, etc. ACP gives full step-by-step traces.
- **Observability dashboard** — live runs with trace, logs, webhook audit,
  history, cost reconciliation (OpenRouter), readiness queue, multi-workspace
  Linear connections, user management.
- **Single binary** — API + scheduler + dashboard compile into one executable;
  everything lives under `~/.yaoe-flow`.
- **Self-healing** — inactivity timeouts reclaim stuck seats, a circuit
  breaker sends looping issues to Blocked, and a reconciliation tick survives
  missed webhooks.

<p align="center">
  <img src="docs/images/dashboard/overview/01-visao-geral.png" alt="YAOE-FLOW dashboard" width="720">
</p>

## Install

**Linux/macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/nixartz/yaoe-flow/main/scripts/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/nixartz/yaoe-flow/main/scripts/install.ps1 | iex
```

**From source** (requires [Bun](https://bun.sh))

```bash
git clone https://github.com/nixartz/yaoe-flow.git
cd yaoe-flow
bun scripts/build-and-install.ts   # compiles + installs into ~/.local/bin
```

The installer prints where the executable landed. Updating = re-running the
installer (idempotent). Uninstalling = `rm` the binary + `rm -rf ~/.yaoe-flow`.

## Getting started

1. **Run the wizard** — `yaoe-flow setup`. First run walks you through
   everything: system deps, keys (generated for you), Valkey, Linear, GitHub,
   first dashboard admin, harnesses. It tells you where to create each API key
   and which permissions are actually required. Running it again opens a
   navigation menu to view/edit any section.
2. **Start the service** — `yaoe-flow daemon -d` (or install it as a user
   service from the wizard). The daemon refuses to start before the setup has
   completed once.
3. **Open the dashboard** — `http://localhost:4791`, log in with the admin you
   created, check the Agents/Harness screens.
4. **Ship something** — put a Linear issue in *To Do* with the
   `ready-to-refine` label and watch it flow.

## CLI reference

| Command | Description |
|---|---|
| `yaoe-flow setup` | First-run wizard; later, a navigable configuration menu |
| `yaoe-flow daemon [-d]` | Start the service (foreground, or `-d` detached) |
| `yaoe-flow status` | Quick health summary |
| `yaoe-flow doctor [--offline]` | Deep diagnosis with per-item fixes |
| `yaoe-flow stop [--force]` | Graceful stop (or immediate kill) |
| `yaoe-flow update` | Check the latest release |
| `yaoe-flow install-local` | Compile + install from a source clone |
| `yaoe-flow version` | Version + commit + platform |

Everything on disk lives in **`~/.yaoe-flow/`** (`config.env`, `data/`,
`logs/`, `worktrees/`) — in dev mode and installed mode alike. Override with
`YAOE_HOME`.

## Documentation

| Guide | What it covers |
|---|---|
| [docs/linear-setup.md](docs/linear-setup.md) | Workspace, statuses, labels, webhook — what each agent pulls from each step |
| [docs/github-setup.md](docs/github-setup.md) | PAT (fine-grained/classic) or GitHub App, exact permissions |
| [docs/agents.md](docs/agents.md) | What each agent role does and the issue structure it produces |
| [docs/mcp-configuration.md](docs/mcp-configuration.md) | Wiring MCPs (Linear, GitHub, Hindsight, custom) per agent |
| [docs/harnesses.md](docs/harnesses.md) | ACP CLIs (Claude Code/Cursor/Codex), Goose+OpenRouter, Hermes HTTP |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Run locally, modify the dashboard, build, PR flow |
| [knowledge/](knowledge/) | Product knowledge, always-on rules, per-change OKF bundles |

## Development

Prerequisites: [Bun](https://bun.sh), git, a local Valkey/Redis.

```bash
cd app && bun install && bun dev            # API + scheduler + dashboard API
cd dashboard && bun install && bun run dev  # SPA with hot reload (Vite)
cd app && bun test && bun run typecheck     # tests + types
```

Full workflow (including how releases are cut): [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © [SIMSDEV](https://sims.dev.br). Forks and derived works must
keep the copyright notice — that's the only ask. Have fun.
