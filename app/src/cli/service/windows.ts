// Task Scheduler at user logon — `yaoe-flow setup` on Windows. User session
// (not a real Windows Service/session 0) — that would break the premise that
// harness CLI credentials live in the logged-in user's HOME.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { daemonStartArgv } from "../paths";

const execFileAsync = promisify(execFile);
const TASK_NAME = "YaoeFlowDaemon";

/** schtasks `/tr` line: quote each arg containing spaces. */
function taskRun(): string {
  return daemonStartArgv()
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ");
}

export function schtasksCommand(): string {
  return `schtasks /create /tn "${TASK_NAME}" /tr "${taskRun().replace(/"/g, '\\"')}" /sc onlogon /rl limited /f`;
}

export interface WindowsInstallResult {
  created: boolean;
  command: string;
}

export async function installWindowsTask(): Promise<WindowsInstallResult> {
  const command = schtasksCommand();
  try {
    await execFileAsync("schtasks", [
      "/create",
      "/tn",
      TASK_NAME,
      "/tr",
      taskRun(),
      "/sc",
      "onlogon",
      "/rl",
      "limited",
      "/f",
    ]);
    return { created: true, command };
  } catch (e) {
    console.log(`  ⚠️  could not create the Task automatically (${String(e)}).`);
    console.log(`      run manually: ${command}`);
    return { created: false, command };
  }
}
