# Harnesses: ACP CLIs, Goose + OpenRouter, Hermes HTTP

A **harness** is the engine that actually executes an agent role. Each agent picks its harness on the dashboard; you can mix harnesses across roles.

## Summary

- [Which harness should I use?](#which-harness-should-i-use)
- [Subscription CLIs via ACP (Claude Code, Cursor, Codex, Copilot)](#subscription-clis-via-acp-claude-code-cursor-codex-copilot)
- [Goose via ACP (OpenRouter BYOK)](#goose-via-acp-openrouter-byok)
- [Hermes via HTTP](#hermes-via-http)
- [Per-run isolation](#per-run-isolation)
- [Detection, budgets and troubleshooting](#detection-budgets-and-troubleshooting)

## Which harness should I use?

| You have | Use | Trace |
|---|---|---|
| A Claude Code / Cursor / Codex / Copilot subscription on this machine | the CLI via ACP | full step-by-step |
| An OpenRouter API key (pay per token, any model) | Goose via ACP | full step-by-step |
| A remote Hermes gateway | Hermes HTTP | fire-and-report (no trace) |

Setup is mostly automatic for local CLIs: the `yaoe-flow setup` wizard detects what is installed/logged-in and offers to install the missing pieces.

## Subscription CLIs via ACP (Claude Code, Cursor, Codex, Copilot)

These run **your** logged-in CLI session — no extra API key needed.

- **Claude Code**: needs the `claude` CLI logged in + the ACP adapter `@zed-industries/claude-code-acp` (npm; the wizard installs it). On **macOS**, a subscription/keychain login (no `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) only authenticates when the harness runs against the host's real `~/.claude` — a fresh `CLAUDE_CONFIG_DIR` gets its own empty Keychain entry (`Claude Code-credentials-<hash>`), so yaoe-flow automatically skips the per-run config isolation in that case (see [Per-issue workspace isolation](#per-issue-workspace-isolation)); attribution settings simply don't apply for that run. Set **`ANTHROPIC_API_KEY`** (Config or Harness) if you also want per-run attribution isolation on macOS.
- **Codex**: needs the `codex` CLI + the `codex-acp` adapter (npm).
- **Cursor**: needs `cursor-agent` (official installer: `curl -fsS https://cursor.com/install | bash`) — ACP is native. On a headless server / systemd service, set **`CURSOR_API_KEY`** (User API Key from [cursor.com/dashboard/api](https://cursor.com/dashboard/api)) in Config or Harness — browser/keychain login breaks under the per-run HOME mirror. Alternatively use **Harness → Log in to Cursor** (prints a URL; credentials use the file store, not the `cursor-user` keychain).
- **Copilot**: needs the `copilot` CLI — detection/report supported.

Because sessions live in the logged-in user's HOME, the daemon runs as that user (it refuses root) and works best on a workstation or a VM where you have logged the CLIs in once. For Cursor specifically, prefer `CURSOR_API_KEY` when the machine has no GUI.

## Goose via ACP (OpenRouter BYOK)

[Goose](https://block.github.io/goose/) runs any model through your own OpenRouter key:

1. Install goose (wizard offers it) and set `OPENROUTER_API_KEY` (wizard step 8, or dashboard Config — encrypted).
2. Pick harness "goose" for the agent and set its model (e.g. `anthropic/claude-sonnet-4.5`).
3. Optional: enable the OpenRouter **Auto Router** or per-recipe model preferences (`OPENROUTER_AUTO_*` settings).

Cost reconciliation: a local proxy (`OPENROUTER_PROXY_PORT`) captures generation ids; when the run ends, official token/cost numbers are pulled into the dashboard (`OPENROUTER_RECONCILE`).

`GOOSE_PROVIDER=openai-compatible` points goose at any OpenAI-compatible gateway (LiteLLM, vLLM, your own) instead of OpenRouter — without cost reconciliation.

## Hermes via HTTP

For remote execution without local CLIs: a Hermes gateway exposes each role as a profile (= model id at `/v1/models`).

- `HERMES_BASE_URL` + `HERMES_API_KEY` — shared gateway for every role;
- `HERMES_<ROLE>_URL/_KEY/_MODEL` — optional per-role overrides.

Hermes is fire-and-report: the dashboard records dispatch/result, but there is no step-by-step trace, and seat timeouts count total phase time instead of inactivity.

## Per-issue workspace isolation

Every issue gets `$YAOE_HOME/worktrees/issue-<issueId>` (reused across PMO → Dev → Review → Reopened/Blocked until **Completed**; non-default Linear connections use `conn-<connectionId>/issue-<issueId>`). ACP harnesses still mirror HOME/config beside that cwd each spawn:

- Cursor: `issue-<id>-home` neutralizes your `~/.cursor/mcp.json` (avoids "Too many MCP tools" refusals), `~/.gitconfig` enters as a copy, `gh` config is empty, `~/.git-credentials` stays out (`CURSOR_ISOLATE_MCP_CONFIG`).
- Claude Code / Codex: `issue-<id>-claude-config` / `issue-<id>-codex-home` with attribution toggles (`*_ATTRIBUTION` settings). Claude Code skips this isolation on macOS when there is no static credential (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`), to avoid landing on an empty per-path Keychain entry — see the Claude Code note above.
- Git credentials come from the run token (see [github-setup.md](github-setup.md)). The **code** tree is not deleted between runs; it is removed on Completed (webhook) or by the tick's stale-workspace reconcile. `GOOSE_KEEP_WORKSPACES=true` keeps dirs after Completed for debugging.

## Detection, budgets and troubleshooting

- Dashboard → **Harness**: installed/version/auth per harness + budget caps.
- `yaoe-flow status` / `yaoe-flow doctor`: CLI view of the same detection with install/login hints.
- The wizard's steps 7–8 install adapters and report what is missing.
- **Running as a systemd/launchd service and a harness that worked in your terminal fails there** (e.g. an ACP write `EPIPE`, or `acp timeout: initialize`): a service manager only gets the PATH you gave it — not your shell's `~/.bashrc`/`~/.profile`. The most common gap is `node`: `claude-code-acp`/`codex-acp` are npm packages with a `#!/usr/bin/env node` shebang, and if `node` is only reachable via a version manager, a service unit with a hand-written PATH won't find it even though your terminal does. yaoe-flow already looks for nvm's default (or highest installed) version and Volta's shim dir automatically — no unit edit needed, just make sure you're on a version that includes this. If you use a different version manager (asdf, fnm, `n`), add its bin dir to the unit's `Environment=PATH=...` manually.

