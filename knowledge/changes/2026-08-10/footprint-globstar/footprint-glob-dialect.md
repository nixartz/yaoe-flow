---
type: concept
title: "Footprint glob dialect"
description: "How yaoe-flow interprets repo:path globs for scope-check and Valkey collision locks."
tags: [footprint, glob, scope-check, dag]
---

# Footprint glob dialect

The orchestrator matcher (`app/src/dag.ts`) interprets footprint entries as follows:

| Pattern | Meaning |
| --- | --- |
| `*` or empty path | Whole repo (planning fallback) |
| Trailing `/*` | Whole subtree under that directory (SOUL `<module>/*` dialect; rewritten to `/**`) |
| `**` | Globstar — zero or more path segments (`src/app/**/perfil/**` matches `src/app/perfil/...`) |
| Mid-path `*` | Single path segment |

Repo qualification (`repo:path`) is unchanged: different repos never collide; unqualified entries apply to any repo (legacy).
