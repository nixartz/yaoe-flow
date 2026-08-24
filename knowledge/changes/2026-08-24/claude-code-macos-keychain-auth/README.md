# Claude Code: "Authentication required" on macOS with a subscription login

## Issue

Reported directly by the operator (no Linear issue): Claude Code worked fine
when run manually (`claude -p "..."`) on a macOS machine, but every ACP turn
dispatched through yaoe-flow failed with `Authentication required` (ACP error
code -32000), converted from the CLI's synthetic "Please run /login" message.

## Root cause

`prepareClaudeCodeAttribution` (`app/src/agent/harness/claudeCode.ts`) points
`CLAUDE_CONFIG_DIR` at a fresh per-run directory (mirrored from `~/.claude` via
symlinks) so the `CLAUDE_CODE_ATTRIBUTION` toggle can rewrite `settings.json`
without touching the operator's real `~/.claude/settings.json`.

On macOS, Claude Code stores subscription/OAuth credentials in the system
Keychain under a service name derived from the **literal** `CLAUDE_CONFIG_DIR`
value: unset/default → `Claude Code-credentials`; any custom path → a distinct
`Claude Code-credentials-<sha256(path)[:8]>` entry. Confirmed empirically with
`security dump-keychain login.keychain-db` on the reporting machine — the
default entry existed and was authenticated, while a previously-generated
per-run entry (`Claude Code-credentials-48f7fece`) existed but was never
logged into. Every fresh issue workspace produces a brand-new `CLAUDE_CONFIG_DIR`
path, hence a brand-new, empty Keychain namespace — the CLI never finds
credentials there, regardless of how well the rest of `~/.claude` is mirrored
(there is nothing file-based to mirror for auth on macOS; `~/.claude/.credentials.json`,
which the mirror *would* correctly symlink, simply doesn't exist there).

This is the same category of issue already documented for Cursor's per-run
HOME mirror (`docs/harnesses.md`: "browser/keychain login breaks under the
per-run HOME mirror") — headless/subscription login and per-run filesystem
isolation don't mix on macOS Keychain-backed credential stores.

## Fix

`app/src/agent/harness/claudeCode.ts`:

- New `shouldSkipConfigIsolation(env, platform)`: true when `platform === "darwin"`
  and none of `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`
  is set (i.e. auth relies on the Keychain-backed subscription login).
- `prepareClaudeCodeAttribution` now checks this first and, when true, returns
  the env untouched (no `CLAUDE_CONFIG_DIR` override) — the run authenticates
  against the operator's real `~/.claude`, exactly like a manual `claude` run.
  The `CLAUDE_CODE_ATTRIBUTION` toggle is a no-op for that run (logged at
  `info`, not `warn` — this is expected behavior, not a failure).
- When a static credential is present (API key or long-lived OAuth token,
  which don't touch the Keychain) or the platform isn't macOS (Linux mirrors
  `.credentials.json` correctly via the existing symlink), isolation proceeds
  exactly as before — attribution keeps working there.

No changes to the ACP client, permission handling, or dispatch — `--yolo` /
`--dangerously-skip-permissions` were never relevant here: the ACP client
already auto-resolves `session/request_permission` (`allow_always`), so the
Claude CLI never needs an interactive bypass flag under yaoe-flow.

## What changed / what did NOT

- **Harness** (`app/src/agent/harness/claudeCode.ts`): changed, as above.
- **Tests** (`app/test/harness-attribution.test.ts`): added coverage for
  `shouldSkipConfigIsolation` and both branches of `prepareClaudeCodeAttribution`
  (darwin without credential → no isolation; darwin with `ANTHROPIC_API_KEY` →
  isolation as before).
- **Docs** (`docs/harnesses.md`): documented the macOS caveat next to the
  existing Cursor Keychain caveat, and cross-referenced it from the per-issue
  isolation section.
- **Not changed**: API, CLI, dashboard, config registry, other harnesses
  (Cursor/Codex/Copilot/Goose/Hermes), Linear/GitHub integration, ACP
  permission handling.

## Deferred

- No attempt was made to make attribution work on macOS without a static
  credential (e.g. by proactively duplicating the Keychain item via `security`).
  That path is unreliable: Keychain access-control lists are typically scoped
  to the code signature of the process that created the item, and copying a
  secret from a different, non-code-signed-matching process would need an
  interactive OS permission prompt — not viable for a headless daemon.
