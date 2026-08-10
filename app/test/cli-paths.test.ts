// Helpers de PID file / identidade do processo (stop/daemon/status).
import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isYaoeProcess, isPidAlive, readPidFile, daemonStartArgv, installedYaoeBin } from "../src/cli/paths";

describe("cli paths (PID helpers)", () => {
  test("readPidFile: ausente / inválido / válido", () => {
    const path = join(tmpdir(), `orch-pid-${process.pid}-${Date.now()}.pid`);
    expect(readPidFile(path)).toBeNull();

    writeFileSync(path, "not-a-number\n");
    expect(readPidFile(path)).toBeNull();

    writeFileSync(path, `${process.pid}\n`);
    expect(readPidFile(path)).toBe(process.pid);

    unlinkSync(path);
  });

  test("isPidAlive: PID atual vivo; PID improvável morto", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });

  test("isYaoeProcess: fail-closed pra PID morto e pra processo sem assinatura", () => {
    expect(isYaoeProcess(2_147_483_647)).toBe(false);
    // PID 1 (launchd/init) está vivo mas NÃO é o orchestrator — não pode
    // passar no matcher, senão stop --force mataria o init do sistema.
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(isYaoeProcess(1)).toBe(false);
    }
  });

  test("daemonStartArgv: prefers installed binary when YAOE_INSTALL_DIR has one", () => {
    const prev = process.env.YAOE_INSTALL_DIR;
    const dir = mkdtempSync(join(tmpdir(), "yaoe-install-"));
    const name = process.platform === "win32" ? "yaoe-flow.exe" : "yaoe-flow";
    const bin = join(dir, name);
    writeFileSync(bin, "#!/bin/sh\n");
    process.env.YAOE_INSTALL_DIR = dir;
    try {
      expect(installedYaoeBin()).toBe(bin);
      expect(daemonStartArgv()).toEqual([bin, "daemon"]);
    } finally {
      if (prev === undefined) delete process.env.YAOE_INSTALL_DIR;
      else process.env.YAOE_INSTALL_DIR = prev;
    }
  });

  test("daemonStartArgv: inclui script path em modo bun quando não há binário instalado", () => {
    const prev = process.env.YAOE_INSTALL_DIR;
    // Empty install dir → installedYaoeBin() is null even if ~/.local/bin/yaoe-flow exists.
    const empty = mkdtempSync(join(tmpdir(), "yaoe-install-empty-"));
    process.env.YAOE_INSTALL_DIR = empty;
    try {
      expect(installedYaoeBin()).toBeNull();
      const argv = daemonStartArgv();
      expect(argv[0]).toBe(process.execPath);
      expect(argv.at(-1)).toBe("daemon");
      // Em `bun test`, argv[1] é um path real (não /$bunfs/) — o script precisa
      // aparecer, senão units de serviço gerariam `bun daemon` quebrado.
      const argv1 = process.argv[1];
      if (argv1 && !argv1.startsWith("/$bunfs/") && !argv1.includes("$bunfs")) {
        expect(argv.length).toBeGreaterThanOrEqual(3);
        expect(argv[1]).toContain(".");
      }
    } finally {
      if (prev === undefined) delete process.env.YAOE_INSTALL_DIR;
      else process.env.YAOE_INSTALL_DIR = prev;
    }
  });
});
