import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_TMP_DIR } from "./setup";
import {
  writeClaudeCodeAttribution,
  writeCodexCommitAttribution,
  writeCursorCliAttribution,
} from "../src/agent/harness/attribution";
import { isolatedCursorHome } from "../src/agent/harness/cursor";
import { invalidateSettingsCache, resetSetting, setSetting } from "../src/config/service";

afterEach(() => {
  try {
    resetSetting("CURSOR_ATTRIBUTION", null);
  } catch {
    /* ok */
  }
  invalidateSettingsCache();
});

describe("harness attribution writers", () => {
  test("Cursor cli-config: liga e desliga attributeCommitsToAgent/attributePRsToAgent", () => {
    const dir = mkdtempSync(join(TEST_TMP_DIR, "cursor-attr-"));
    writeCursorCliAttribution(dir, true);
    let json = JSON.parse(readFileSync(join(dir, "cli-config.json"), "utf8"));
    expect(json.attribution.attributeCommitsToAgent).toBe(true);
    expect(json.attribution.attributePRsToAgent).toBe(true);

    writeCursorCliAttribution(dir, false);
    json = JSON.parse(readFileSync(join(dir, "cli-config.json"), "utf8"));
    expect(json.attribution.attributeCommitsToAgent).toBe(false);
    expect(json.attribution.attributePRsToAgent).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("Cursor preserva campos pré-existentes do cli-config", () => {
    const dir = mkdtempSync(join(TEST_TMP_DIR, "cursor-attr-merge-"));
    writeFileSync(
      join(dir, "cli-config.json"),
      JSON.stringify({
        version: 1,
        editor: { vimMode: true },
        permissions: { allow: ["Shell(ls)"], deny: [] },
        model: { id: "auto" },
      })
    );
    writeCursorCliAttribution(dir, false);
    const json = JSON.parse(readFileSync(join(dir, "cli-config.json"), "utf8"));
    expect(json.editor.vimMode).toBe(true);
    expect(json.permissions.allow).toEqual(["Shell(ls)"]);
    expect(json.model.id).toBe("auto");
    expect(json.attribution.attributeCommitsToAgent).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("Claude Code settings: disable zera attribution; enable restaura trailer", () => {
    const dir = mkdtempSync(join(TEST_TMP_DIR, "claude-attr-"));
    writeClaudeCodeAttribution(dir, false);
    let json = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(json.attribution.commit).toBe("");
    expect(json.attribution.pr).toBe("");
    expect(json.attribution.sessionUrl).toBe(false);
    expect(json.includeCoAuthoredBy).toBe(false);

    writeClaudeCodeAttribution(dir, true);
    json = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(json.attribution.commit).toContain("Co-Authored-By");
    expect(json.attribution.pr).toBeTruthy();
    expect(json.includeCoAuthoredBy).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("Codex config.toml: disable escreve commit_attribution vazio; enable remove a chave", () => {
    const dir = mkdtempSync(join(TEST_TMP_DIR, "codex-attr-"));
    writeFileSync(join(dir, "config.toml"), 'model = "gpt-5"\ncommit_attribution = "Custom"\n');
    writeCodexCommitAttribution(dir, false);
    let body = readFileSync(join(dir, "config.toml"), "utf8");
    expect(body).toContain('model = "gpt-5"');
    expect(body).toContain('commit_attribution = ""');
    expect(body.match(/commit_attribution/g)?.length).toBe(1);

    writeCodexCommitAttribution(dir, true);
    body = readFileSync(join(dir, "config.toml"), "utf8");
    expect(body).toContain('model = "gpt-5"');
    expect(body).not.toMatch(/commit_attribution/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Cursor isolation + attribution", () => {
  test("HOME isolado aplica CURSOR_ATTRIBUTION no cli-config sem tocar o host", () => {
    setSetting("CURSOR_ATTRIBUTION", "false", null);
    invalidateSettingsCache();

    const realHome = mkdtempSync(join(TEST_TMP_DIR, "fake-home-attr-"));
    mkdirSync(join(realHome, ".cursor"), { recursive: true });
    writeFileSync(join(realHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { pessoal: {} } }));
    writeFileSync(
      join(realHome, ".cursor", "cli-config.json"),
      JSON.stringify({
        version: 1,
        editor: { vimMode: false },
        permissions: { allow: [], deny: [] },
        attribution: { attributeCommitsToAgent: true, attributePRsToAgent: true },
      })
    );
    const cwd = join(mkdtempSync(join(TEST_TMP_DIR, "run-ws-")), "run-1");
    mkdirSync(cwd, { recursive: true });

    const prep = isolatedCursorHome(
      { runId: "run-attr", cwd, settings: {}, env: { HOME: realHome } },
      { HOME: realHome }
    );
    const isolated = prep.env!.HOME!;
    expect(isolated).not.toBe(realHome);

    const runCliPath = join(isolated, ".cursor", "cli-config.json");
    expect(lstatSync(runCliPath).isSymbolicLink()).toBe(false);
    const runCli = JSON.parse(readFileSync(runCliPath, "utf8"));
    expect(runCli.attribution.attributeCommitsToAgent).toBe(false);
    expect(runCli.attribution.attributePRsToAgent).toBe(false);

    const hostCli = JSON.parse(readFileSync(join(realHome, ".cursor", "cli-config.json"), "utf8"));
    expect(hostCli.attribution.attributeCommitsToAgent).toBe(true);

    prep.cleanup?.();
    expect(existsSync(isolated)).toBe(false);
    rmSync(realHome, { recursive: true, force: true });
  });
});
