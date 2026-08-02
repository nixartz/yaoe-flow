# MCP configuration per agent

How to wire MCP servers (Linear, GitHub, Hindsight, custom) into each agent so
it can interact with the outside world.

## Summary

- [Where](#where)
- [Presets](#presets)
- [Custom servers](#custom-servers)
- [The secrets model (envKeys)](#the-secrets-model-envkeys)
- [Recommended per role](#recommended-per-role)

## Where

Dashboard → **Agents** → pick the agent → **MCP servers**. The config is
harness-agnostic: the same list becomes Goose extensions, ACP session servers,
etc., depending on the agent's harness.

## Presets

The "Add integration" picker ships known-good presets (mirroring the default
agents):

| Preset | Type | What it configures |
|---|---|---|
| **Linear** | stdio | `npx -y @tacticlaunch/mcp-linear`, credential via `LINEAR_API_TOKEN`, timeout 300s |
| **GitHub (read/write)** | stdio | `github-mcp-server stdio`, `GITHUB_TOOLSETS=repos,pull_requests`, credential via `GITHUB_PERSONAL_ACCESS_TOKEN` |
| **GitHub (read-only)** | stdio | same, with `GITHUB_TOOLSETS=repos` + `GITHUB_READ_ONLY=1` — ideal for PMO |
| **Developer (builtin)** | builtin | the harness's native shell/files/git extension |
| **Hindsight (memory)** | HTTP | `http://hindsight:8888/mcp/<bank>/` with `Authorization: Bearer ${HINDSIGHT_API_KEY}` |
| **Custom…** | — | blank card, fully manual |

After adding a preset you can still edit every field.

## Custom servers

Three types:

- **builtin** — a native extension of the harness (name only).
- **stdio** — a process the harness spawns: command, args, fixed env values
  (`envs`), secret env NAMES (`envKeys`), timeout.
- **streamable_http** — an HTTP MCP endpoint: URL, headers, timeout.

The "Advanced JSON" panel edits the raw array (same shape as
`app/src/agent/recipe/defaults.ts` → `McpServerConfig`).

## The secrets model (envKeys)

Secrets are referenced by **name**, never by value:

- stdio: list the variable names in `envKeys` (e.g. `LINEAR_API_TOKEN`); the
  dispatch resolves them from the run environment (which is fed from the
  encrypted settings).
- HTTP: use `${VAR}` placeholders in headers (e.g.
  `Authorization: Bearer ${HINDSIGHT_API_KEY}`) — resolved at runtime.

Nothing secret is ever written into the agent config, a recipe file or the
database rows for MCPs.

## Recommended per role

| Role | MCPs |
|---|---|
| PMO | Linear + GitHub (read-only) + Developer |
| Dev | Linear + GitHub (read/write) + Developer |
| Reviewer | GitHub (read/write) + Linear + Developer |
| Orchestrator | Linear + GitHub (read/write) + Developer |

Add Hindsight to any role you want long-term memory for (requires
`HINDSIGHT_API_KEY` in the settings).
