// launchd LaunchAgent — `yaoe-flow setup --launchd`.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { bootstrap } from "../../config/bootstrap";
import { daemonStartArgv } from "../paths";

const execFileAsync = promisify(execFile);
const LABEL = "dev.sims.yaoe-flow";

function plistPath(): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function generateLaunchdPlist(): string {
  const logFile = resolve(bootstrap.yaoeLogsDir, "yaoe-flow.log");
  const home = homedir();
  const argsXml = daemonStartArgv()
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(`${home}/.yaoe-flow/harness/bin:${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

export interface LaunchdInstallResult {
  path: string;
  loaded: boolean;
}

export async function installLaunchdPlist(): Promise<LaunchdInstallResult> {
  const path = plistPath();
  mkdirSync(resolve(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, generateLaunchdPlist());

  let loaded = false;
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    await execFileAsync("launchctl", ["bootstrap", `gui/${uid}`, path]);
    loaded = true;
  } catch (e) {
    console.log(`  ⚠️  could not load via launchctl automatically (${String(e)}).`);
    console.log(`      run manually: launchctl bootstrap gui/$(id -u) ${path}`);
  }

  return { path, loaded };
}
