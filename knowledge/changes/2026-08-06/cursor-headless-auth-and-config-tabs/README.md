---
type: "Feature Spec"
title: "Cursor headless auth, CURSOR_API_KEY, and Config tab categories"
description: "Fix Cursor ACP auth under isolated HOME / systemd (file credential store + API key), interactive login wait in the run chat and Harness UI, and restore Config sidebar categories after the EN registry rename."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, harness, cursor, config, dashboard, auth]
timestamp: "2026-08-06T00:00:00Z"
---

# Cursor headless auth, CURSOR_API_KEY, and Config tab categories

## Issues / PRs

- (local) Operator report: Cursor harness opened a browser / failed with `cursor-user` keychain under systemd and on a workstation after repo migration; Config UI dumped most settings into "Somente leitura / legado".

## What changed

### Harness / Cursor (API + agent)

- Per-run Cursor spawn now forces `AGENT_CLI_CREDENTIAL_STORE=file` and `NO_OPEN_BROWSER=1` so the CLI does not probe the macOS `cursor-user` keychain against the isolated HOME (root cause of "no browser" / keychain errors).
- New secret setting `CURSOR_API_KEY` (registry + encrypted DB + Config/Harness UI). Resolved with precedence agent `settings.apiKey` > config (ENV>db) > process env; passed as `--api-key` before `acp` when set.
- Mirror source HOME is the daemon user profile (`cursorDaemonHome`), never a leaked `run-*-home` worktree path.
- On ACP authenticate failure with a `loginDeepControl` URL (or equivalent), the run chat shows the URL + instructions, waits up to 5 minutes for auth (API key or CLI file login), then retries the turn once.
- Dashboard **Harness → Cursor**: "Log in to Cursor" starts `cursor-agent login` with `NO_OPEN_BROWSER`, surfaces the URL, polls status; settings for Cursor (including API key) appear on the card again.

### Dashboard Config tabs

- `GROUP_TO_CATEGORY` in `dashboard/src/lib/settingsUi.ts` was still keyed by Portuguese / legacy group names while `registry.ts` groups are English → almost everything fell through to `readonly` ("Somente leitura / legado"). Map updated to EN names (PT kept as aliases).
- Same mismatch emptied Goose/Hermes/Cursor settings on the Harness page (`SETTINGS_GROUP_BY_HARNESS`); aligned to current registry groups.

### Layers

| Layer | Changed? |
| --- | --- |
| API | Yes — harness cursor login routes; settings registry |
| CLI | No (wizard unchanged) |
| Dashboard | Yes — Config categories, Harness Cursor login + settings |
| Harness | Yes — Cursor spawn/auth |
| CI / docs | Yes — `docs/harnesses.md`, tests |

## FLOW (UI)

1. **Config**: sidebar categories show Service / Capacity / Linear / … again; `CURSOR_API_KEY` under Harness (avançado).
2. **Harness → Cursor**: expand card → set API key (save bar) **or** click **Log in to Cursor** → open printed URL on a laptop → status becomes Conectado.
3. **Live run**: if auth is still missing, agent chat shows the login URL / instructions and waits; after Config/Harness login, the turn retries.

## Deferred

- Skipping ACP `authenticate` entirely when `--api-key` is present (depends on Cursor CLI behavior; we still call `cursor_login` as documented).
- Persisting interactive login sessions across daemon restarts beyond the CLI file store.

## Validation notes

- Unit tests: `cursor-auth.test.ts`, extended `cursor-isolation.test.ts`.
- Manual: set `CURSOR_API_KEY` on a headless host and confirm dispatch no longer opens a browser; confirm Config tabs populate after reload without editing a setting first.
