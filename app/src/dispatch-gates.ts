// Operator opt-in bypasses of the two independent dispatch gates.
// Default (both false) preserves collision-freedom and Linear blockedBy/blocks.
// Hot: callers read via config getters on every tick / readiness snapshot —
// a Config-screen toggle takes effect on the next pick, no restart.
import { config } from "./config";

export type DispatchGateFlags = {
  ignoreFootprintLocks: boolean;
  ignoreBlockingIssues: boolean;
};

export function ignoreFootprintLocks(): boolean {
  return config.ignoreFootprintLocks;
}

export function ignoreBlockingIssues(): boolean {
  return config.ignoreBlockingIssues;
}

export function dispatchGateFlags(): DispatchGateFlags {
  return {
    ignoreFootprintLocks: ignoreFootprintLocks(),
    ignoreBlockingIssues: ignoreBlockingIssues(),
  };
}

/** Whether a footprint collision with an in-flight lock should prevent Dev dispatch. */
export function shouldBlockOnFootprintCollision(
  collides: boolean,
  flags: DispatchGateFlags = dispatchGateFlags()
): boolean {
  return collides && !flags.ignoreFootprintLocks;
}

/** Whether unsatisfied Linear blockedBy (open blockers) should prevent Dev dispatch. */
export function shouldBlockOnUnsatisfiedDeps(
  unsatisfied: boolean,
  flags: DispatchGateFlags = dispatchGateFlags()
): boolean {
  return unsatisfied && !flags.ignoreBlockingIssues;
}

/**
 * Skip the files-outside-footprint half of the deterministic scope-check
 * (Code Review → In Review). PR-exists and AGENT_AUTHORIZED_ORGS still run —
 * those are not footprint locks.
 */
export function shouldSkipFootprintScopeCheck(flags: DispatchGateFlags = dispatchGateFlags()): boolean {
  return flags.ignoreFootprintLocks;
}
