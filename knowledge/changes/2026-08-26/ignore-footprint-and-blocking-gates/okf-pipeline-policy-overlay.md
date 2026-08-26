---
type: concept
title: "Hot pipeline flags reach agents via a per-run overlay, not a SOUL rewrite"
description: "IGNORE_* enforcement exceptions are concatenated at prompt assembly (role-specific, omitted when off). Stopgap — replace with a single assembleAgentInstructions; do not bake into agents/*.SOUL.md."
tags: [souls, protocol, overlay, config, prompt-assembly]
---

# Hot pipeline flags reach agents via a per-run overlay, not a SOUL rewrite

The scheduler can skip footprint-lock collision / deterministic scope-check (`IGNORE_FOOTPRINT_LOCKS`) or Linear `blockedBy` (`IGNORE_BLOCKING_ISSUES`) without a restart. The Reviewer SOUL would otherwise still Reopen on `diff ⊈ footprint`, undoing the first flag. The SOUL text itself stays the **default product**; a short English overlay is appended only when a flag is on (`app/src/agent/recipe/pipeline-policy.ts`), with role-specific bullets (Reviewer vs Dev vs PMO).

This is the same family as `{{OUTPUT_LANGUAGE}}` and `authorizedOrgs:` — runtime policy — not personality. A generic “config rewrites SOUL paragraphs” compiler is out of scope.

**Call-site split (collapse later):** Goose bakes SOUL+protocol+overlay into recipe `instructions` (cache key includes `recipeAssemblyKey()`); ACP/native append the overlay to the SOUL on the first turn and still do not concatenate the protocol (pre-existing). Hermes does not see the overlay. File-by-file redo checklist: [knowledge/product/pipeline-policy-overlay.md](../../../product/pipeline-policy-overlay.md).
