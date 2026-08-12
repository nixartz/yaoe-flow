// `sync-souls` (CLI + dashboard button): re-import of the SOULs bundled with
// the binary. What must hold, no matter the surface: the plan is read-only, the
// apply only touches roles that actually differ, and the SOUL being replaced is
// never lost — it stays in the agent's version history.
import { describe, expect, test } from "bun:test";
import { activateAgent, createAgent, createVersion, listVersions, activeAgentForRole } from "../src/db/agents";
import { applySoulSync, isSyncable, parseRoleFilter, planSoulSync } from "../src/agent/soulSync";
import { readSoulFile } from "../src/agent/recipe/defaults";

describe("sync-souls", () => {
  test("plan flags an active agent whose SOUL differs from the bundled one", () => {
    const agent = createAgent({ role: "reviewer", name: "reviewer-outdated", soulMarkdown: "# soul antiga" });
    activateAgent(agent.id);

    const [entry] = planSoulSync(["reviewer"]);
    expect(entry.status).toBe("outdated");
    expect(isSyncable(entry)).toBe(true);
    expect(entry.agentId).toBe(agent.id);
    expect(entry.currentVersion).toBe(1);
    expect(entry.nextVersion).toBe(2);
    expect(entry.seedHash).toBeTruthy();
    expect(entry.seedHash).not.toBe(entry.currentHash);
  });

  test("plan never writes: replanning twice keeps the same version", () => {
    const agent = createAgent({ role: "pmo", name: "pmo-plan-readonly", soulMarkdown: "# soul antiga" });
    activateAgent(agent.id);
    planSoulSync(["pmo"]);
    planSoulSync(["pmo"]);
    expect(listVersions(agent.id)).toHaveLength(1);
  });

  test("apply creates a NEW active version and keeps the previous SOUL in history", () => {
    const agent = createAgent({ role: "dev", name: "dev-sync", soulMarkdown: "# soul antiga" });
    activateAgent(agent.id);

    const [applied] = applySoulSync({ roles: ["dev"], createdBy: null, source: "test" });
    expect(applied.agentId).toBe(agent.id);
    expect(applied.previousVersion).toBe(1);
    expect(applied.newVersion).toBe(2);

    const versions = listVersions(agent.id);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    // the replaced text is still there, reactivatable from the dashboard
    expect(versions.find((v) => v.version === 1)!.soulMarkdown).toBe("# soul antiga");

    const active = activeAgentForRole("dev")!;
    expect(active.version.version).toBe(2);
    expect(active.version.soulMarkdown).toBe(readSoulFile("dev"));
    expect(active.version.comment).toContain("sync-souls (test)");
  });

  test("idempotent: a second apply finds nothing to do", () => {
    const agent = createAgent({ role: "orchestrator", name: "orch-sync", soulMarkdown: "# soul antiga" });
    activateAgent(agent.id);

    expect(applySoulSync({ roles: ["orchestrator"], createdBy: null, source: "test" })).toHaveLength(1);
    expect(planSoulSync(["orchestrator"])[0].status).toBe("up-to-date");
    expect(applySoulSync({ roles: ["orchestrator"], createdBy: null, source: "test" })).toHaveLength(0);
    expect(listVersions(agent.id)).toHaveLength(2); // no third version
  });

  test("apply only touches the roles in the filter", () => {
    const dev = createAgent({ role: "dev", name: "dev-untouched", soulMarkdown: "# soul antiga" });
    activateAgent(dev.id);
    const reviewer = createAgent({ role: "reviewer", name: "reviewer-only", soulMarkdown: "# soul antiga" });
    activateAgent(reviewer.id);

    const applied = applySoulSync({ roles: ["reviewer"], createdBy: null, source: "test" });
    expect(applied.map((a) => a.role)).toEqual(["reviewer"]);
    expect(activeAgentForRole("dev")!.version.soulMarkdown).toBe("# soul antiga");
  });

  test("a version created by hand after the sync makes the role outdated again", () => {
    const agent = createAgent({ role: "pmo", name: "pmo-manual-edit", soulMarkdown: "# soul antiga" });
    activateAgent(agent.id);
    applySoulSync({ roles: ["pmo"], createdBy: null, source: "test" });
    createVersion(agent.id, "# editada na dashboard", "edição manual", null, { activate: true });

    const [entry] = planSoulSync(["pmo"]);
    expect(entry.status).toBe("outdated");
    expect(entry.nextVersion).toBe(4);
  });

  test("parseRoleFilter: empty = every role, unknown role is rejected", () => {
    expect(parseRoleFilter(undefined)).toEqual(["pmo", "dev", "reviewer", "orchestrator"]);
    expect(parseRoleFilter(" dev , reviewer ")).toEqual(["dev", "reviewer"]);
    expect(() => parseRoleFilter("dev,tester")).toThrow(/tester/);
  });
});
