## What

<!-- What does this PR do, in one or two sentences? -->

## Why

<!-- Context / motivation / linked issue -->

## How

<!-- Notable implementation decisions; screens touched (attach screenshots for dashboard changes) -->

## Checklist

- [ ] `bun test` and typechecks green (app + dashboard)
- [ ] OKF bundle added/updated in `knowledge/changes/<date>/<change-name>/` (features/fix sets)
- [ ] `CHANGELOG.md` entry under `[Unreleased]`
- [ ] Docs/README updated if user-visible
- [ ] `bun run embed-assets -- --no-dashboard` ran if migrations/SOULs changed (do **not** commit a filled SPA embed)
- [ ] No secrets, no binaries, English only

