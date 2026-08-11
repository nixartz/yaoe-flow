---
type: concept
title: "SOULs reach an existing install only through an explicit sync"
description: "The first-boot seed is guarded, so sync-souls (CLI) and Agents → Aplicar SOUL padrão (dashboard) are the supported path — plan, confirm, append a new active version."
tags: [souls, versioning, upgrade, cli, dashboard, agents]
---

# SOULs reach an existing install only through an explicit sync

`seedAgentsFromSouls()` imports `agents/*.SOUL.md` **only while the `agents` table is empty**. Upgrading the binary therefore changes the SOULs in git and in the embedded assets, but not the versions the pipeline actually dispatches. This is a feature — an upgrade must not overwrite what an operator tuned — and it means every SOUL change needs a second, explicit step to take effect on an install.

That step is `app/src/agent/soulSync.ts`, shared by both surfaces: `yaoe-flow sync-souls` and the dashboard button **Agents → Aplicar SOUL padrão** (`GET`/`POST /api/agents/soul-sync`).

Two phases, always in this order:

1. **`planSoulSync()` — read-only.** Per role: the SOUL bundled in the running binary vs. the active version in the database, compared by sha256 of the normalized text (CRLF and trailing whitespace are not "a change"). Statuses: `outdated`, `up-to-date`, `no-agent`, `no-seed`.
2. **`applySoulSync()` — writes only what the plan flagged**, re-planning inside the write so a stale plan from a browser tab cannot overwrite a version created in the meantime.

The write is `createVersion(agentId, seed, comment, createdBy, { activate: true })`: append-only. **The SOUL being replaced is never destroyed** — it stays in the agent's history and can be reactivated from Agents → edit → versions. Only the ACTIVE agent of each role is touched; alternative variants of the same role are left alone. Nothing restarts: dispatch resolves the active version per run.

Local edits are **not** merged. The bundled text becomes a new version on top of the operator's; both surfaces state that before confirming, and confirmation is mandatory (the CLI defaults to No and refuses on a non-TTY without `--yes`).

Practical consequence for anything that changes agent behavior — including [[okf-repo-conventions]]: shipping the SOUL edit is half the work; the release notes have to tell operators to run the sync, or the change reaches new installs only.
