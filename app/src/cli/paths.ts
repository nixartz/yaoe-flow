// Disk layout of the standalone binary mode (docs/daemon-binary.md §4):
//   ~/.yaoe-flow/{config.env, data/dashboard.sqlite, logs/, worktrees/, yaoe-flow.pid}
// The paths themselves live in config/bootstrap.ts (the family authorized to
// read process.env/YAOE_HOME) — this module only guarantees the directories
// exist before any CLI command uses them, plus PID-file / daemon-argv helpers
// (shared by detach, systemd, launchd, schtasks).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "../config/bootstrap";

/** Path of the binary installed by `install-local` / install.sh (if present). */
export function installedYaoeBin(): string | null {
  const dir = process.env.YAOE_INSTALL_DIR || join(homedir(), ".local", "bin");
  const name = process.platform === "win32" ? "yaoe-flow.exe" : "yaoe-flow";
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  return path;
}

export function ensureYaoeDirs(): void {
  for (const dir of [bootstrap.yaoeHome, bootstrap.yaoeDataDir, bootstrap.yaoeLogsDir, bootstrap.yaoeWorktreesDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function readPidFile(pidFilePath: string = bootstrap.yaoePidFile): number | null {
  if (!existsSync(pidFilePath)) return null;
  const pid = Number(readFileSync(pidFilePath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort: does the PID still look like a yaoe-flow process?
 * Prevents `stop --force` from killing an innocent process after PID recycle
 * (the OS reused the number between reading the pidfile and the kill).
 */
export function isYaoeProcess(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    if (process.platform === "linux" && existsSync(`/proc/${pid}/cmdline`)) {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      return /yaoe-flow|index\.ts/.test(cmd);
    }
    if (process.platform === "darwin" || process.platform === "linux") {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
      return /yaoe-flow|index\.ts/.test(out);
    }
    if (process.platform === "win32") {
      // PowerShell is more stable than wmic (deprecated). On failure → assume
      // it is NOT ours (better to refuse the kill than kill the wrong process).
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: "utf8" }
      ).trim();
      return /yaoe-flow|index\.ts|bun/i.test(out);
    }
  } catch {
    return false;
  }
  // Unknown platform: no way to confirm identity — refuse.
  return false;
}

/**
 * Argv to start the daemon (systemd / launchd / schtasks / `daemon -d`).
 *
 * - Compiled binary (`/$bunfs/…`): `[execPath, "daemon"]` — the binary itself
 *   IS the CLI.
 * - Dev (`bun src/index.ts …`): `[bun, "/abs/path/to/index.ts", "daemon"]`
 *   — without the script path, `bun daemon` fails and the service never starts.
 */
export function daemonStartArgv(): string[] {
  // Preference: binary already installed in ~/.local/bin (install-local / release),
  // so the LaunchAgent/systemd unit does NOT point at `bun src/index.ts` inside
  // a temporary clone.
  const installed = installedYaoeBin();
  if (installed) return [installed, "daemon"];

  const argv1 = process.argv[1];
  // Same heuristic as detachAndSpawn: Bun's virtual path is NOT a script usable
  // outside this process (Windows sometimes uses "$bunfs" variants without the
  // leading "/").
  const isBunfs = !!argv1 && (argv1.startsWith("/$bunfs/") || argv1.includes("$bunfs"));
  const scriptPath = argv1 && !isBunfs ? [resolve(argv1)] : [];
  return [process.execPath, ...scriptPath, "daemon"];
}
