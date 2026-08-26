import { describe, expect, test } from "bun:test";
import {
  appendPipelinePolicy,
  pipelinePolicyOverlay,
  recipeAssemblyKey,
} from "../src/agent/recipe/pipeline-policy";
import type { DispatchGateFlags } from "../src/dispatch-gates";

const off: DispatchGateFlags = { ignoreFootprintLocks: false, ignoreBlockingIssues: false };
const fp: DispatchGateFlags = { ignoreFootprintLocks: true, ignoreBlockingIssues: false };
const deps: DispatchGateFlags = { ignoreFootprintLocks: false, ignoreBlockingIssues: true };
const both: DispatchGateFlags = { ignoreFootprintLocks: true, ignoreBlockingIssues: true };

describe("pipelinePolicyOverlay", () => {
  test("omitted when both flags are off — no extra tokens", () => {
    expect(pipelinePolicyOverlay("dev", off)).toBe("");
    expect(pipelinePolicyOverlay("reviewer", off)).toBe("");
    expect(appendPipelinePolicy("SOUL TEXT", "dev", off)).toBe("SOUL TEXT");
  });

  test("IGNORE_FOOTPRINT_LOCKS: Reviewer must not reopen solely on footprint leak", () => {
    const text = pipelinePolicyOverlay("reviewer", fp);
    expect(text).toContain("IGNORE_FOOTPRINT_LOCKS=true");
    expect(text).toMatch(/do not reject \(Reopened\) solely/i);
    expect(text).toContain("protocol §10");
    expect(text).not.toContain("IGNORE_BLOCKING_ISSUES");
    expect(text).not.toMatch(/other agents may be editing overlapping/i);
  });

  test("IGNORE_FOOTPRINT_LOCKS: Dev keeps the ceiling and expects parallel overlap", () => {
    const text = pipelinePolicyOverlay("dev", fp);
    expect(text).toContain("privilege ceiling");
    expect(text).toMatch(/other agents may be editing overlapping/i);
    expect(text).not.toMatch(/do not reject \(Reopened\) solely/i);
  });

  test("IGNORE_FOOTPRINT_LOCKS: PMO/Orchestrator still declare and estimate footprint", () => {
    expect(pipelinePolicyOverlay("pmo", fp)).toMatch(/Keep declaring/);
    expect(pipelinePolicyOverlay("orchestrator", fp)).toMatch(/estimating \(Orchestrator planning\)/);
  });

  test("IGNORE_BLOCKING_ISSUES does not relax footprint audit", () => {
    const reviewer = pipelinePolicyOverlay("reviewer", deps);
    expect(reviewer).toContain("IGNORE_BLOCKING_ISSUES=true");
    expect(reviewer).not.toContain("IGNORE_FOOTPRINT_LOCKS");
    expect(reviewer).not.toMatch(/do not reject \(Reopened\) solely/i);
    expect(pipelinePolicyOverlay("dev", deps)).toMatch(/Do not 🙋\+Blocked for unmet Linear deps/);
  });

  test("IGNORE_BLOCKING_ISSUES: PMO still records blockedBy/blocks", () => {
    const pmo = pipelinePolicyOverlay("pmo", deps);
    expect(pmo).toMatch(/still translate real dependencies/);
    expect(pipelinePolicyOverlay("dev", deps)).not.toMatch(/still translate real dependencies/);
  });

  test("both flags: overlay carries both, role extras still independent", () => {
    const reviewer = pipelinePolicyOverlay("reviewer", both);
    expect(reviewer).toContain("IGNORE_FOOTPRINT_LOCKS=true");
    expect(reviewer).toContain("IGNORE_BLOCKING_ISSUES=true");
    expect(reviewer).toMatch(/do not reject \(Reopened\) solely/i);
    expect(reviewer).not.toMatch(/still translate real dependencies/);
    const pmo = pipelinePolicyOverlay("pmo", both);
    expect(pmo).toMatch(/still translate real dependencies/);
    expect(pmo).toMatch(/Keep declaring/);
  });

  test("appendPipelinePolicy inserts the overlay after a --- separator", () => {
    const out = appendPipelinePolicy("SOUL TEXT", "reviewer", fp);
    expect(out.startsWith("SOUL TEXT")).toBe(true);
    expect(out).toContain("\n\n---\n\n");
    expect(out).toContain("Current pipeline policy");
  });

  test("historical worker alias gets Dev bullets", () => {
    const worker = pipelinePolicyOverlay("worker", fp);
    const dev = pipelinePolicyOverlay("dev", fp);
    expect(worker).toBe(dev);
    expect(worker).toMatch(/other agents may be editing overlapping/i);
  });

  test("recipeAssemblyKey encodes flags so Goose cache is not sticky", () => {
    expect(recipeAssemblyKey(off)).toMatch(/\|fp=0\|deps=0$/);
    expect(recipeAssemblyKey(fp)).toMatch(/\|fp=1\|deps=0$/);
    expect(recipeAssemblyKey(deps)).toMatch(/\|fp=0\|deps=1$/);
    expect(recipeAssemblyKey(both)).toMatch(/\|fp=1\|deps=1$/);
  });
});
