---
type: "Concept"
title: "Issue workspace holding states"
description: "Which Linear statuses keep an on-disk issue workspace under WORKSPACE_ROOT."
tags: [workspace, scheduler, disk]
timestamp: "2026-08-07T00:00:00Z"
---

# Issue workspace holding states

On-disk dirs `issue-<issueId>` (and harness siblings) are kept while the issue is in:

- Refining, Planned, In Progress, Code Review, In Review, Reopened, Pending Merge, Blocked

They are removed on **Completed** (and any other non-holding state) via webhook or `reconcileStaleWorkspaces()`. This set is **broader** than footprint lock-holding (Planned/Refining keep the workspace without holding a lock).
