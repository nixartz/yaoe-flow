// BOOTSTRAP subset of the configuration: variables needed BEFORE the database
// can be opened (or to start the process at all) — which is why they always
// (and only) live in ENV, never in the `settings` table. They show up on the
// dashboard Config screen as read-only, with a "bootstrap" badge.
//
// This module is part of the `src/config/` family (the only one authorized to
// read process.env — see AGENTS.md) and imports NOTHING from the application:
// it is safe to import from anywhere (db, secrets, config service) without
// creating a cycle.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// YAOE_HOME (docs/daemon-binary.md §4): disk layout of the service. Always
// ~/.yaoe-flow by default — dev mode (`bun --watch`) and the installed
// binary/daemon resolve to the SAME home, so config, data and worktrees never
// fork between modes. Resolved before any other field so config.env can be
// loaded into process.env — real process ENV always wins (same precedence as
// the rest of config/); config.env only fills what is missing. Harmless no-op
// in Docker (the file simply does not exist there).
const yaoeHome = process.env.YAOE_HOME ?? resolve(homedir(), ".yaoe-flow");
const configEnvPath = resolve(yaoeHome, "config.env");

// Recorded BEFORE config.env is merged into process.env: distinguishes "the
// operator provided APP_ENCRYPTION_KEY via real environment" (Docker/K8s —
// passes the daemon's first-run setup gate) from "the key came from the
// config.env the wizard wrote".
const encryptionKeyFromEnv = process.env.APP_ENCRYPTION_KEY !== undefined;

/** Exported for unit tests only (test/bootstrap-env.test.ts) — no other use. */
export function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return key ? [key, value] : null;
}

function loadConfigEnvFile(): void {
  if (!existsSync(configEnvPath)) return;
  for (const line of readFileSync(configEnvPath, "utf8").split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadConfigEnvFile();

export const bootstrap = {
  host: process.env.HOST ?? "localhost",
  port: Number(process.env.PORT ?? 4790),
  valkeyUrl: process.env.VALKEY_URL ?? "redis://valkey:6379",
  dashboardEnabled: (process.env.DASHBOARD_ENABLED ?? "true") === "true",
  dashboardPort: Number(process.env.DASHBOARD_PORT ?? 4791),
  // Default lives under YAOE_HOME — Docker and dev may still override with an
  // explicit DASHBOARD_DB_PATH (.env / docker-compose).
  dashboardDbPath: process.env.DASHBOARD_DB_PATH ?? resolve(yaoeHome, "data", "dashboard.sqlite"),
  dashboardStaticDir: process.env.DASHBOARD_STATIC_DIR ?? resolve(process.cwd(), "dashboard", "dist"),
  // dashboardSessionSecret/appEncryptionKey are GETTERS (not fixed values): the
  // `yaoe-flow setup` wizard generates these keys and writes them to
  // config.env/process.env IN THE MIDDLE of the same process — the following
  // wizard steps (opening the database, encrypting settings) must see the new
  // value without a restart. The other fields of this object never change at
  // runtime (paths/ports resolved once at boot).
  get dashboardSessionSecret() {
    return process.env.DASHBOARD_SESSION_SECRET ?? "";
  },
  /**
   * At-rest encryption key (AES-256-GCM) for secrets stored in the database.
   * REQUIRED: the process refuses to start without it — see assertEncryptionKey.
   */
  get appEncryptionKey() {
    return process.env.APP_ENCRYPTION_KEY ?? "";
  },

  // Disk layout (docs/daemon-binary.md §4) — used by the `yaoe-flow` CLI
  // (setup/daemon/status/doctor/stop) and by agent dispatch (worktrees).
  yaoeHome,
  encryptionKeyFromEnv,
  yaoeDataDir: resolve(yaoeHome, "data"),
  yaoeLogsDir: resolve(yaoeHome, "logs"),
  yaoeWorktreesDir: resolve(yaoeHome, "worktrees"),
  yaoePidFile: resolve(yaoeHome, "yaoe-flow.pid"),
  yaoeConfigEnvPath: configEnvPath,
} as const;

/**
 * Expand `$YAOE_HOME` placeholders in configured paths. Registry defaults use
 * the literal string `$YAOE_HOME/...`; without expansion, svc.str() returns that
 * truthy string and worktrees land in `./$YAOE_HOME/worktrees` relative to cwd.
 */
export function expandYaoeHomePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (!trimmed.includes("$YAOE_HOME")) return trimmed;
  return trimmed.split("$YAOE_HOME").join(yaoeHome);
}
