import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { expandYaoeHomePath, bootstrap } from "../src/config/bootstrap";

describe("expandYaoeHomePath", () => {
  test("expands $YAOE_HOME placeholder to bootstrap home", () => {
    expect(expandYaoeHomePath("$YAOE_HOME/worktrees")).toBe(resolve(bootstrap.yaoeHome, "worktrees"));
    expect(expandYaoeHomePath("$YAOE_HOME/worktrees")).toBe(bootstrap.yaoeWorktreesDir);
  });

  test("leaves absolute paths unchanged", () => {
    expect(expandYaoeHomePath("/tmp/ws")).toBe("/tmp/ws");
  });

  test("empty stays empty", () => {
    expect(expandYaoeHomePath("")).toBe("");
    expect(expandYaoeHomePath("   ")).toBe("");
  });
});

describe("config.goose.workingDir", () => {
  test("does not return literal $YAOE_HOME/worktrees", async () => {
    // Import after expand helper exists; facade resolves via service default.
    const { config } = await import("../src/config");
    const dir = config.goose.workingDir;
    expect(dir.includes("$YAOE_HOME")).toBe(false);
    expect(dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)).toBe(true);
    // Default should be under real home unless WORKSPACE_ROOT ENV overrides.
    if (!process.env.WORKSPACE_ROOT) {
      expect(dir).toBe(resolve(process.env.YAOE_HOME ?? resolve(homedir(), ".yaoe-flow"), "worktrees"));
    }
  });
});
