---
type: "Feature Spec"
title: "Backend English pass, markdown line-wrap fix, and README redesign"
description: "Translated runtime-visible backend strings to English, fixed a GitHub markdown rendering quirk across all docs, and redesigned README.md in the Orca/Multica style."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, i18n, docs, readme]
timestamp: "2026-08-02T00:00:00Z"
---

# Backend English pass, markdown line-wrap fix, and README redesign

**Date:** 2026-08-02 (same day as the initial 0.1.0 migration, follow-up pass before the repo had any external consumers).

## Summary

- [What changed and where](#what-changed-and-where)
- [The markdown line-wrap bug](#the-markdown-line-wrap-bug)
- [Backend translation: scope decision](#backend-translation-scope-decision)
- [README redesign](#readme-redesign)
- [Bugs found during validation](#bugs-found-during-validation)
- [Deliberately deferred](#deliberately-deferred)

## What changed and where

| Layer | Changed? | What |
|---|---|---|
| CHANGELOG / GitHub Release | ✅ | Reflowed to single-line paragraphs/items; live v0.1.0 release notes and the workflow (`macos-13` verify job dropped, 10-min job timeouts added — separate small fix) updated to match |
| Docs (README, AGENTS, DESIGN, CONTRIBUTING, SECURITY, docs/, knowledge/) | ✅ | All paragraphs/list items reflowed to one source line each; `README.md` fully redesigned |
| `agents/*.SOUL.md`, `recipes/*.yaml` | ❌ (rule only) | New standing rule added (`knowledge/rules/souls-recipes-single-line.md`) requiring one-line-per-paragraph for these files specifically — not retroactively reformatted this pass |
| Backend (`app/src`) | ✅ (runtime strings only) | Pino log messages, thrown errors, OpenAPI `summary`/`description`, CLI-visible strings translated to English. Code comments explaining *why* were deliberately left in Portuguese |
| `app/scripts/*.ts`, `recipes/build.ts`, `project-map/*`, `sandbox/README.md`, `worker-image/Dockerfile`, Dockerfiles, `docker-compose.yml`, `goose/config.yaml`, `app/drizzle/*.sql` comments | ✅ | Fully translated (comments included — these are configs/scripts, not `app/src` application code) |
| Dashboard (`dashboard/src`) | ❌ (deliberately) | Stays 100% Portuguese — see [Backend translation: scope decision](#backend-translation-scope-decision) |
| `app/test/*.ts` | ❌ | Deferred — dev-internal only, not shipped (see roadmap) |
| `dashboard/.schema-openapi.json` | ✅ | Regenerated from the live `/api/openapi` endpoint (was a stale hand-exported snapshot with no generation script — not hand-translated) |

## The markdown line-wrap bug

GitHub's markdown renderer (unlike strict CommonMark) renders a single newline inside a paragraph or list item as a visible line break, not as a space-joined continuation. Every doc in this repo had been authored with prose manually wrapped across multiple source lines (readable in an editor, but rendering with mid-sentence breaks on GitHub). Fixed with a small Python script (`unwrap_md.py`, not committed — one-off tool) that merges paragraph/list-item continuation lines into a single line, while leaving fenced code blocks, tables, headings, HRs, images, blockquotes and YAML frontmatter untouched. Applied to every project markdown file except `agents/*.SOUL.md`/`recipes/*.yaml` (covered by the new rule instead) and `README.md` (rewritten from scratch).

One real bug the unwrap surfaced: a `` ` ``…`` ` `` inline code span in `knowledge/product/architecture.md` had been hard-wrapped across two lines (`` `REFINING/IN_PROGRESS/IN_REVIEW/MERGE `` + `` _TIMEOUT_MS` ``), which would already have rendered with a stray space even before this pass — fixed by spelling out all four setting names explicitly instead of the ambiguous shorthand.

## Backend translation: scope decision

Two scope corrections happened mid-pass, both driven by explicit user feedback:

1. **Dashboard UI**: initially started hardcoding English strings directly into `dashboard/src` components (6 files: Layout, Login, Overview, Live, History, Logs, Webhooks). The user caught this immediately — hardcoding English destroys the Portuguese original with no way back, and the dashboard actually needs proper **i18n (react-intl)**, not a one-way translation. All 6 files were reverted via `git checkout` before anything was committed. The dashboard stays 100% Portuguese; react-intl is now a tracked roadmap item.
2. **Backend comments vs. runtime strings**: the user narrowed "translate the backend too" to *log/error messages only*, not code comments (which encode non-obvious design rationale and are lower-visibility/lower-risk to leave as-is for now). ~914 lines of Portuguese comments remain in `app/src` (down from the initial estimate once dashboard scope was corrected); only the ~90 genuinely runtime-visible strings (Pino `log.*()` calls, `throw new Error()`, OpenAPI route descriptions, CLI-visible text) were translated.

A third nuance surfaced translating `readiness/evaluate.ts`: its `reason()` text is rendered directly inside the (Portuguese) dashboard Readiness page (`dashboard/src/pages/Readiness.tsx` → `r.detail`). Translating it to English while the surrounding dashboard chrome stays Portuguese is an inherent, temporary inconsistency of the phased approach (full consistency returns once react-intl ships) — translated anyway, since it lives in `app/src` and the instruction was scoped by *file location*, not by *where the string eventually renders*.

## README redesign

Restructured `README.md` in the style of [Orca](https://github.com/stablyai/orca) and [Multica](https://github.com/multica-ai/multica) (already studied for the original AGENTS.md/DESIGN.md pass): a centered hero block (title/tagline/badges/quick-nav), more tables (roles, features-as-table, install-as-table, license-as-table), and a 2×2 screenshot grid using the existing dashboard captures (`docs/images/dashboard/`). No new screenshots were taken — the existing ones already show the real (Portuguese) UI accurately.

## Bugs found during validation

- **Stale `HTTP-Referer`**: `app/src/openrouter/reconcile.ts` still pointed the OpenRouter request header at `https://github.com/nixartz/ai-agents` (the old monorepo) — caught while translating the surrounding log line, fixed to `nixartz/yaoe-flow`.
- **Stale doc cross-references**: `app/src/agent/harness/hermes.ts`, `app/src/cli/setup/harnessDeps.ts` and `recipes/README.md`/`recipes/build.ts` still pointed at `docs/goose-setup.md`/`docs/hermes-setup.md`, which no longer exist post-migration (renamed to `docs/harnesses.md`) — fixed alongside the translations that touched those lines.
- **Test assertion on translated text**: `app/test/acp-contract.test.ts` asserted `/provider error persistiu/` against a thrown error message — broke when that message was translated; updated the regex to `/provider error persisted/`.
- **`dashboard/.schema-openapi.json` was a stale, disconnected snapshot** — no script in the repo regenerates it. Rather than hand-translating 178KB of stale JSON, regenerated it for real by booting the service locally and fetching the live `/api/openapi` endpoint.

## Deliberately deferred

See `knowledge/product/roadmap.md`: dashboard i18n (react-intl), `app/src` code comments, `app/test/*.ts` translation.

