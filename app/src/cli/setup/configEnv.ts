// Idempotent writer for config.env — only the BOOTSTRAP set
// (config/bootstrap.ts) lives in this file; everything else (Linear, GitHub,
// agents…) is stored ENCRYPTED in the database via setSetting() — never here,
// to avoid duplicating the source of truth.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { bootstrap } from "../../config/bootstrap";

/**
 * Written by the last wizard step; its presence is the daemon's first-run
 * gate (see cli/daemon.ts assertSetupCompleted).
 */
export const SETUP_COMPLETED_KEY = "YAOE_SETUP_COMPLETED_AT";

function parse(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

export function readConfigEnv(): Map<string, string> {
  if (!existsSync(bootstrap.yaoeConfigEnvPath)) return new Map();
  return parse(readFileSync(bootstrap.yaoeConfigEnvPath, "utf8"));
}

/** Merges `updates` into the existing config.env (never deletes what is there) and writes with chmod 600. */
export function writeConfigEnv(updates: Record<string, string>): void {
  const current = readConfigEnv();
  for (const [k, v] of Object.entries(updates)) current.set(k, v);
  const body = `${[...current.entries()].map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
  writeFileSync(bootstrap.yaoeConfigEnvPath, body, { mode: 0o600 });
  chmodSync(bootstrap.yaoeConfigEnvPath, 0o600);
}

/** Marks the wizard as completed (ISO timestamp) — unlocks `yaoe-flow daemon`. */
export function markSetupCompleted(): void {
  writeConfigEnv({ [SETUP_COMPLETED_KEY]: new Date().toISOString() });
}
