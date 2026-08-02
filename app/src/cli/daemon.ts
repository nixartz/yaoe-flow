// `yaoe-flow daemon [-d]`: boots the same entrypoint as Docker (API +
// scheduler + dashboard). Foreground by default (systemd/launchd manage the
// process); -d = simple detach (fork + PID file).
import { openSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrap } from "../config/bootstrap";
import { flagBool } from "./args";
import { daemonStartArgv, ensureYaoeDirs, isYaoeProcess, isPidAlive, readPidFile } from "./paths";
import { readConfigEnv, SETUP_COMPLETED_KEY } from "./setup/configEnv";

// Marks the CHILD process re-exec'ed by detachAndSpawn (-d): it is born with
// the PID file already written by the PARENT (same PID — Bun.spawn returns the
// pid before the child finishes booting), so it must SKIP the "already
// running" guard (otherwise it sees itself in the pidfile and refuses to
// start) and must not rewrite the file (it is already correct).
const REEXEC_MARKER = "YAOE_DAEMON_CHILD";

function refuseRoot(): void {
  // Host security: the subscription CLIs keep their credentials in the HOME of
  // the logged-in user — running as root breaks that premise and is usually a
  // provisioning mistake.
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    console.error(
      "yaoe-flow: refusing to run as root — the daemon needs the HOME of the user who owns the harness CLI sessions."
    );
    process.exit(1);
  }
}

/**
 * First-run gate: the daemon/service only starts after `yaoe-flow setup` has
 * completed once (it writes SETUP_COMPLETED_KEY into config.env). Environments
 * configured purely via ENV (Docker/K8s: APP_ENCRYPTION_KEY provided by the
 * real process environment) pass the gate without the wizard.
 */
function assertSetupCompleted(): void {
  if (bootstrap.encryptionKeyFromEnv) return;
  const completed = readConfigEnv().get(SETUP_COMPLETED_KEY);
  if (completed) return;
  console.error(
    "yaoe-flow: initial setup has not been run yet — the service needs its keys and\n" +
      `configuration in ${bootstrap.yaoeConfigEnvPath} before it can start.\n\n` +
      '  Run "yaoe-flow setup" first (guided wizard, takes a few minutes).\n\n' +
      "  (Docker/K8s deployments configured purely via environment variables pass\n" +
      "  this gate automatically when APP_ENCRYPTION_KEY is set in the environment.)"
  );
  process.exit(1);
}

export async function cmdDaemon(flags: Record<string, string | boolean>): Promise<void> {
  refuseRoot();
  assertSetupCompleted();
  ensureYaoeDirs();

  const isReexecChild = process.env[REEXEC_MARKER] === "1";

  if (!isReexecChild) {
    const existing = readPidFile();
    // Only blocks if the live PID STILL looks like the daemon — a stale
    // pidfile pointing at another process (recycle) is cleaned and ignored.
    if (existing && isPidAlive(existing) && isYaoeProcess(existing)) {
      console.error(`yaoe-flow: already running (PID ${existing}, see ${bootstrap.yaoePidFile}) — run "yaoe-flow stop" first.`);
      process.exit(1);
    }
    if (existing && (!isPidAlive(existing) || !isYaoeProcess(existing))) {
      rmSync(bootstrap.yaoePidFile, { force: true });
    }
  }

  if (flagBool(flags, "d")) {
    detachAndSpawn();
    return;
  }

  if (!isReexecChild) writeFileSync(bootstrap.yaoePidFile, String(process.pid));
  const cleanup = () => {
    try {
      rmSync(bootstrap.yaoePidFile, { force: true });
    } catch {
      // best-effort — must never break shutdown.
    }
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  const { bootServer } = await import("../server");
  bootServer();
}

function detachAndSpawn(): void {
  const logFile = resolve(bootstrap.yaoeLogsDir, "yaoe-flow.log");
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  // Rebuilds the command WITHOUT "-d". Compiled binary vs bun+script: see
  // daemonStartArgv() — same rule as the systemd/launchd/schtasks units.
  const userArgs = process.argv.slice(2).filter((a) => a !== "-d" && a !== "--d");
  // daemonStartArgv() already ends in "daemon"; if the user passed extra flags
  // we preserve everything after the subcommand, dropping only the "-d".
  const base = daemonStartArgv();
  const flagsOnly = userArgs.filter((a) => a !== "daemon");
  const cmd = [...base, ...flagsOnly];

  const child = Bun.spawn({
    cmd,
    stdin: "ignore",
    stdout: out,
    stderr: err,
    env: { ...process.env, [REEXEC_MARKER]: "1" },
  });
  child.unref();
  writeFileSync(bootstrap.yaoePidFile, String(child.pid));
  console.log(`yaoe-flow: daemon started in the background (PID ${child.pid}) — logs at ${logFile}`);
}
