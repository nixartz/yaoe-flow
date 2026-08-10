#!/usr/bin/env bun
// Codegen for the self-contained binary: reads migrations (app/drizzle),
// seed SOULs (agents/) and the SPA build (dashboard/dist) from disk and
// generates app/src/embedded-assets.generated.ts with INLINE content (plain
// text for migrations/SOULs, base64 for the SPA) — avoids depending on
// `import ... with { type: "file" }` in `bun build --compile` for a dynamic
// file tree (the SPA has hashed filenames, regenerated on every build).
//
// What is committed to git:
//   - migrations + SOULs + protocol (needed by `bun test` / local migrator)
//   - EMBEDDED_DASHBOARD_ASSETS = {} (SPA is NEVER committed — rebuild at
//     release / install-local time via `dashboard && bun run build` then embed)
//
// Release / install-local MUST run dashboard build → embed-assets --require-dashboard
// → bun build --compile, in that order.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DRIZZLE_DIR = resolve(ROOT, "drizzle");
const AGENTS_DIR = resolve(ROOT, "..", "agents");
const DASHBOARD_DIST = resolve(ROOT, "..", "dashboard", "dist");
const OUT_FILE = resolve(ROOT, "src", "embedded-assets.generated.ts");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface EmbedArgs {
  /** Fail if dashboard/dist is missing or empty (release / install-local). */
  requireDashboard: boolean;
  /** Do not read dashboard/dist — write EMBEDDED_DASHBOARD_ASSETS = {} (git commit shape). */
  noDashboard: boolean;
}

export function parseEmbedArgs(argv: string[]): EmbedArgs {
  const out: EmbedArgs = { requireDashboard: false, noDashboard: false };
  for (const a of argv) {
    if (a === "--require-dashboard") out.requireDashboard = true;
    else if (a === "--no-dashboard") out.noDashboard = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun scripts/generate-embedded-assets.ts [--require-dashboard] [--no-dashboard]

  --require-dashboard  exit 1 if dashboard/dist has no assets (CI/release)
  --no-dashboard       ignore dashboard/dist; embed empty SPA (committed stub)`);
      process.exit(0);
    } else {
      console.error(`embed-assets: unknown flag: ${a}`);
      process.exit(1);
    }
  }
  if (out.requireDashboard && out.noDashboard) {
    console.error("embed-assets: --require-dashboard and --no-dashboard are mutually exclusive");
    process.exit(1);
  }
  return out;
}

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function loadMigrations(): { migrations: Record<string, string>; journal: string | null } {
  if (!existsSync(DRIZZLE_DIR)) return { migrations: {}, journal: null };
  const migrations: Record<string, string> = {};
  for (const file of readdirSync(DRIZZLE_DIR)) {
    if (file.endsWith(".sql")) migrations[file.replace(/\.sql$/, "")] = readFileSync(join(DRIZZLE_DIR, file), "utf8");
  }
  const journalPath = join(DRIZZLE_DIR, "meta", "_journal.json");
  const journal = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : null;
  return { migrations, journal };
}

function loadSouls(): { souls: Record<string, string>; protocol: string | null } {
  if (!existsSync(AGENTS_DIR)) return { souls: {}, protocol: null };
  const souls: Record<string, string> = {};
  for (const file of readdirSync(AGENTS_DIR)) {
    if (file.endsWith(".SOUL.md")) souls[file] = readFileSync(join(AGENTS_DIR, file), "utf8");
  }
  const protocolPath = join(AGENTS_DIR, "COMMUNICATION_PROTOCOL.md");
  const protocol = existsSync(protocolPath) ? readFileSync(protocolPath, "utf8") : null;
  return { souls, protocol };
}

function loadDashboardAssets(): Record<string, { base64: string; contentType: string }> {
  if (!existsSync(DASHBOARD_DIST)) return {};
  const assets: Record<string, { base64: string; contentType: string }> = {};
  for (const file of walk(DASHBOARD_DIST)) {
    const rel = relative(DASHBOARD_DIST, file).split(sep).join("/");
    assets[rel] = { base64: readFileSync(file).toString("base64"), contentType: contentType(file) };
  }
  return assets;
}

export function generateEmbeddedAssets(args: EmbedArgs): { migrationCount: number; soulCount: number; spaCount: number } {
  const { migrations, journal } = loadMigrations();
  const { souls, protocol } = loadSouls();
  const dashboardAssets = args.noDashboard ? {} : loadDashboardAssets();
  const spaCount = Object.keys(dashboardAssets).length;

  if (Object.keys(migrations).length === 0) {
    console.warn(`⚠️  no migrations found in ${DRIZZLE_DIR} — the compiled binary would ship without a schema.`);
  }
  if (spaCount === 0 && !args.noDashboard) {
    const msg = `⚠️  ${DASHBOARD_DIST} does not exist or is empty — run "bun run build" in dashboard/ first (the SPA will not be embedded).`;
    if (args.requireDashboard) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg);
  }
  if (args.requireDashboard && spaCount === 0) {
    console.error(`embed-assets: --require-dashboard but 0 SPA assets under ${DASHBOARD_DIST}`);
    process.exit(1);
  }

  const body = `// GENERATED by scripts/generate-embedded-assets.ts at ${new Date().toISOString()} — do NOT hand-edit.
// SPA (EMBEDDED_DASHBOARD_ASSETS): empty in git; filled by release/install-local after \`dashboard && bun run build\`.
export interface EmbeddedFile {
  base64: string;
  contentType: string;
}

export const EMBEDDED_MIGRATIONS: Record<string, string> = ${JSON.stringify(migrations, null, 2)};
export const EMBEDDED_MIGRATIONS_JOURNAL: string | null = ${journal ? JSON.stringify(journal) : "null"};

export const EMBEDDED_SOULS: Record<string, string> = ${JSON.stringify(souls, null, 2)};
export const EMBEDDED_COMMUNICATION_PROTOCOL: string | null = ${protocol ? JSON.stringify(protocol) : "null"};

export const EMBEDDED_DASHBOARD_ASSETS: Record<string, EmbeddedFile> = ${JSON.stringify(dashboardAssets, null, 2)};
`;

  writeFileSync(OUT_FILE, body);
  console.log(
    `✅ ${OUT_FILE}: ${Object.keys(migrations).length} migration(s), ${Object.keys(souls).length} SOUL(s), ${spaCount} SPA asset(s).`
  );
  return {
    migrationCount: Object.keys(migrations).length,
    soulCount: Object.keys(souls).length,
    spaCount,
  };
}

if (import.meta.main) {
  generateEmbeddedAssets(parseEmbedArgs(process.argv.slice(2)));
}
