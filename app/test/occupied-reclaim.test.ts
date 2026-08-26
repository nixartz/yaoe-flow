import { describe, expect, test } from "bun:test";
import { config } from "../src/config";
import {
  ABANDONED_DISPATCH_GRACE_MS,
  occupiedReopenTarget,
  roleForOccupiedState,
  shouldReclaimAbandonedDispatch,
} from "../src/occupied-reclaim";

const S = config.states;

describe("occupiedReopenTarget / roleForOccupiedState", () => {
  test("maps each occupied phase to the retry state and dispatch role", () => {
    expect(occupiedReopenTarget(S.refining)).toBe(S.todo);
    expect(roleForOccupiedState(S.refining)).toBe("pmo");
    expect(occupiedReopenTarget(S.inProgress)).toBe(S.reopened);
    expect(roleForOccupiedState(S.inProgress)).toBe("dev");
    expect(occupiedReopenTarget(S.inReview)).toBe(S.codeReview);
    expect(roleForOccupiedState(S.inReview)).toBe("reviewer");
    expect(occupiedReopenTarget(S.pendingMerge)).toBe(S.reopened);
    expect(roleForOccupiedState(S.pendingMerge)).toBe("orchestrator");
  });

  test("unknown / non-occupied states have no reopen target", () => {
    expect(occupiedReopenTarget(S.completed)).toBeNull();
    expect(roleForOccupiedState(S.completed)).toBeNull();
    expect(occupiedReopenTarget(S.reopened)).toBeNull();
    expect(roleForOccupiedState(S.reopened)).toBeNull();
  });
});

describe("shouldReclaimAbandonedDispatch", () => {
  const now = 1_000_000;
  const startedAt = now - ABANDONED_DISPATCH_GRACE_MS - 1;

  test("reclaims when the grace has elapsed and nothing is live", () => {
    expect(
      shouldReclaimAbandonedDispatch({
        hasOpenRun: false,
        hasActiveProcess: false,
        hasDispatchLock: false,
        startedAt,
        now,
      })
    ).toBe(true);
  });

  test("does not reclaim while an open SQLite run exists", () => {
    expect(
      shouldReclaimAbandonedDispatch({
        hasOpenRun: true,
        hasActiveProcess: false,
        hasDispatchLock: false,
        startedAt,
        now,
      })
    ).toBe(false);
  });

  test("does not reclaim while this process still has a harness process", () => {
    expect(
      shouldReclaimAbandonedDispatch({
        hasOpenRun: false,
        hasActiveProcess: true,
        hasDispatchLock: false,
        startedAt,
        now,
      })
    ).toBe(false);
  });

  test("does not reclaim while another process holds the dispatch lease", () => {
    expect(
      shouldReclaimAbandonedDispatch({
        hasOpenRun: false,
        hasActiveProcess: false,
        hasDispatchLock: true,
        startedAt,
        now,
      })
    ).toBe(false);
  });

  test("does not reclaim when startedAt is missing (not yet marked, or already cleared)", () => {
    expect(
      shouldReclaimAbandonedDispatch({
        hasOpenRun: false,
        hasActiveProcess: false,
        hasDispatchLock: false,
        startedAt: null,
        now,
      })
    ).toBe(false);
  });

  test("does not reclaim inside the fire()-without-await grace window", () => {
    expect(
      shouldReclaimAbandonedDispatch({
        hasOpenRun: false,
        hasActiveProcess: false,
        hasDispatchLock: false,
        startedAt: now - ABANDONED_DISPATCH_GRACE_MS + 1,
        now,
      })
    ).toBe(false);
  });

  test("reclaims exactly one millisecond after the grace", () => {
    expect(
      shouldReclaimAbandonedDispatch({
        hasOpenRun: false,
        hasActiveProcess: false,
        hasDispatchLock: false,
        startedAt: now - ABANDONED_DISPATCH_GRACE_MS,
        now: now + 1,
      })
    ).toBe(true);
  });
});
