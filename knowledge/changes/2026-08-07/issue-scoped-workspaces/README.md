---
type: "Feature Spec"
title: "Issue-scoped durable workspaces until Completed"
description: "Reuse worktrees/issue-<id> across all harnesses (ACP/Goose/…) for the full pipeline; delete on Completed webhook and via tick stale-workspace reconcile."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, workspace, harness, acp, scheduler]
timestamp: "2026-08-07T00:00:00Z"
---

# Issue-scoped durable workspaces until Completed

## Issues / PRs

- (local) Operator request: keep clones across Reopened/Blocked so agents do not re-clone and re-implement; self-heal disk when Completed webhook is missed.

## What changed

### Agent / Harness

- Dispatch cwd is `issue-<issueId>` (or `conn-<connectionId>/issue-<issueId>`) instead of `run-<runId>` when an issue id is present.
- ACP adapters, Goose, and native stream-json adapters call `cleanupAfterRun`: **issue** dirs are kept; only ephemeral `run-*` dirs are removed after a run. ACP `prepareSpawn` cleanup (HOME/config mirrors) is skipped for issue workspaces so siblings survive until Completed (Cursor still remirrors at the next spawn start).
- Tick also sweeps orphan top-level `run-*` leftovers (crashes / pre-migration) via `removeOrphanEphemeralRunDirs`, sparing in-flight dispatch cwds.
- Harness HOME/config siblings (`-home`, `-cursor-config`, …) still remirror per spawn for isolation; they are deleted with the issue tree on Completed.

### Scheduler

- `onStatusChange(Completed)` calls `removeIssueWorkspace`.
- `reconcileStaleWorkspaces()` on each connection tick: lists on-disk issue dirs for that connection, `getIssue`s, removes when state ∉ {Refining, Planned, In Progress, Code Review, In Review, Reopened, Pending Merge, Blocked}.
- `GOOSE_KEEP_WORKSPACES=true` skips deletion after Completed (debug).

### Layers

| Layer | Changed? |
| --- | --- |
| API | No |
| CLI | No |
| Dashboard | No |
| Harness / Scheduler | Yes |
| Docs | Yes — architecture, harnesses, README |

## FLOW

1. PMO dispatch creates `…/worktrees/issue-<uuid>/` and clones.
2. Run ends → directory **stays**.
3. Dev / Review / Reopened / Blocked reuse the same path.
4. Completed (webhook) or tick stale reconcile → `rm -rf` issue dir + siblings.

## Deferred

- Migrating leftover `run-*` dirs from older builds (operator can delete manually).
- ~~Optional dashboard "open workspace path" affordance.~~ Resolved 2026-08-11 as display + copy (not a literal "open", since the dashboard may run on a different machine than the daemon): [knowledge/changes/2026-08-11/dashboard-integration-and-workspace-affordances](../../2026-08-11/dashboard-integration-and-workspace-affordances/README.md).

## Validation notes

- Unit: `app/test/issue-workspace.test.ts`, extended `cursor-auth.test.ts`.
- Manual: dispatch PMO then Dev on same issue and confirm cwd path is identical and clones persist under `~/.yaoe-flow/worktrees/`.
- Double-check (2026-08-07): fixed ACP `prepareSpawn` cleanup wiping issue HOME each run; moved orphan `run-*` sweep out of the per-connection loop (so rate-limited first connection cannot skip it); empty `conn-*` parents removed after last issue workspace.
