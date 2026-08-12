---
type: concept
title: "A cloned repo's own agent guide is binding"
description: "Every role reads AGENTS.md/CLAUDE.md (and the docs they point at) of each cloned repo; the deliverables they require are part of done."
tags: [protocol, souls, agents-md, claude-md, deliverables, multi-repo]
---

# A cloned repo's own agent guide is binding

Protocol **§14**: right after cloning a repository — and before planning — every role reads that repo's conventions, in priority order `AGENTS.md` → `CLAUDE.md` → `.cursor/rules/*` / `.github/copilot-instructions.md` → `CONTRIBUTING.md` / `PROJECT_MAP.md` / `README.md` → the repo's knowledge/doc directory (`knowledge/`, `.okf/`, `docs/`, `.docs/`, `configdocs/`, `adr/`, …), following the pointers those files contain. `AGENTS.md` and `CLAUDE.md` win on conflict.

These files are instructions, not background reading, and that includes the **deliverables** they require: change bundle / OKF entry, `CHANGELOG.md`, README or product docs describing how the feature works and what must be configured, migration notes, artifact language. A PR that ships code without them is incomplete, not smaller — the Reviewer rejects it.

Conventions are **per repository**. One issue may touch several repos (frontend + backend, plus one read only as reference): each is judged by its own guide, none inherits a sibling's rules, and a reference-only repo is never written to.

Conflict resolution: the protocol and the SOUL win for pipeline behavior (states, comments, footprint, locks); the repo guide wins for everything about that codebase (structure, stack, style, deliverables). A guide never expands the footprint.

This is prompt-level because harness auto-discovery cannot work here: the ACP session opens on the empty issue workspace and the clone lands in a subdirectory afterwards, so `cursor-agent`/Claude Code/Codex never see the project root at session start. See [[okf-ancillary-doc-paths-are-configurable]] for how the doc paths they require survive the scope-check.
