import { describe, expect, test } from "bun:test";

/**
 * Mirrors scheduler.lockHoldingStates() — keep in sync with app/src/scheduler.ts.
 * Pure unit: which Linear states may still hold a Valkey footprint lock.
 */
function lockHoldingStates(S: {
  inProgress: string;
  codeReview: string;
  inReview: string;
  reopened: string;
  pendingMerge: string;
  blocked: string;
}): Set<string> {
  return new Set([
    S.inProgress,
    S.codeReview,
    S.inReview,
    S.reopened,
    S.pendingMerge,
    S.blocked,
  ]);
}

const S = {
  todo: "To Do",
  refining: "Refining",
  planned: "Planned",
  inProgress: "In Progress",
  codeReview: "Code Review",
  inReview: "In Review",
  pendingMerge: "Pending Merge",
  reopened: "Reopened",
  completed: "Completed",
  blocked: "Blocked",
  backlog: "Backlog",
};

describe("stale footprint lock release policy", () => {
  const holding = lockHoldingStates(S);

  test("Completed must release (zombie lock root cause)", () => {
    expect(holding.has(S.completed)).toBe(false);
  });

  test("pipeline phases that own a branch keep the lock", () => {
    for (const state of [
      S.inProgress,
      S.codeReview,
      S.inReview,
      S.reopened,
      S.pendingMerge,
      S.blocked,
    ]) {
      expect(holding.has(state)).toBe(true);
    }
  });

  test("pre-implementation and terminal-adjacent states release", () => {
    for (const state of [S.todo, S.refining, S.planned, S.backlog]) {
      expect(holding.has(state)).toBe(false);
    }
  });
});
