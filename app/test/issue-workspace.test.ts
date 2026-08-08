import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseIssueIdFromWorkspaceDirName,
  isIssueWorkspaceCwd,
  cleanupAfterRun,
  removeWorkspaceTree,
  removeOrphanEphemeralRunDirs,
  workspaceHoldingStates,
  ISSUE_WORKSPACE_PREFIX,
  RUN_WORKSPACE_PREFIX,
} from "../src/agent/workspace";

describe("issue workspace paths", () => {
  test("parseIssueIdFromWorkspaceDirName ignores siblings", () => {
    expect(parseIssueIdFromWorkspaceDirName("issue-abc-uuid")).toBe("abc-uuid");
    expect(parseIssueIdFromWorkspaceDirName("issue-abc-uuid-home")).toBeNull();
    expect(parseIssueIdFromWorkspaceDirName("issue-abc-uuid-cursor-config")).toBeNull();
    expect(parseIssueIdFromWorkspaceDirName("run-123")).toBeNull();
  });

  test("isIssueWorkspaceCwd", () => {
    expect(isIssueWorkspaceCwd("/tmp/worktrees/issue-abc")).toBe(true);
    expect(isIssueWorkspaceCwd("/tmp/worktrees/issue-abc-home")).toBe(false);
    expect(isIssueWorkspaceCwd("/tmp/worktrees/run-9")).toBe(false);
  });

  test("cleanupAfterRun keeps issue dirs and removes ephemeral run dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "yaoe-ws-"));
    try {
      const issueCwd = join(root, `${ISSUE_WORKSPACE_PREFIX}abc`);
      const runCwd = join(root, "run-99");
      mkdirSync(issueCwd);
      mkdirSync(runCwd);
      writeFileSync(join(issueCwd, "keep.txt"), "x");
      writeFileSync(join(runCwd, "gone.txt"), "y");

      cleanupAfterRun(issueCwd, false);
      expect(existsSync(join(issueCwd, "keep.txt"))).toBe(true);

      cleanupAfterRun(runCwd, false);
      expect(existsSync(runCwd)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removeWorkspaceTree drops cwd and siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "yaoe-ws-"));
    try {
      const cwd = join(root, "issue-xyz");
      const home = `${cwd}-home`;
      mkdirSync(cwd);
      mkdirSync(home);
      removeWorkspaceTree(cwd);
      expect(existsSync(cwd)).toBe(false);
      expect(existsSync(home)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceHoldingStates includes Planned/Blocked but not Completed", () => {
    const holding = workspaceHoldingStates({
      refining: "Refining",
      planned: "Planned",
      inProgress: "In Progress",
      codeReview: "Code Review",
      inReview: "In Review",
      reopened: "Reopened",
      pendingMerge: "Pending Merge",
      blocked: "Blocked",
    });
    expect(holding.has("Planned")).toBe(true);
    expect(holding.has("Blocked")).toBe(true);
    expect(holding.has("Refining")).toBe(true);
    expect(holding.has("Completed")).toBe(false);
    expect(holding.has("To Do")).toBe(false);
  });

  test("removeOrphanEphemeralRunDirs spares active cwds and drops idle run-*", () => {
    const root = mkdtempSync(join(tmpdir(), "yaoe-ws-"));
    try {
      const idle = join(root, `${RUN_WORKSPACE_PREFIX}idle`);
      const live = join(root, `${RUN_WORKSPACE_PREFIX}live`);
      mkdirSync(idle);
      mkdirSync(live);
      mkdirSync(`${idle}-home`);
      const n = removeOrphanEphemeralRunDirs(new Set([live]), root);
      expect(n).toBe(1);
      expect(existsSync(idle)).toBe(false);
      expect(existsSync(`${idle}-home`)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
