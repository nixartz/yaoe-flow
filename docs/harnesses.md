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

- **Claude Code**: needs the `claude` CLI logged in + the ACP adapter `@zed-industries/claude-code-acp` (npm; the wizard installs it).
- **Codex**: needs the `codex` CLI + the `codex-acp` adapter (npm).
- **Cursor**: needs `cursor-agent` (official installer: `curl -fsS https://cursor.com/install | bash`) — ACP is native.
- **Copilot**: needs the `copilot` CLI — detection/report supported.

Because sessions live in the logged-in user's HOME, the daemon runs as that user (it refuses root) and works best on a workstation or a VM where you have logged the CLIs in once.

## Goose via ACP (OpenRouter BYOK)

[Goose](https://block.github.io/goose/) runs any model through your own OpenRouter key:

1. Install goose (wizard offers it) and set `OPENROUTER_API_KEY` (wizard step 7, or dashboard Config — encrypted).
2. Pick harness "goose" for the agent and set its model (e.g. `anthropic/claude-sonnet-4.5`).
3. Optional: enable the OpenRouter **Auto Router** or per-recipe model preferences (`OPENROUTER_AUTO_*` settings).

Cost reconciliation: a local proxy (`OPENROUTER_PROXY_PORT`) captures generation ids; when the run ends, official token/cost numbers are pulled into the dashboard (`OPENROUTER_RECONCILE`).

`GOOSE_PROVIDER=openai-compatible` points goose at any OpenAI-compatible gateway (LiteLLM, vLLM, your own) instead of OpenRouter — without cost reconciliation.

## Hermes via HTTP

For remote execution without local CLIs: a Hermes gateway exposes each role as a profile (= model id at `/v1/models`).

- `HERMES_BASE_URL` + `HERMES_API_KEY` — shared gateway for every role;
- `HERMES_<ROLE>_URL/_KEY/_MODEL` — optional per-role overrides.

Hermes is fire-and-report: the dashboard records dispatch/result, but there is no step-by-step trace, and seat timeouts count total phase time instead of inactivity.

## Per-run isolation

Every run gets `$YAOE_HOME/worktrees/run-<id>` and, for ACP harnesses, an isolated HOME mirror:

- Cursor: per-run HOME neutralizes your `~/.cursor/mcp.json` (avoids "Too many MCP tools" refusals), `~/.gitconfig` enters as a copy, `gh` config is empty, `~/.git-credentials` stays out (`CURSOR_ISOLATE_MCP_CONFIG`).
- Claude Code / Codex: per-run `CLAUDE_CONFIG_DIR` / `CODEX_HOME` with attribution toggles (`*_ATTRIBUTION` settings).
- Git credentials come from the run token (see [github-setup.md](github-setup.md)); workspaces are deleted after the run (`GOOSE_KEEP_WORKSPACES=true` keeps them for debugging).

## Detection, budgets and troubleshooting

- Dashboard → **Harness**: installed/version/auth per harness + budget caps.
- `yaoe-flow status` / `yaoe-flow doctor`: CLI view of the same detection with install/login hints.
- The wizard's steps 6–7 install adapters and report what is missing.

