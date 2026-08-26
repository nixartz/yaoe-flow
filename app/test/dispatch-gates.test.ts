import { describe, expect, test } from "bun:test";
import {
  shouldBlockOnFootprintCollision,
  shouldBlockOnUnsatisfiedDeps,
  shouldSkipFootprintScopeCheck,
  type DispatchGateFlags,
} from "../src/dispatch-gates";

const respect: DispatchGateFlags = { ignoreFootprintLocks: false, ignoreBlockingIssues: false };
const ignoreFp: DispatchGateFlags = { ignoreFootprintLocks: true, ignoreBlockingIssues: false };
const ignoreDeps: DispatchGateFlags = { ignoreFootprintLocks: false, ignoreBlockingIssues: true };
const ignoreBoth: DispatchGateFlags = { ignoreFootprintLocks: true, ignoreBlockingIssues: true };

describe("dispatch gates: IGNORE_FOOTPRINT_LOCKS vs IGNORE_BLOCKING_ISSUES", () => {
  test("defaults (both false) keep collision-freedom and Linear blockedBy", () => {
    expect(shouldBlockOnFootprintCollision(true, respect)).toBe(true);
    expect(shouldBlockOnFootprintCollision(false, respect)).toBe(false);
    expect(shouldBlockOnUnsatisfiedDeps(true, respect)).toBe(true);
    expect(shouldBlockOnUnsatisfiedDeps(false, respect)).toBe(false);
    expect(shouldSkipFootprintScopeCheck(respect)).toBe(false);
  });

  test("IGNORE_FOOTPRINT_LOCKS skips collision and scope-check only — deps still gate", () => {
    expect(shouldBlockOnFootprintCollision(true, ignoreFp)).toBe(false);
    expect(shouldBlockOnFootprintCollision(false, ignoreFp)).toBe(false);
    expect(shouldSkipFootprintScopeCheck(ignoreFp)).toBe(true);
    expect(shouldBlockOnUnsatisfiedDeps(true, ignoreFp)).toBe(true);
  });

  test("IGNORE_BLOCKING_ISSUES skips Linear blockedBy only — footprint collision and scope-check still gate", () => {
    expect(shouldBlockOnUnsatisfiedDeps(true, ignoreDeps)).toBe(false);
    expect(shouldBlockOnUnsatisfiedDeps(false, ignoreDeps)).toBe(false);
    expect(shouldBlockOnFootprintCollision(true, ignoreDeps)).toBe(true);
    expect(shouldSkipFootprintScopeCheck(ignoreDeps)).toBe(false);
  });

  test("both flags on: collision, scope-check and blockedBy all skipped", () => {
    expect(shouldBlockOnFootprintCollision(true, ignoreBoth)).toBe(false);
    expect(shouldBlockOnUnsatisfiedDeps(true, ignoreBoth)).toBe(false);
    expect(shouldSkipFootprintScopeCheck(ignoreBoth)).toBe(true);
  });
});
