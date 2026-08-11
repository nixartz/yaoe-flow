---
type: "Product Knowledge"
title: "How agents pick up a repository's own conventions"
description: "Protocol §14: every role reads AGENTS.md/CLAUDE.md of each cloned repo; required docs are deliverables, and their paths are ancillary by configuration."
tags: [protocol, souls, agents-md, scope-check, ancillary, multi-repo]
timestamp: "2026-08-11T00:00:00Z"
---

# How agents pick up a repository's own conventions

## Why it is explicit in the prompt

Agents run against repositories that carry their own rules — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*`, a `knowledge/` or `.okf/` directory. None of that is discovered automatically: `session/new` opens the ACP session on the **issue workspace** (`$WORKSPACE_ROOT/issue-<id>/`, see `app/src/agent/workspace.ts`) and the repository is cloned into a subdirectory afterwards, so at discovery time the session root is empty. Cursor, Claude Code and Codex all lose their native rule-file discovery this way.

Pointing the session at the clone instead was rejected on purpose: **one issue may touch several repositories** (frontend + backend, plus one read only as reference), so there is no single project root. The contract lives in the prompt instead — `COMMUNICATION_PROTOCOL.md` **§14**, concatenated to every SOUL, therefore applying to every role and every harness.

## The contract

- After each clone, before planning: `AGENTS.md` → `CLAUDE.md` → other harness rule files → `CONTRIBUTING.md`/`PROJECT_MAP.md`/`README.md` → the repo's knowledge/doc directory, following any pointers found ("read every `knowledge/rules/*.md`"). `AGENTS.md` and `CLAUDE.md` win on conflict.
- **Per repository.** Conventions never transfer between repos of the same issue; a reference-only repo is read, never written to.
- **The deliverables a guide requires are part of "done"** — change bundle/OKF, `CHANGELOG.md`, README/product docs on how the feature works and what to configure, migration notes, artifact language. PMO turns them into per-repo checklist items, Dev announces the guide files in its ▶️ plan and ships the docs in the same PR, Reviewer rejects when they are missing.
- **Precedence:** protocol and SOUL own pipeline behavior (states, comments, footprint, locks); the repo guide owns everything about that codebase. A guide never expands the footprint.

## Why the scope-check has to agree

Process docs are collateral of almost any change (protocol §8.1), so they are never declared in `## Footprint` — declaring them would false-collide every task shipping a change bundle. The deterministic scope-check therefore skips them, and **which paths count is configuration** (`SCOPE_ANCILLARY_DOC_PATHS`), not a constant: with the wrong list the pipeline reopens tasks for the very documentation it demanded, which trains agents to stop writing docs. Keep the list to process docs — ancillary paths also stop serializing tasks by collision.
