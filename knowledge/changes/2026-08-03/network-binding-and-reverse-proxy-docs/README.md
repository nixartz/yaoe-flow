---
type: "Feature Spec"
title: "Network binding wizard step and reverse proxy documentation"
description: "Added a setup-wizard question for HOST (localhost vs 0.0.0.0) and documented the already-working path to a custom domain via reverse proxy."
resource: "https://github.com/nixartz/yaoe-flow"
tags: [yaoe-flow, setup, networking, dashboard]
timestamp: "2026-08-03T00:00:00Z"
---

# Network binding wizard step and reverse proxy documentation

**Date:** 2026-08-03. **Version:** 0.1.2 (patch release off 0.1.1).

## Summary

- [The request](#the-request)
- [Part 1 — HOST is now a wizard question](#part-1--host-is-now-a-wizard-question)
- [Part 2 — custom domain: already worked, now documented](#part-2--custom-domain-already-worked-now-documented)
- [Why no new "API base URL" setting](#why-no-new-api-base-url-setting)
- [A stdin/readline testing gotcha found along the way](#a-stdinreadline-testing-gotcha-found-along-the-way)

## The request

A user running yaoe-flow on their own Ubuntu server (not Docker) asked for two things:

1. A way to bind on `0.0.0.0` (or be asked during setup) instead of only ever defaulting to `localhost`, since as a bare install on a server the dashboard was unreachable from outside the box.
2. A way for the dashboard to reach the API via a custom domain (e.g. `minha-api.com`) instead of `localhost:<port>` — and specifically asked whether that needs a dashboard rebuild (SPA) or could be read from a deployed, editable file at runtime.

## Part 1 — HOST is now a wizard question

`HOST` already existed as a bootstrap setting (`app/src/config/registry.ts`) with a description mentioning `0.0.0.0` for Docker/K8s — but nothing in `yaoe-flow setup` ever asked about it; an operator had to know to set it manually in `config.env`.

Added `stepNetwork` as the new step 2 of the wizard (`app/src/cli/setup/steps.ts`), inserted right after "Directories and keys" and before "Valkey" — bumping every subsequent step's `[n/11]` header (previously `[n/10]`) and the module's step-numbering comments. It offers three choices: `localhost` (default), `0.0.0.0`, or a custom bind address, and explains the same-machine-reverse-proxy case doesn't need `0.0.0.0` at all (loopback already reaches it). Wired into both the first-run wizard sequence and the post-setup configuration menu (`app/src/cli/setup/index.ts`, new "Network binding" menu entry). `showCurrentConfig()`'s printed API/Dashboard URLs and the final wizard summary now re-read `config.env` for `HOST` instead of the process-start-frozen `bootstrap.host`, so a value just changed in the same run displays correctly (it still only takes effect for the actual bind on the next `yaoe-flow daemon` start, same as before).

## Part 2 — custom domain: already worked, now documented

Traced how the dashboard SPA reaches its API: `dashboard/src/lib/api.ts`'s `request()` always calls `fetch(\`/api${path}\`, ...)` — a **relative** path — and `dashboard/src/lib/useSse.ts`'s `EventSource` calls (`/api/runs/stream` etc., see `pages/Live.tsx`) are relative too. The SPA is served from the exact same process and port as its API (`app/src/dashboard/server.ts` — one `Bun.serve()` on `DASHBOARD_PORT` serving both the embedded SPA assets and `createDashboardApp()`'s routes). Because of that, whatever origin the browser loaded the page from is automatically the origin every API/SSE call goes back to — a reverse proxy that forwards a custom domain (all paths) to `127.0.0.1:$DASHBOARD_PORT` already works with **zero code changes, no rebuild, and no runtime config file** to edit.

This was undocumented, so the answer is a new `docs/networking.md` covering the `HOST` table, the "no rebuild needed" explanation, sample Caddy/nginx configs (including `proxy_http_version 1.1` + a long `proxy_read_timeout` — required for the SSE streams the Live/Logs pages use), and a note that `NODE_ENV=production` (unset by default) controls whether the session cookie gets the `Secure` flag, relevant once serving over HTTPS.

## Why no new "API base URL" setting

Deliberately did not add a configurable "dashboard API base URL" or a deployed/editable runtime-config file: the embedded-SPA architecture (SPA baked into the compiled binary, always served by the same process as its own API) means SPA and API can never actually be on different origins in this deployment model — there is no real scenario where they'd need to diverge. Adding a setting for it would be complexity with no corresponding use case; the actual friction (an undocumented but already-correct architecture) is fixed by documentation, not code.

## A stdin/readline testing gotcha found along the way

While hand-verifying `stepNetwork`'s three branches (fresh/default, already `0.0.0.0`, already a custom value) by piping scripted stdin answers into an isolated `bun -e` invocation, multi-line piped input reliably lost lines whenever the code moved from one `ask()`/`confirm()`/`choose()` call to the next — each helper in `app/src/cli/setup/prompt.ts` opens and closes its own `readline` interface per call (by design, to avoid the raw-mode stdin listener colliding with `askSecret()`), and recreating a `readline.Interface` on a non-TTY piped stream right after closing the previous one can silently drop already-buffered input. This reproduces on every existing step, not just the new one — it's a property of piped/non-interactive testing, not a bug in real interactive use (a human typing into a real TTY doesn't pre-buffer multiple answers at once). Worked around for verification by over-supplying blank lines (`yes ""`); did not change `prompt.ts`, since the existing per-call-interface design is intentional and works correctly for its real use case.
