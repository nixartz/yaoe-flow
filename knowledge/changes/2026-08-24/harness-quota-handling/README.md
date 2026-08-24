---
type: change-bundle
title: Harness provider quota/rate-limit handling
description: Detect provider quota-exhaustion errors (e.g. Claude Code "You've hit your limit"), stop dispatching that harness until reset, requeue the affected issue immediately, and surface the error legibly everywhere instead of "[object Object]".
tags: [scheduler, harness, reliability, notifications, acp]
---

# Harness provider quota/rate-limit handling

## Issue

When a harness's underlying provider account hits its own usage limit (e.g.
Claude Code CLI: `Internal error: You've hit your limit · resets 10:10am
(America/Sao_Paulo)`, JSON-RPC `-32603`), the run failed like any other error:

- The error was **not reported anywhere legible** — `error_message` in the
  `runs` table and the `run_failed` notification body actually showed the
  literal string `"[object Object]"` (see root cause below), even though the
  raw structured Pino log line showed the real message.
- The error was **not treated specially** — no wait-until-reset, no retry
  policy, nothing distinguishing it from a one-off crash.
- The **issue stayed stuck** in its occupied phase (In Progress, Refining,
  In Review…) holding a seat and a footprint lock until the *inactivity*
  reclaim timeout fired (`IN_PROGRESS_TIMEOUT_MS`, default 45min) — and the
  very next scheduler tick would likely re-dispatch the same harness for the
  next candidate, hitting the same wall immediately.

## Root causes

1. **Display bug (`errorMessage`)**: the ACP SDK rejects `conn.prompt()` with
   the *raw* JSON-RPC error object (`{ code, message }`), not an `Error`
   instance (`errFields()` in `logger.ts` already documented this for
   *structured* log fields, but nothing fixed the *string* extraction used
   for `error_message`/notification bodies: `e instanceof Error ? e.message :
   String(e)` evaluates to `"[object Object]"` for a plain object).
2. **No quota classification**: nothing recognized "provider refused because
   the account/subscription is out of quota" as a distinct, non-transient
   condition. The existing `TRANSIENT_REJECT` regex in `agent/acp/client.ts`
   (rate-limit/502/503/timeouts) doesn't match phrases like "You've hit your
   limit", and even if it did, immediate in-session retry is guaranteed to
   fail again before the reset time.
3. **No requeue path outside the inactivity timer**: the only mechanism that
   ever returns a stuck issue to the queue is `reclaimStale()`'s per-phase
   inactivity timeout in `scheduler.ts` — there was no "I already know this
   run is dead, requeue it now" path for a failure detected synchronously in
   `dispatch.ts`'s catch block.

## Fix

### 1. `errorMessage()` (`app/src/logger.ts`)

New helper mirroring `errFields()`'s existing object-awareness, but returning
a **string** (for DB/notification/comment text): `Error` → `.message`; plain
object with a string `.message` → that (plus `(code N)` suffix when numeric);
otherwise `String(e)`. Used in `agent/dispatch.ts`'s catch (both `error_message`
and `notify()`'s body) and in `agent/acp/client.ts`'s retry-decision (see
below) — the two places actually reached by ACP JSON-RPC rejections.

### 2. Quota detection + reopen-target mapping (`app/src/agent/harness/quota.ts`, new)

- `detectHarnessQuotaError(message)`: matches known "provider account/quota
  exhausted" phrasings (`you've hit your limit`, `usage limit reached`,
  `quota exceeded`, `insufficient_quota`, `(monthly|weekly|daily) limit
  reached`) — deliberately **not** overlapping `TRANSIENT_REJECT` (429/502/
  503/ECONNRESET stay short-backoff-retriable, unrelated to an account cap).
  When present, it also tries to parse a `resets HH:MMam/pm (IANA/Zone)`
  clause into an absolute epoch — computed with the standard `Intl` "guess an
  epoch, format it in the target zone, correct the diff" trick (no timezone
  library dependency), rolling to the next calendar day in that zone if the
  time already passed today. Falls back to a configurable default cooldown
  (`HARNESS_QUOTA_DEFAULT_COOLDOWN_MS`, default 30min) when no reset clause
  is present or the timezone name is unrecognized by `Intl`.
- `quotaReopenTarget(stateName)`: the **same** state→state map
  `reclaimStale()` already uses for the inactivity timeout (Refining→To Do,
  In Progress→Reopened, In Review→Code Review, Pending Merge→Reopened) —
  reused, not reinvented, so retrying keeps the existing footprint lock and
  resumes on the same branch.
- `activeHarnessQuotaCooldownForRole(connectionId, role)`: per-connection
  Valkey-backed gate, same shape as `agent/harness/budget.ts`'s
  `isActiveHarnessPausedForRole` (budget = spend-based; this = the provider
  itself refusing).
- `reactToHarnessQuotaError(ctx, issueId, harnessId, info)`: sets the Valkey
  cooldown, posts a Linear comment (provider's original message + computed
  reset ETA, in Portuguese to match the rest of the scheduler's operator-
  facing comments), moves the issue to its reopen target, and — for Pending
  Merge — clears the merge mutex, mirroring `reclaimStale()`'s merge branch.

### 3. Wiring

- **`agent/dispatch.ts`** (`runDispatch`): on catch, classifies the error via
  `detectHarnessQuotaError(errorMessage(e))`. If it's a quota error: records
  `stopReason: "provider_quota"` on the run, fires a new
  `harness_quota_exceeded` notification (instead of `run_failed`), and calls
  `reactToHarnessQuotaError` best-effort (a failure here never masks the
  original error being re-thrown — the inactivity reclaim remains the
  fallback safety net). Also added a proactive gate mirroring the existing
  budget-pause check: `activeHarnessQuotaCooldownForRole` is checked right
  after resolving the harness, throwing the existing `HarnessNotReadyError`
  (same "seat stays occupied, retry next tick, don't move the issue"
  semantics already used for budget-pause and dispatch-lock-denied).
- **`scheduler.ts`**: the proactive gate is *also* checked **before**
  `moveState`/`acquireLock` in all four fill loops that can dispatch a role
  (`fillRefiners`/pmo, `tryDispatchImpl`+`estimateThenDispatch`/dev,
  `fillReviewers`/reviewer, `drainMerge`/orchestrator) — exactly where the
  existing `isActiveHarnessPausedForRole` budget check already sits, for the
  same reason (checking only inside `runDispatch` is too late: the issue
  would already have been moved to the occupied state by the time the
  rejection happens).
- **`agent/acp/client.ts`**: the in-session retry loop now uses
  `errorMessage(e)` instead of the broken `String(e)` fallback, and skips
  retry entirely for a detected quota error (immediate retry inside the same
  quota window is guaranteed to fail — this matters most for harnesses with
  `promptRetries > 0`, e.g. Goose; Claude Code's generic ACP adapter already
  defaults `promptRetries` to 0, so this specific bug report never actually
  retried, it just showed `"[object Object]"` everywhere the error string was
  used for display).
- **`locks.ts`**: `setHarnessQuotaCooldown` / `getHarnessQuotaCooldown` /
  `clearHarnessQuotaCooldown` — a per-connection Valkey hash
  (`harnessId → resetAtMs`), same family as `attempts`/`footprint`.
- **`config/registry.ts` + `config.ts`**: new setting
  `HARNESS_QUOTA_DEFAULT_COOLDOWN_MS` (Reliability & merge group, default
  30min) — the fallback cooldown when no reset time could be parsed.
- **`notifications/store.ts` + `notifications/events.ts`**: new
  `harness_quota_exceeded` event (title/body includes the harness id, the
  provider's message, and the computed reset time); dashboard
  (`dashboard/src/lib/api.ts` + `pages/Notifications.tsx`) updated with the
  matching type/label so it's selectable in the channel×event matrix like
  every other event.

## What changed and where

- **Harness (ACP)**: `app/src/agent/acp/client.ts` (retry classification).
- **Agent dispatch**: `app/src/agent/dispatch.ts` (catch-block classification
  + reaction + proactive gate), `app/src/agent/harness/quota.ts` (new).
- **Scheduler**: `app/src/scheduler.ts` (proactive gate at 4 dispatch sites).
- **Infra**: `app/src/locks.ts` (Valkey cooldown), `app/src/logger.ts`
  (`errorMessage`).
- **Config**: `app/src/config/registry.ts`, `app/src/config.ts`
  (`HARNESS_QUOTA_DEFAULT_COOLDOWN_MS`).
- **Notifications**: `app/src/notifications/store.ts`,
  `app/src/notifications/events.ts` (new event).
- **Dashboard**: `dashboard/src/lib/api.ts`,
  `dashboard/src/pages/Notifications.tsx` (new event in the UI matrix only —
  no new screen).
- **Not changed**: DB schema (no migration — cooldown lives in Valkey like
  every other per-connection scheduler mutex; `stopReason`/`error_message`
  are pre-existing free-text columns).
- **Tests**: `app/test/harness-quota.test.ts` (new) — `errorMessage` on plain
  JSON-RPC-shaped objects, `detectHarnessQuotaError`'s phrase matching and
  timezone-aware reset-time parsing (today vs. rolls to tomorrow, AM/PM,
  12am/12pm edge cases, unknown timezone fallback, no-reset-clause fallback),
  and `quotaReopenTarget`'s state map.

## Bugs found during manual validation

- **Timezone rollover fudge-factor bug**: the first implementation of
  "roll to the next occurrence of this time in the target zone" added a flat
  `+36h` to the already-computed (and possibly hours-earlier-than-`now`)
  candidate epoch before reformatting, which could overshoot by a full extra
  calendar day near the UTC/target-zone day boundary (caught by a test with
  `now` at UTC midnight, `America/Sao_Paulo` being UTC-3 → local "today" is
  the previous day). Fixed by deriving "tomorrow" via plain calendar
  arithmetic on the (year, month, day) tuple (`Date.UTC(y, mo-1, d+1)`, which
  self-normalizes month/day overflow) instead of nudging the wall-clock epoch.

## Deferred / follow-ups

- Only the 4 role-scoped dispatch loops (`dev`/`pmo`/`reviewer`/`orchestrator`
  via `fillRefiners`/`fillWorkers`/`fillReviewers`/`drainMerge`) got the
  proactive pre-`moveState` gate. `runDispatch`'s own check covers every
  other caller (manual dispatch, etc.) via `HarnessNotReadyError`, just one
  tick later than the proactive gate would.
- The `errorMessage()` fix was applied to `agent/dispatch.ts` and
  `agent/acp/client.ts` only (the two paths that actually see ACP JSON-RPC
  rejections). The same `e instanceof Error ? e.message : String(e)` pattern
  exists in ~9 other, unrelated call sites (API error responses, GitHub auth,
  OpenRouter) — left untouched as out of scope for this fix.
- Quota-cooldown is per **(connection, harnessId)** — not per role. If two
  roles share the same harness/credential on the same connection, both are
  gated together (correct: it's the same account hitting the same cap). If
  they use *different* credentials under the same harness id, they'd be
  gated together too (a false positive), but yaoe-flow doesn't currently
  model per-role credentials for the same harness id, so this doesn't arise
  in practice today.
