// `yaoe-flow stop [--force]`: graceful shutdown (SIGTERM — the process stops
// accepting dispatches and waits for in-flight runs, same shutdown behavior as
// the container) or immediate kill (--force, SIGKILL — stuck seats are
// reclaimed by liveness on the next boot, existing scheduler behavior).
import { existsSync, rmSync } from "node:fs";
import { bootstrap } from "../config/bootstrap";
import { flagBool } from "./args";
import { isYaoeProcess, isPidAlive, readPidFile } from "./paths";

export async function cmdStop(flags: Record<string, string | boolean>): Promise<void> {
  const pid = readPidFile();
  if (!pid || !isPidAlive(pid)) {
    console.log("yaoe-flow: no daemon running (PID file missing or process dead).");
    if (existsSync(bootstrap.yaoePidFile)) rmSync(bootstrap.yaoePidFile, { force: true });
    return;
  }

  // Refuse to kill a PID that does not look like the daemon — a PID recycle
  // between reading the file and the kill could take down an innocent process
  // (especially with --force / SIGKILL).
  if (!isYaoeProcess(pid)) {
    console.error(
      `yaoe-flow: PID ${pid} in the pidfile does not look like the daemon (possible recycle) — removing ${bootstrap.yaoePidFile} WITHOUT sending a signal.`
    );
    rmSync(bootstrap.yaoePidFile, { force: true });
    process.exitCode = 1;
    return;
  }

  const force = flagBool(flags, "force");
  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  console.log(`yaoe-flow: ${force ? "SIGKILL" : "SIGTERM"} sent to PID ${pid}.`);

  if (force) {
    rmSync(bootstrap.yaoePidFile, { force: true });
    return;
  }

  // Wait up to 30s for the process to exit on its own (it removes its own
  // pidfile in the SIGTERM handler — see cmdDaemon) before returning.
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    if (!isPidAlive(pid)) {
      console.log("yaoe-flow: daemon stopped.");
      return;
    }
  }
  console.log("yaoe-flow: daemon still running after 30s — use --force to kill it immediately.");
}
