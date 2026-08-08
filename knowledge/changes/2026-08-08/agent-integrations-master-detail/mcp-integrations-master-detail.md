---
type: "Concept"
title: "MCP integrations editor master-detail"
description: "Holding state for the agent Integrations UI: list + selected detail + always-open JSON."
tags: [yaoe-flow, dashboard, mcp, master-detail]
timestamp: "2026-08-08T08:30:00Z"
---

# MCP integrations editor (master-detail)

## Holding states

| Region | Role |
| --- | --- |
| List (left 2/4) | Scan, add, reorder, select |
| Detail (middle 1/4) | Edit one MCP; remove |
| JSON (right 1/4) | Escape hatch; always open; source of truth string still `mcpServersJson` |

Panels share `min-h-[660px]` (stdio form baseline).

## Selection

- Stable client row IDs (UUID) for dnd-kit; not persisted.
- Selecting a row drives the detail panel; add selects the new row; remove clears/falls back to first.

## Order

- Array order in `mcpServersJson` is the integration order used by the harness config.
- Drag-and-drop and JSON edits both mutate that array.
