---
type: "Product Knowledge"
title: "Roadmap and deliberate deferrals"
description: "Items consciously left out of 0.1.0, kept on the radar."
tags: [roadmap]
timestamp: "2026-08-02T00:00:00Z"
---

# Roadmap / deliberate deferrals

Tracked here so they are not forgotten — none of these block 0.1.0.

- **Dependabot/Renovate**: dependency-update automation intentionally NOT enabled yet (operator decision). Revisit after the release cadence settles.
- **Homebrew tap / winget package**: distribution beyond the install scripts.
- **Dashboard i18n (react-intl)**: the dashboard UI is Portuguese by design today — deliberately NOT hardcoded to English, since that would just replace one hardcoded language with another. The real fix is proper internationalization: add `react-intl`, extract every UI string into pt-BR and en-US message catalogs, wire components through `useIntl()`/`<FormattedMessage>`, and add a language switcher. Sizable, standalone effort — do it as its own change set, not opportunistically.
- **`app/src` code comments still in Portuguese**: only runtime-visible strings were translated (Pino log messages, thrown errors, OpenAPI `summary`/`description`, readiness reason text, CLI-visible strings) — see the 2026-08-02 backend-english-pass OKF change. The design-rationale comments (the "why" behind non-obvious decisions) are still largely Portuguese; translate opportunistically when touching a file, or as a dedicated pass later.
- **Backend test files (`app/test/*.ts`) in English**: comments and `test()` descriptions in the test suite are still Portuguese (lower priority — dev-internal only, not shipped).
- **`yaoe-flow update` atomic self-swap**: today it only checks the latest release and points at the idempotent installer; download + checksum + atomic rename + restart is the next step.
- **Portuguese operational deep-dives**: the old monorepo (`nixartz/ai-agents`, private) keeps the original Portuguese design docs (blueprints, daemon-binary spec, per-harness notes) and the pre-migration OKF specs. English guides in `docs/` cover the operational surface; port deeper content on demand.

