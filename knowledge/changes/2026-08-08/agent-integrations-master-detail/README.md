---
type: "Feature Spec"
title: "Agent Integrations tab: master-detail layout with MCP reorder"
description: "Dashboard agent editor Integrations tab uses a 2/4 table + 1/4 detail + 1/4 JSON layout (min-h 660px), drag-and-drop reorder via dnd-kit; Execution tab advanced JSON is also always open."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, dashboard, agents, mcp, ux]
timestamp: "2026-08-08T08:30:00Z"
---

# Agent Integrations master-detail layout

## Issues / PRs

- (local) Operator feedback: Integrations tab stacked full-width MCP cards with advanced JSON collapsed at the bottom — hard to scan and edit many servers.

## What changed

### Dashboard — `McpServersEditor`

- **List (2/4)**: bordered panel with “Adicionar integração…” + sortable table (Name, Type, Destination on xl+). Drag handle per row (`@dnd-kit/sortable`); click row to select.
- **Detail (1/4)**: edit the selected MCP (same fields as before). Scrolls inside the card when content exceeds the panel.
- **Advanced JSON (1/4)**: always open in its own card beside the detail panel (no collapse).
- All three cards share `min-h-[660px]` (stdio form height baseline).
- Order changes from drag-and-drop update `mcpServersJson` the same way as before (array order is the integration order).

### Dashboard — Execução tab

- “JSON avançado” for harness settings is always open (same request as Integrations).

### Dependencies

- Added `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` to `dashboard/`.

### Layers

| Layer | Changed? |
| --- | --- |
| API | No |
| CLI | No |
| Dashboard | Yes |
| Harness | No |
| CI | No |
| Agents / protocol | No |

## FLOW

1. Agents → open agent → tab **Integrações**.
2. Click **Adicionar integração…** → pick preset → row appears and is selected; detail panel shows fields.
3. Drag grip on a row → reorder list; JSON below reflects new order.
4. Edit fields on the right → sticky save bar (unchanged) → **Salvar integrações**.
5. Tab **Execução** → advanced JSON for settings is visible without expanding.

## Deferred

- Persist selection across harness switches.
- Mobile: stack is fine; no separate drawer for detail yet.
- Visual regression / axe CI for this screen (not in dashboard gate today).

## Bugs found in validation

- (none yet — build/typecheck only; UI not clicked in a running daemon in this change set)
