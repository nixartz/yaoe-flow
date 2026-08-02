// systemd user unit — `yaoe-flow setup --systemd`.
// Runs as a USER service (not system/root): the subscription CLIs keep their
// credentials in the logged-in user's HOME and the daemon must see them — a
// system/root service would not.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { daemonStartArgv } from "../paths";

const execFileAsync = promisify(execFile);

function unitPath(): string {
  return resolve(homedir(), ".config", "systemd", "user", "yaoe-flow.service");
}

/** Minimal escaping for ExecStart (paths with spaces/quotes). */
function quoteArg(arg: string): string {
  if (!/[\s"\\]/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function generateSystemdUnit(): string {
  const execStart = daemonStartArgv().map(quoteArg).join(" ");
  const home = homedir();
  return `[Unit]
Description=YAOE-FLOW daemon (Yet Another Orchestration Engine-Flow)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=HOME=%h
Environment=PATH=${home}/.yaoe-flow/harness/bin:${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface SystemdInstallResult {
  path: string;
  enabled: boolean;
  lingerHint: string;
}

export async function installSystemdUnit(): Promise<SystemdInstallResult> {
  const path = unitPath();
  mkdirSync(resolve(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(path, generateSystemdUnit());

  let enabled = false;
  try {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", "yaoe-flow"]);
    enabled = true;
  } catch (e) {
    console.log(`  ⚠️  could not enable via systemctl automatically (${String(e)}).`);
    console.log("      run manually: systemctl --user daemon-reload && systemctl --user enable --now yaoe-flow");
  }

  return {
    path,
    enabled,
    lingerHint: `to survive logout on a VM: sudo loginctl enable-linger ${process.env.USER ?? process.env.LOGNAME ?? "$USER"}`,
  };
}
