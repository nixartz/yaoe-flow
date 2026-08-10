---
type: concept
title: "OKF and CHANGELOG are ancillary"
description: "Process docs required by AGENTS.md are skipped by deterministic scope-check and must not be listed in ## Footprint."
tags: [footprint, ancillary, okf, changelog]
---

# OKF and CHANGELOG are ancillary

`CHANGELOG.md` and anything under `knowledge/changes/` are protocol §8.1 ancillary paths. Workers may add them without listing them in `## Footprint`; the scope-check ignores them; listing them only creates false Valkey collisions between unrelated tasks. The Reviewer still judges whether the docs belong to the change.
