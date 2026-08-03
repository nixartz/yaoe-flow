# Goose recipes

[Goose](https://block.github.io/goose/) recipes used when yaoe-flow runs with `AGENT_BACKEND=goose`. One recipe per pipeline role, with the **SOUL** embedded in the `instructions` field:

| Recipe | Role | Generated from |
|---|---|---|
| `pmo.yaml` | refinement (To Do→Refining→Planned) | `agents/pmo.SOUL.md` |
| `dev.yaml` | implements/fixes | `agents/dev.SOUL.md` |
| `reviewer.yaml` | reviews the PR | `agents/reviewer.SOUL.md` |
| `orchestrator.yaml` | planning + merge | `agents/orchestrator.SOUL.md` |

## Single source of truth

**Do not edit the `.yaml` files by hand.** They are generated from the SOULs in `agents/` (+ `agents/COMMUNICATION_PROTOCOL.md`, concatenated into `instructions`). To change an agent's behavior, edit the SOUL and regenerate:

```bash
bun recipes/build.ts        # run from the yaoe-flow repo root
```

The generator validates the resulting YAML (via `Bun.YAML`, when available).

## What each recipe carries

- `instructions` — the SOUL + the communication protocol (the agent's system prompt).
- `prompt` — the starting instruction (headless); via ACP the real input arrives in the `prompt` message (`issueId`/`mode`).
- `settings.goose_provider` / `goose_model` — configurable at generation time via env (defaults: `openrouter` + `qwen/qwen3-coder`). See [docs/harnesses.md](../docs/harnesses.md).
- `extensions` — per-role MCPs (Linear / GitHub / `developer`). **Credentials** enter via **`env_keys`** (name only: `LINEAR_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`); Goose resolves the value from its own keyring/environment — the secret **never lives in the `.yaml`**. See [docs/mcp-configuration.md](../docs/mcp-configuration.md).

## Task input (issueId / mode)

Not a recipe parameter: it arrives in the **`prompt` message** (`issueId: …\nmode: …`), exactly as the SOUL already expects — same as the Hermes backend. Keeps both backends symmetric.

## How they are used (ACP)

The service runs with `AGENT_BACKEND=goose` and **spawns `goose acp`** per dispatch, passing the recipe via **deeplink** (`base64(JSON(recipe))`) in `newSession` — the service computes this from the `.yaml` itself (nothing to register on a server). Role→recipe is mapped by `GOOSE_<ROLE>_RECIPE` in `.env`. Use the `Dockerfile.goose` image (orchestrator + goose + these recipes). Details, provider and checklist in [docs/harnesses.md](../docs/harnesses.md).
