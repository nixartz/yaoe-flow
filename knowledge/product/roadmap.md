---
type: "Product Knowledge"
title: "Roadmap and deliberate deferrals"
description: "Items consciously left out of 0.1.0, kept on the radar."
tags: [roadmap]
timestamp: "2026-08-02T00:00:00Z"
---

# Roadmap / deliberate deferrals

Tracked here so they are not forgotten — none of these block 0.1.0.

- **Dependabot/Renovate**: dependency-update automation intentionally NOT
  enabled yet (operator decision). Revisit after the release cadence settles.
- **Homebrew tap / winget package**: distribution beyond the install scripts.
- **Dashboard UI in English**: several dashboard screens still carry
  Portuguese strings from before the repo extraction; the settings registry,
  CLI and docs are already English. Translate screen by screen
  (`dashboard/src/pages/*`).
- **Backend log messages in English**: many Pino log messages are still
  Portuguese. Translate opportunistically when touching each module
  (see knowledge/rules/english-only.md).
- **`yaoe-flow update` atomic self-swap**: today it only checks the latest
  release and points at the idempotent installer; download + checksum +
  atomic rename + restart is the next step.
- **Portuguese operational deep-dives**: the old monorepo
  (`nixartz/ai-agents`, private) keeps the original Portuguese design docs
  (blueprints, daemon-binary spec, per-harness notes) and the pre-migration
  OKF specs. English guides in `docs/` cover the operational surface; port
  deeper content on demand.
- **project-map / sandbox / worker-image READMEs**: still Portuguese; translate
  when those tools are next touched.
