---
type: change-bundle
title: ACP SDK rawOutput/rawInput schema patch (Invalid params)
description: bun patch on @zed-industries/agent-client-protocol relaxing rawOutput/rawInput zod schemas so string/array tool_call_update payloads aren't silently dropped with -32602.
tags: [acp, harness, bugfix, sdk-patch]
---

# ACP SDK `rawOutput`/`rawInput` schema patch (Invalid params)

## Issue

Operators saw `Invalid params` (JSON-RPC `-32602`) `session/update` errors in the
logs whenever a harness (Claude Code, in the reported case) sent a
`tool_call_update` whose `rawOutput` (or `rawInput`) was a **string** or an
**array** instead of a plain object.

## Root cause

`@zed-industries/agent-client-protocol@0.4.5` (the ACP SDK, not yaoe-flow
code) generates its zod validation schemas with `rawOutput`/`rawInput` typed
as `z.record(z.unknown()).optional()` — i.e. "an object with unknown keys",
even though the ACP spec itself does not constrain these fields (any JSON
value is valid: a string, an array, a number, etc.). `claude-code-acp` (and
other agents) legitimately send `rawOutput` as a plain string
(`"mock tool 0 output\nline 2"`) or an array (`[{ type: "text", text: "…" }]`)
for tools like `Bash`/`Read` — the SDK rejects the whole notification with
`-32602` **before** it ever reaches `app/src/agent/acp/client.ts`'s handler.
The event is silently lost: no tool-call row, no timeline entry, no error
surfaced anywhere in yaoe-flow (the rejection happens inside the SDK's
JSON-RPC dispatch, which only logs to its own internal handler).

## Fix

Applied via `bun patch` (tracked in `app/package.json`'s
`patchedDependencies` + `app/patches/@zed-industries%2Fagent-client-protocol@0.4.5.patch`):
loosened `rawOutput`/`rawInput` from `z.record(z.unknown()).optional()` to
`z.unknown().optional()` in both `dist/schema.js` (what actually runs) and
`typescript/schema.ts` (source, for consistency) inside
`node_modules/@zed-industries/agent-client-protocol`.

## What changed and where

- **Harness/ACP (patch only, no yaoe-flow logic changed)**: `app/package.json`
  (`patchedDependencies` entry), `app/bun.lock`,
  `app/patches/@zed-industries%2Fagent-client-protocol@0.4.5.patch`.
- **Tests**: `app/test/mock-acp-agent.ts` now alternates `rawOutput` between a
  plain string and an array of objects across its simulated tool calls (was
  always a string) — reproduces the exact shapes real agents send.
  `app/test/acp-contract.test.ts` gained a regression test asserting both
  shapes survive the SDK's validation and reach `tool_call_update` events with
  the payload intact.
- **Not changed**: dashboard, API, CLI — this is purely an upstream
  dependency defect in JSON-RPC parameter validation.

## Deferred / follow-ups

- The patch lives in `node_modules` via `bun patch` — it survives `bun
  install` (via `patchedDependencies`) but will need to be dropped once
  upstream fixes the schema generation (tracked nowhere upstream yet; worth
  reporting to `zed-industries/agent-client-protocol`).
- No attempt was made to patch every other overly-strict field in the same
  schema file — only `rawOutput`/`rawInput`, the two observed in production
  logs.
