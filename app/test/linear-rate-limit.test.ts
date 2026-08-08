import { describe, expect, test, beforeEach } from "bun:test";
import {
  LINEAR_TICK_BUDGET_FLOOR,
  __resetLinearRateLimitStateForTests,
  __markLinearRateLimitedForTests,
  __recordLinearRateLimitHeadersForTests,
  linearRateLimitCooldownMs,
  linearRateLimitSnapshot,
  shouldSkipTickForRateBudget,
  isLinearRateLimitError,
  LinearRateLimitError,
} from "../src/linear";

const KEY = "lin_api_test_key_abcdefghijklmnop";

describe("Linear rate limit tracking", () => {
  beforeEach(() => {
    __resetLinearRateLimitStateForTests();
  });

  test("cooldown is active after markRateLimited until reset", () => {
    const resetAtMs = Date.now() + 60_000;
    __markLinearRateLimitedForTests(KEY, { resetAtMs, remaining: 0, limit: 5000 });

    expect(linearRateLimitCooldownMs(KEY)).toBeGreaterThan(50_000);
    expect(shouldSkipTickForRateBudget(KEY)).toBe(true);
    expect(linearRateLimitSnapshot(KEY).cooledUntilMs).toBe(resetAtMs);
  });

  test("remaining below floor skips tick even without hard cooldown", () => {
    __recordLinearRateLimitHeadersForTests(
      KEY,
      new Headers({
        "X-RateLimit-Requests-Remaining": String(LINEAR_TICK_BUDGET_FLOOR - 1),
        "X-RateLimit-Requests-Limit": "5000",
        "X-RateLimit-Requests-Reset": String(Date.now() + 3_600_000),
      })
    );

    expect(linearRateLimitSnapshot(KEY).remaining).toBe(LINEAR_TICK_BUDGET_FLOOR - 1);
    expect(shouldSkipTickForRateBudget(KEY)).toBe(true);
    expect(linearRateLimitCooldownMs(KEY)).toBe(0);
  });

  test("remaining === 0 sets cooldown until reset header", () => {
    const resetAtMs = Date.now() + 120_000;
    __recordLinearRateLimitHeadersForTests(
      KEY,
      new Headers({
        "X-RateLimit-Requests-Remaining": "0",
        "X-RateLimit-Requests-Limit": "5000",
        "X-RateLimit-Requests-Reset": String(resetAtMs),
      })
    );

    expect(linearRateLimitCooldownMs(KEY)).toBeGreaterThan(100_000);
    expect(shouldSkipTickForRateBudget(KEY)).toBe(true);
  });

  test("healthy remaining clears skip", () => {
    __recordLinearRateLimitHeadersForTests(
      KEY,
      new Headers({
        "X-RateLimit-Requests-Remaining": "4000",
        "X-RateLimit-Requests-Limit": "5000",
        "X-RateLimit-Requests-Reset": String(Date.now() + 3_600_000),
      })
    );

    expect(shouldSkipTickForRateBudget(KEY)).toBe(false);
    expect(linearRateLimitCooldownMs(KEY)).toBe(0);
  });

  test("isLinearRateLimitError narrows", () => {
    const err = new LinearRateLimitError("boom", { resetAtMs: Date.now() + 1000 });
    expect(isLinearRateLimitError(err)).toBe(true);
    expect(isLinearRateLimitError(new Error("nope"))).toBe(false);
  });
});
