#!/usr/bin/env bun
// Codegen do binário autocontido (docs/daemon-binary.md §7): lê migrations
// (app/drizzle), SOULs de seed (agents/) e o build da SPA (dashboard/dist) do
// disco e gera app/src/embedded-assets.generated.ts com o conteúdo INLINE
// (texto puro pras migrations/SOULs, base64 pra SPA) — evita depender de
// `import ... with { type: "file" }` do bun build --compile pra uma árvore
// dinâmica de arquivos (a SPA tem nomes com hash, gerados a cada build).
//
// Rodado pelo pipeline de release ANTES de `bun build --compile` (nunca em
// dev/Docker — lá o placeholder vazio no git já basta, ver o próprio arquivo
// gerado). Idempotente: pode rodar de novo a qualquer momento.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function main(): void {
  const { migrations, journal } = loadMigrations();
  const { souls, protocol } = loadSouls();
  const dashboardAssets = loadDashboardAssets();

  if (Object.keys(migrations).length === 0) {
    console.warn(`⚠️  nenhuma migration encontrada em ${DRIZZLE_DIR} — o binário compilado ficaria sem schema.`);
  }
  if (Object.keys(dashboardAssets).length === 0) {
    console.warn(`⚠️  ${DASHBOARD_DIST} não existe ou está vazio — rode "bun run build" em dashboard/ antes (SPA não vai ficar embutida).`);
  }

  const body = `// GERADO por scripts/generate-embedded-assets.ts em ${new Date().toISOString()} — NÃO editar à mão.
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
    `✅ ${OUT_FILE}: ${Object.keys(migrations).length} migration(s), ${Object.keys(souls).length} SOUL(s), ${
      Object.keys(dashboardAssets).length
    } asset(s) da SPA.`
  );
}

main();
