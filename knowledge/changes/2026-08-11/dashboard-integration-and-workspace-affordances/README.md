---
type: "Feature Spec"
title: "Dashboard: persist MCP selection across harness switches + run workspace path affordance"
description: "Agent editor Integrations tab keeps the selected MCP row when switching tabs/harnesses (state lifted to survive Radix Tabs remount); RunDetailSheet's Configuração tab shows the on-disk workspace path for issue-scoped runs."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, dashboard, agents, mcp, run-detail, workspace]
timestamp: "2026-08-11T00:00:00Z"
---

# Dashboard integration and workspace affordances

## Issues / PRs

- Deferred item from [knowledge/changes/2026-08-08/agent-integrations-master-detail](../../2026-08-08/agent-integrations-master-detail/README.md): "Persist selection across harness switches."
- Deferred item from [knowledge/changes/2026-08-07/issue-scoped-workspaces](../../2026-08-07/issue-scoped-workspaces/README.md): "Optional dashboard 'open workspace path' affordance."

## What changed

### 6a. MCP row selection survives tab switches and harness switches

`McpServersEditor` used to keep both the selected-row id and the ephemeral row ids (used as React/dnd-kit keys, generated with `crypto.randomUUID()`) in its own component-local `useState`. The Integrations tab's selection is rendered inside a Radix `TabsContent`, which **unmounts its content when the tab is not active** (default Radix behavior) — so every time an operator switched to Comportamento/Execução and back, `McpServersEditor` fully remounted and regenerated a fresh set of random row ids. A `selectedId` lifted into `AgentEditor` alone could never match any id in the newly-generated set, so the reconciliation effect always fell back to the first row, silently resetting the selection — the exact bug the "persist selection" deferred item asked to fix, and initially still present in the first pass of this change (found by clicking through the running dashboard, not by `tsc`/build, which stayed green throughout).

Fix: both `selectedId` **and** `rowIds` are now fully controlled props (`selectedId`/`onSelectId`, `rowIds`/`onRowIdsChange`), lifted into `AgentEditor` as two maps keyed by harness id (`Record<harnessId, ...>`), so a stored selection remains addressable across any remount, and switching the Execução tab's harness restores that harness's own last-selected row independently.

- `dashboard/src/components/McpServersEditor.tsx`: removed the internal `useState` for `rowIds`/`selectedId`; both are now controlled props. `reconcileRowIds` (grow: append new ids, shrink: truncate) still runs on every render to stay aligned with `mcpServersJson` length, but writes through `onRowIdsChange` instead of local state.
- `dashboard/src/pages/AgentEditor.tsx`: `McpsTab` takes `selectedId`/`onSelectId`/`rowIds`/`onRowIdsChange`; `AgentEditor` holds `mcpSelection`/`mcpRowIds` state (both `Record<harnessId, ...>`), keyed by `data.agent.activeHarnessId`.

### 6b. Workspace path on the run detail sheet

`GET /api/runs/:id` now returns a `workspacePath` field, computed on read (not stored) from the run's `issue_id`/`linear_connection_id` via the existing `issueWorkspaceCwd(issueId, connectionId)` helper (`app/src/agent/workspace.ts`) — `null` for runs with no `issue_id` (e.g. ad-hoc backend-level runs). No schema change.

`RunDetailSheet`'s "Configuração" tab (`SnapshotTab`) renders a new `WorkspacePathRow` above the existing snapshot/recipe content — a labeled, truncated, copyable path (`CopyableId` with a new `kind: "path"`, label "Workspace path") — for both branches of `SnapshotTab` (with a resolved-config snapshot, and the legacy `RecipeTab` fallback for older runs), since previously the `!snapshot` branch rendered `RecipeTab` alone with nothing else. Renders nothing (not even the label) when `workspacePath` is `null`.

This is **display + copy only**, not "open in file manager" — the dashboard is browser-based and may be viewed from a different machine than the daemon, so an "open" action would be misleading. Stated explicitly here so this reading isn't silently assumed later.

- `app/src/api/dashboard/runs.ts`: `GET /runs/:id` handler adds `workspacePath`.
- `dashboard/src/lib/api.ts`: `runsApi.get` return type includes `workspacePath: string | null`.
- `dashboard/src/components/CopyableId.tsx`: new `IdKind` value `"path"` → label "Workspace path".
- `dashboard/src/components/RunDetailSheet.tsx`: `WorkspacePathRow` + `SnapshotTab` restructuring described above.

### Layers

| Layer | Changed? |
| --- | --- |
| API | Yes — `GET /api/runs/:id` response gains `workspacePath` |
| CLI | No |
| Dashboard | Yes |
| Harness | No |
| CI | No |

## FLOW

### 6a
1. Agents → open agent → tab **Integrações** → click a row (e.g. "linear") → detail panel shows it selected.
2. Switch to tab **Comportamento** or **Execução**, then back to **Integrações** → "linear" is still selected (previously reset to the first row).
3. Tab **Execução** → switch the active harness → tab **Integrações** → that harness's own last-selected row is restored (selections are independent per harness).

### 6b
1. Histórico (or Ao vivo) → click a run row → sheet opens → tab **Configuração**.
2. For a run with an `issue_id`: a "Workspace no disco do daemon" row shows the truncated path with a copy button, above the existing snapshot/recipe content.
3. For a run with no `issue_id` (e.g. a backend-level/manual dispatch): the row does not render; only the existing snapshot/recipe content shows.

## Validation

- `cd app && bun test` and `bun run typecheck`: pass.
- `cd dashboard && bun run build` (dashboard has no separate `typecheck` script — `build` runs `tsc -b` first): pass, both before and after the fix in 6a.
- Manual, in a running `bun dev` (API :4790/:4791) + `dashboard` Vite dev server (:5173), logged in as a temporary verification user created for this session (deleted afterward, see below):
  - 6a: reproduced the tab-remount selection bug live (click "linear" for Cursor → switch tab → back → saw "github" instead), fixed by lifting `rowIds`, re-verified the full cycle (tab switch persistence, harness switch independence) — all correct after the fix.
  - 6b: opened a run with an `issue_id` and confirmed via `fetch('/api/runs/<id>')` from the browser console that `workspacePath` matches `issueWorkspaceCwd(issueId, DEFAULT_CONNECTION_ID)` (`/Users/lucas/.yaoe-flow/worktrees/issue-<uuid>`), and that the UI renders + copies it.
  - 6b: opened a run with no `issue_id` and confirmed the workspace-path row correctly does not render (`workspacePath: null`). The rest of the Configuração tab appeared blank for this particular run in the automated browser tab used for verification; traced it to `RecipeTab`'s query getting stuck at `fetchStatus: "paused"` because the tab's `document.visibilityState` was `"hidden"` (a quirk of the automated/headless browser tooling putting `TanStack Query`'s online/focus manager in a stuck state), not a defect in this change — a direct `fetch()` to the same recipe endpoint from the console succeeded and returned the expected 404 body (`AGENT_BACKEND` on the dev instance wasn't `goose`), confirming the backend and the component's error-branch logic are both correct; a normal foregrounded browser tab does not hit this.

## Bugs found in validation

- **MCP row selection reset on every tab switch, not just harness switch** (6a) — root cause and fix described above. This confirms why "start the dev server and use the feature" is required: `tsc`/`bun run build` stayed green through the broken version.

## Deferred

- Dashboard has no component-test suite to extend (`bun test` is `app/`-only contract tests per `AGENTS.md`); both changes were verified by manual click-through only, not automated UI tests.
- `.claude/launch.json` was added during this change's manual verification workflow but ended up unused (dev servers were started directly instead); left in the repo as a convenience for future `bun dev` + dashboard sessions.
