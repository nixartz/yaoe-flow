---
type: concept
title: "Ancillary process-doc paths are configurable"
description: "SCOPE_ANCILLARY_DOC_PATHS defines which change-bundle/CHANGELOG globs the scope-check skips; hardcoding this repo's layout punished other projects' docs."
tags: [footprint, ancillary, scope-check, config, okf, changelog]
---

# Ancillary process-doc paths are configurable

Lockfiles, toolchain config and test companions are recognized by **name pattern** — they are universal. Process docs are not: the change bundle lives in `knowledge/changes/**` here, `docs/changes/**` or `.okf/**` or `configdocs/**` elsewhere, and each repo's `AGENTS.md` decides. Hardcoding one layout meant the deterministic scope-check rejected exactly the documentation another repo's guide had ordered the agent to write — a reopen loop that teaches agents to skip docs.

`SCOPE_ANCILLARY_DOC_PATHS` (ENV > db > default, Config screen) holds a comma-separated glob list in the footprint dialect (`**` globstar, trailing `/*` = whole subtree). Each pattern matches root-anchored **and** at any depth, so `CHANGELOG.md` also covers `apps/web/CHANGELOG.md` in a monorepo; `./CHANGELOG.md` anchors at the root. The value replaces the default instead of extending it.

Two guardrails: the registry validator rejects `*`, `**`, absolute paths and `..` (each would make every file ancillary and disable the scope-check), and the default stays on process-doc paths rather than a blanket `docs/**` — ancillary paths also stop producing footprint collisions, so a repo whose docs *are* the product would lose serialization on them.

Implementation note: `footprint-ancillary.ts` now reads the config facade, so the glob matcher moved to `footprint-glob.ts` — `dag.ts` imports `footprint-ancillary`, and importing `dag` back would have closed a cycle. `dag.ts` re-exports `isWithinFootprint`/`toGlobPattern` unchanged. Related: [[okf-repo-conventions]].
