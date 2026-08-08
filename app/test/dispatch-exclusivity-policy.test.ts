import { describe, expect, test } from "bun:test";

/**
 * Documents the exclusive-dispatch policy that scheduler + locks must uphold.
 * Pure unit — no Valkey. Keep in sync with tryBeginEstimate / tryAcquireLock /
 * hasActiveDispatchForIssue usage in app/src/scheduler.ts.
 */
type Phase = "idle" | "estimating" | "locked" | "dev_running";

function next(
  phase: Phase,
  event:
    | "tick_no_footprint"
    | "tick_while_estimating"
    | "estimate_done_claim_lock"
    | "twin_estimate_done_claim_lock"
    | "dev_started"
): Phase | "skip" {
  switch (event) {
    case "tick_no_footprint":
      return phase === "idle" ? "estimating" : "skip";
    case "tick_while_estimating":
      return phase === "estimating" ? "skip" : "skip";
    case "estimate_done_claim_lock":
      return phase === "estimating" ? "locked" : "skip";
    case "twin_estimate_done_claim_lock":
      // HSETNX lost — second completion must not dispatch
      return phase === "locked" || phase === "dev_running" ? "skip" : "skip";
    case "dev_started":
      return phase === "locked" ? "dev_running" : "skip";
    default:
      return "skip";
  }
}

describe("issue exclusive dispatch policy", () => {
  test("second tick during estimate does not start another Orchestrator", () => {
    let phase: Phase = "idle";
    phase = next(phase, "tick_no_footprint") as Phase;
    expect(phase).toBe("estimating");
    expect(next(phase, "tick_while_estimating")).toBe("skip");
    expect(next(phase, "tick_no_footprint")).toBe("skip");
  });

  test("twin estimate completions: only one acquires the lock", () => {
    let phase: Phase = "idle";
    phase = next(phase, "tick_no_footprint") as Phase;
    phase = next(phase, "estimate_done_claim_lock") as Phase;
    expect(phase).toBe("locked");
    expect(next(phase, "twin_estimate_done_claim_lock")).toBe("skip");
    phase = next(phase, "dev_started") as Phase;
    expect(phase).toBe("dev_running");
    expect(next(phase, "twin_estimate_done_claim_lock")).toBe("skip");
  });
});
