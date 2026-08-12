---
type: "Feature"
title: "sync-souls: re-import the bundled SOULs into an existing install (CLI + dashboard)"
description: "New yaoe-flow sync-souls command and Agents → Aplicar SOUL padrão button: plan first, confirm, then a new active version per role with the old SOUL kept in history."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, souls, cli, dashboard, agents, versioning, upgrade]
timestamp: "2026-08-11T00:00:00Z"
---

# `sync-souls` — bringing new SOULs to an already-installed pipeline

## Issues / PRs

- No Linear issue: requested directly by the operator, as the follow-up to [repo-conventions-binding](../repo-conventions-binding/README.md) — that change rewrote `agents/*.SOUL.md`, and there was no way to get the new text into an install that already had agents.

## Problem

`seedAgentsFromSouls()` (`app/src/db/agents.ts`) returns early while `COUNT(*) FROM agents > 0`. That is deliberate — a binary upgrade must never silently overwrite a SOUL the operator tuned on the dashboard — but it leaves no supported path in the other direction: after upgrading, every role keeps dispatching the OLD prompt, and the only workaround was copy-pasting each `agents/*.SOUL.md` into Agents → new version, by hand, per role.

## What changed & where

| Layer | Changed? | Notes |
| --- | --- | --- |
| Core | **Yes** | `app/src/agent/soulSync.ts` (new): `planSoulSync()` (read-only) / `applySoulSync()` / `isSyncable()` / `parseRoleFilter()` — one implementation shared by both surfaces |
| CLI | **Yes** | `app/src/cli/sync-souls.ts` (new) + registration in `app/src/cli/index.ts` (`COMMANDS`, help, dynamic import) |
| API | **Yes** | `GET /api/agents/soul-sync` (plan) and `POST /api/agents/soul-sync` (apply, optional `roles[]`) in `app/src/api/dashboard/agents.ts`; `soulSyncBody` in `agents.schema.ts`. Declared **before** `/:id` — Hono matches in order |
| Dashboard | **Yes** | `dashboard/src/components/SoulSyncButton.tsx` (new): button + plan/confirm/result dialog, wired into the Agents page header; `agentsApi.soulSyncPlan()` / `soulSyncApply()` and the `SoulSyncEntry`/`SoulSyncApplied` types in `lib/api.ts` |
| SOULs / protocol | No | the SOUL *text* is untouched here — this change is only about delivering it |
| Scheduler / harness | No | dispatch resolves the active version per run, so nothing to restart |
| Config | No | no new setting |
| Docs | **Yes** | `docs/agents.md` ("Picking up the SOULs of a new version"), `README.md` CLI table |
| Tests | **Yes** | `app/test/soul-sync.test.ts` (7 cases) |

## The flow, end to end

**CLI** — `yaoe-flow sync-souls [--role <role[,role]>] [--yes]`:

1. Prints one line per role: `⚠️ outdated — "Dev padrão" v3 (a1b2c3d4e5f6, 210 lines) → v4 (9f8e7d6c5b4a, 236 lines)`, `✅ up to date`, `— no active agent for this role`, or `❌ agents/<file> is not bundled in this binary`.
2. Nothing outdated → exits without asking.
3. Otherwise warns that dashboard edits are NOT merged and that the current SOUL stays in history, then asks `Apply the bundled SOULs now?` (default **No**). `--yes` skips the question; a non-TTY without `--yes` refuses instead of writing.
4. Prints `✅ dev: "Dev padrão" v3 → v4 (previous version kept in history)` per role + "No restart needed".

**Dashboard** — Agents → **Aplicar SOUL padrão** (button in the page header, with a warning badge carrying the number of outdated roles):

1. The dialog shows the same plan, per role, with the version numbers, the sha256 prefix of each SOUL and the line counts, plus the warning about local edits.
2. The confirm button reads `Aplicar em N papéis` and is disabled when nothing is outdated (`Tudo atualizado`).
3. After applying, the same dialog turns into the result (`v3 → v4`, "versão anterior mantida no histórico"); the agents list and the plan refetch.

## Guarantees

- **The replaced SOUL is never lost.** `createVersion(..., { activate: true })` is append-only with atomic version numbering: the previous text remains as its own version and can be reactivated (Agents → edit → versions).
- **Only the ACTIVE agent of each role is touched** — alternative variants of the same role are left alone.
- **The plan never writes**, and `applySoulSync` re-plans inside the write, so a plan the dashboard rendered minutes ago can never overwrite something that changed in between.
- **Identity is content-based** (sha256 prefix of the SOUL, normalized for CRLF/trailing whitespace) — re-running is a no-op, not a new version.
- The version comment records where it came from: `sync-souls (dashboard): bundled agents/dev.SOUL.md @ <hash> — previous v3 kept in history`.

## Validation

- `bun test` — 223 pass / 0 fail (7 new: outdated detection, plan is read-only, apply keeps v1 text and activates v2, idempotency, role filter isolation, manual edit makes it outdated again, `parseRoleFilter` rejections).
- `bun run typecheck` clean; `tsc -b` clean on `dashboard/`; `oxlint` shows only the pre-existing fast-refresh warnings.

## Deferred (consciously)

- **No merge/diff between a local edit and the bundled SOUL.** The dialog says so explicitly instead of pretending: the operator who customized a SOUL must re-apply the customization on top of the new version (the old one is one click away in the history). A 3-way merge of prose was judged worse than an honest replacement.
- **No automatic sync on upgrade.** It stays explicit — that is the whole reason the first-boot seed is guarded.
- **`no-agent` roles are not created.** If a role has no active agent, the sync reports it and does nothing; creating an agent is a deliberate act on the Agents screen.
- The dashboard strings follow the existing pt-BR UI of that page (the rest of the repo — code, comments, docs, CLI output — stays English).
