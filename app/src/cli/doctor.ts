// `yaoe-flow doctor`: deep diagnosis with ✅/⚠️/❌ and a fix instruction per
// item. Reuses the SAME harness detection (app/src/agent/harness/detect.ts)
// that already feeds the Harness screen — nothing is reimplemented, only
// reported in CLI form.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import Redis from "ioredis";
import { bootstrap } from "../config/bootstrap";
import { flagBool } from "./args";

const execFileAsync = promisify(execFile);

type Level = "ok" | "warn" | "error";
interface Check {
  level: Level;
  label: string;
  detail?: string;
  fix?: string;
}

const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️", error: "❌" };

function printCheck(c: Check): void {
  console.log(`${ICON[c.level]} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  if (c.fix) console.log(`   → ${c.fix}`);
}

function checkEncryptionKey(): Check {
  const key = bootstrap.appEncryptionKey;
  if (key && /^[0-9a-fA-F]{64}$/.test(key)) {
    return { level: "ok", label: "APP_ENCRYPTION_KEY present and valid" };
  }
  return {
    level: "error",
    label: "APP_ENCRYPTION_KEY missing or invalid",
    fix: `generate with "openssl rand -hex 32" and store in ${bootstrap.yaoeConfigEnvPath} (or run "yaoe-flow setup")`,
  };
}

function checkConfigEnvPermissions(): Check | null {
  // Only relevant in binary mode (config.env exists). Docker does not use the file.
  if (process.platform === "win32") return null;
  const path = bootstrap.yaoeConfigEnvPath;
  if (!existsSync(path)) return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode === 0o600) {
      return { level: "ok", label: "config.env has 0600 permissions" };
    }
    return {
      level: "warn",
      label: `config.env has 0${mode.toString(8)} permissions (expected 0600)`,
      detail: path,
      fix: `chmod 600 ${path} — the file contains APP_ENCRYPTION_KEY / DASHBOARD_SESSION_SECRET`,
    };
  } catch (e) {
    return { level: "warn", label: "could not read config.env permissions", detail: String(e) };
  }
}

async function checkDatabase(): Promise<Check> {
  try {
    const { appDb } = await import("../db");
    appDb();
    return { level: "ok", label: "database open and migrations up to date", detail: bootstrap.dashboardDbPath };
  } catch (e) {
    return {
      level: "error",
      label: "failed to open/migrate the database",
      detail: String(e),
      fix: "check the data dir permissions and APP_ENCRYPTION_KEY",
    };
  }
}

function checkDataDirWritable(): Check {
  const dir = bootstrap.yaoeDataDir;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const probe = resolve(dir, ".doctor-write-test");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return { level: "ok", label: "data dir writable", detail: dir };
  } catch (e) {
    return { level: "error", label: "data dir not writable", detail: dir, fix: `check owner/permissions of ${dir}` };
  }
}

async function checkGit(): Promise<Check> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    return { level: "ok", label: "git installed", detail: stdout.trim() };
  } catch {
    return { level: "error", label: "git not found on PATH", fix: "install git — required (agents clone repos)" };
  }
}

async function checkValkey(offline: boolean): Promise<Check> {
  const url = bootstrap.valkeyUrl;
  if (offline) return { level: "warn", label: "Valkey not checked (--offline)", detail: url };
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    const pong = await redis.ping();
    return { level: pong === "PONG" ? "ok" : "warn", label: "Valkey reachable", detail: url };
  } catch (e) {
    return {
      level: "error",
      label: "Valkey unreachable",
      detail: url,
      fix: 'run "yaoe-flow setup" to configure/install it',
    };
  } finally {
    redis.disconnect();
  }
}

async function checkLinear(offline: boolean): Promise<Check> {
  if (offline) return { level: "warn", label: "Linear not checked (--offline)" };
  const { config } = await import("../config");
  const key = config.linear.apiKey;
  if (!key) return { level: "warn", label: "Linear not configured", fix: 'run "yaoe-flow setup" or set LINEAR_API_KEY' };
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: "{ viewer { id name email } }" }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json().catch(() => null)) as { data?: { viewer?: { name?: string; email?: string } }; errors?: unknown } | null;
    if (!res.ok || !json || json.errors || !json.data?.viewer) {
      return { level: "error", label: "Linear API key invalid", fix: "generate a new one at Linear → Settings → API" };
    }
    return { level: "ok", label: "Linear ok", detail: `logged in as ${json.data.viewer.name ?? json.data.viewer.email}` };
  } catch (e) {
    return { level: "error", label: "Linear unreachable", detail: String(e) };
  }
}

async function checkGithub(offline: boolean): Promise<Check> {
  if (offline) return { level: "warn", label: "GitHub not checked (--offline)" };
  const { config } = await import("../config");
  const token = config.github.token;
  if (!token) return { level: "warn", label: "GitHub not configured", fix: 'run "yaoe-flow setup" or set GITHUB_TOKEN' };
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { level: "error", label: "GitHub token invalid", detail: `HTTP ${res.status}`, fix: "generate a new token" };
    const json = (await res.json()) as { login?: string };
    return { level: "ok", label: "GitHub ok", detail: `logged in as ${json.login}` };
  } catch (e) {
    return { level: "error", label: "GitHub unreachable", detail: String(e) };
  }
}

async function checkHarness(): Promise<Check[]> {
  try {
    const { harnessReport } = await import("../agent/harness/detect");
    const report = harnessReport();
    return report.map((h): Check => {
      if (!h.detection) {
        return {
          level: "warn",
          label: `harness ${h.label}: not detected yet`,
          fix: 'start the daemon once (detection runs at boot) or run "yaoe-flow setup"',
        };
      }
      if (!h.detection.installed) {
        return { level: "warn", label: `harness ${h.label}: not installed`, fix: h.detection.installHint };
      }
      if (h.detection.authStatus === "not-logged") {
        return { level: "warn", label: `harness ${h.label}: installed, not logged in`, detail: h.detection.version, fix: h.detection.loginHint };
      }
      if (h.detection.authStatus === "unknown") {
        return { level: "warn", label: `harness ${h.label}: installed, auth unknown`, detail: h.detection.version };
      }
      return { level: "ok", label: `harness ${h.label}: installed and authenticated`, detail: h.detection.version };
    });
  } catch (e) {
    return [{ level: "error", label: "failed to read harness detection", detail: String(e) }];
  }
}

// No individual check may take down the whole command — it is exactly when
// something is broken (e.g. corrupted database) that doctor must keep going
// and report the OTHER checks instead of crashing without a diagnosis.
async function safe(label: string, fn: () => Promise<Check> | Check): Promise<Check> {
  try {
    return await fn();
  } catch (e) {
    return { level: "error", label: `${label}: unexpected failure`, detail: String(e) };
  }
}

export async function cmdDoctor(flags: Record<string, string | boolean>): Promise<void> {
  const offline = flagBool(flags, "offline");

  console.log(`yaoe-flow doctor — ${bootstrap.yaoeHome}\n`);

  const checks: Check[] = [
    await safe("APP_ENCRYPTION_KEY", () => checkEncryptionKey()),
    await safe("data dir", () => checkDataDirWritable()),
    await safe("git", () => checkGit()),
    await safe("database", () => checkDatabase()),
    await safe("Valkey", () => checkValkey(offline)),
    await safe("Linear", () => checkLinear(offline)),
    await safe("GitHub", () => checkGithub(offline)),
  ];
  const perms = checkConfigEnvPermissions();
  if (perms) checks.splice(1, 0, perms);
  try {
    checks.push(...(await checkHarness()));
  } catch (e) {
    checks.push({ level: "error", label: "harness: unexpected failure", detail: String(e) });
  }

  for (const c of checks) printCheck(c);

  const errors = checks.filter((c) => c.level === "error").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  console.log(`\n${errors} error(s), ${warns} warning(s), ${checks.length - errors - warns} ok.`);
  if (errors > 0) process.exitCode = 1;
}
