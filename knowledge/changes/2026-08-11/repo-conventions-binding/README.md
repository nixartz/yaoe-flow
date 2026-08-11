---
type: "Feature"
title: "Repo conventions are binding (protocol §14) + configurable ancillary doc paths"
description: "Agents now read AGENTS.md/CLAUDE.md of every cloned repo and ship the deliverables it requires; the scope-check's process-doc allowlist became a setting."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, souls, protocol, agents-md, scope-check, ancillary, okf, config]
timestamp: "2026-08-11T00:00:00Z"
---

# Repo conventions are binding (§14) + configurable ancillary doc paths

## Issues / PRs

- No Linear issue: reported directly by the operator — features implemented through the pipeline (Cursor harness over ACP) shipped correct code but skipped the OKF bundles, CHANGELOG entries and feature documentation the target repo's `AGENTS.md` requires.

## Root cause

Three independent causes, all of them "the guide never reached the model":

1. **The Dev SOUL only asked for `AGENTS.md` when the repo was yaoe-flow itself.** `agents/dev.SOUL.md` read *"if the repo you're working on is the yaoe-flow itself […] also read its `AGENTS.md`"* — for any other repository nothing instructed reading `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` / doc directories. `COMMUNICATION_PROTOCOL.md` never mentioned them either, and PMO never translated them into acceptance criteria, so the deliverables were absent from the prompt end-to-end.
2. **Harness auto-discovery cannot fire.** `session/new` receives `cwd = resolveDispatchCwd(...)` = `$WORKSPACE_ROOT/issue-<id>/` (`app/src/agent/acp/client.ts`, `app/src/agent/workspace.ts`); the repository is cloned into a subdirectory *after* the session opens, so the session root is empty at discovery time. This affects every ACP harness (Cursor, Claude Code, Codex), not just Cursor. Not fixed here — see Deferred.
3. **The scope-check could punish the documentation.** `isAncillaryScopePath` hardcoded this repo's own layout (`CHANGELOG.md`, `knowledge/changes/**`); a project whose change bundles live elsewhere (`docs/changes/**`, `.okf/**`, `configdocs/**`) had them flagged as out-of-footprint → Reviewer reopen — negative pressure against writing the docs at all.

## What changed & where

| Layer | Changed? | Notes |
| --- | --- | --- |
| API | No | — |
| CLI | No | — |
| Dashboard | No | new setting renders from the registry on the existing Config screen (group "GitHub & security") — no UI code |
| Harness | No | dispatch, `cwd` and session lifecycle untouched |
| SOULs / protocol | **Yes** | new `COMMUNICATION_PROTOCOL.md` **§14** (was an unused number between §13 and §15); §8.1 process-doc row generalized + new rule 5; `dev.SOUL.md` (prerequisite 1, inviolable rules, plan-gate line, implement step 3/6.1/10, fix step 4.1, done criteria); `pmo.SOUL.md` (acceptance criteria step 4, footprint bullet); `reviewer.SOUL.md` (new checklist item) |
| Scheduler / scope | **Yes** | `app/src/footprint-ancillary.ts` reads `config.scope.ancillaryDocPaths`; glob matcher extracted to `app/src/footprint-glob.ts` (dag → ancillary → dag would have been a cycle); `app/src/dag.ts` re-exports it, no behavior change |
| Config | **Yes** | `SCOPE_ANCILLARY_DOC_PATHS` in `config/registry.ts` (+ `DEFAULT_ANCILLARY_DOC_PATHS`, `globList` validator), getter `config.scope.ancillaryDocPaths`, `.env.example` |
| Docs | **Yes** | `docs/agents.md` (new "Your repo's conventions" section), `docs/github-setup.md` (new "Process docs and the scope-check") |
| Recipes | **Yes** | regenerated (`bun recipes/build.ts`) + `embed-assets --no-dashboard` |
| CI | No | — |
| Tests | **Yes** | `app/test/footprint-ancillary.test.ts` (+6 cases), `app/test/setup.ts` clears the new ENV |

## The flow, end to end

1. **PMO** (refining): clones each repo named in `## Onde`, reads its guide (`AGENTS.md` → `CLAUDE.md` → `.cursor/rules/*` → `CONTRIBUTING.md`/`PROJECT_MAP.md`/`README.md` → knowledge/doc directory), and writes **one checklist item per required deliverable, per repo**, naming the file/directory ("OKF bundle in `knowledge/changes/<date>/<name>/`"). Doc paths stay out of `## Footprint`.
2. **Dev** (implement): after each clone, reads the same files before planning; the ▶️ plan comment now carries **one line per repo** listing the guide files found and the deliverables they impose (or `no guide found`). New step 6.1 writes those deliverables in the same commit set as the code; step 10 self-validates the diff against the plan line.
3. **Reviewer**: reads the guide of the PR's repo and rejects (`🛑`) both explicit invariant violations and missing deliverables — "the issue text didn't ask for it" is explicitly not an excuse — while never rejecting because those doc paths sit outside the footprint.
4. **Scope-check** (deterministic, no LLM): `filesOutsideFootprint` skips paths matching `SCOPE_ANCILLARY_DOC_PATHS`.

Multi-repo issues are first-class: conventions are applied **per repo**, and a repository used only as reference is read, never written to.

## Configuration

`SCOPE_ANCILLARY_DOC_PATHS` — comma-separated globs, footprint dialect (`**` globstar, trailing `/*` = subtree). Each pattern also matches at any depth (`CHANGELOG.md` covers `apps/web/CHANGELOG.md`); prefix with `./` to anchor at the repo root. Default: `CHANGELOG.md,CHANGELOG/**,changelog.d/**,knowledge/changes/**,docs/changes/**,.changes/**,.changeset/**,.okf/**,okf/**,adr/**,docs/adr/**,docs/decisions/**`. The validator rejects `*`, `**`, absolute paths and `..` (they would disable the scope-check). The value **replaces** the default rather than extending it — list every layout your repos use. Deliberately not `docs/**`: broad entries also disable footprint collision on those paths.

## Validation

- `bun test` — 216 pass / 0 fail (6 new cases: default layouts, monorepo depth, ENV-driven custom layout, explicit override, validator rejections, scope-check accepting a custom bundle path).
- `bun run typecheck` clean; `bun recipes/build.ts` regenerated the 4 recipes with YAML validation.

## Bugs found during implementation

- The naive port of the hardcoded rules to globs silently narrowed them: `CHANGELOG.md` as a plain glob no longer matched `apps/web/CHANGELOG.md`, which the previous basename regex did. Fixed with `matchesDocPattern` (root-anchored **and** any-depth), covered by a test.

## Deferred (consciously)

- **Root cause 2 is not fixed** — the ACP session `cwd` remains the issue workspace, so native harness discovery of `AGENTS.md`/`CLAUDE.md` still never fires. Deliberate: an issue may legitimately touch two or more repositories (frontend + backend + a reference repo), so there is no single "project root" to open the session on. §14 makes the discovery explicit in the prompt instead, which is what works for the multi-repo case.
- ~~**Existing installs must re-import the SOULs.**~~ Solved right after, in [../soul-sync/](../soul-sync/README.md): `yaoe-flow sync-souls` and the dashboard button **Agents → Aplicar SOUL padrão** re-import the bundled SOULs (plan + confirmation, previous version kept in history). Without it, §14 above would never reach an already-installed pipeline.
- Guide discovery is prompt-level, so it is not enforceable the way the scope-check is: an agent that ignores §14 is caught by the Reviewer, not by a deterministic gate.
