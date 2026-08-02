// Conexão única do banco da aplicação (bun:sqlite + Drizzle ORM) — §5.1.
// O banco deixou de ser só telemetria da dashboard e passou a guardar
// configuração e negócio (settings/users; agents na Fase 1), então o schema é
// gerido por MIGRATIONS VERSIONADAS em app/drizzle/ (drizzle-orm migrator).
//
// A migration baseline usa IF NOT EXISTS e ADOTA um banco pré-existente sem
// perda (critério de aceite §5.8). Bancos criados por versões antigas do
// serviço (schema.sql + ALTERs ad-hoc) são normalizados ANTES da baseline
// rodar — ver normalizeLegacyRuns.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { bootstrap } from "../config/bootstrap";
import { EMBEDDED_MIGRATIONS, EMBEDDED_MIGRATIONS_JOURNAL } from "../embedded-assets.generated";
import { assertEncryptionKey } from "./secrets";
import * as schema from "./schema";

const DISK_MIGRATIONS_FOLDER = resolve(import.meta.dir, "..", "..", "drizzle");

let embeddedMigrationsFolder: string | null = null;

/**
 * Dev/Docker: migrations vivem em disco, relativas ao source (como sempre —
 * ver AGENTS.md). Binário compilado (docs/daemon-binary.md §7): o pipeline de
 * release embute as migrations como TEXTO no bundle (scripts/generate-embedded-assets.ts);
 * o migrator do drizzle só sabe ler de um DIRETÓRIO real, então extraímos uma
 * vez por processo pra um tmpdir e apontamos pra lá.
 */
function migrationsFolder(): string {
  if (Object.keys(EMBEDDED_MIGRATIONS).length === 0 || !EMBEDDED_MIGRATIONS_JOURNAL) {
    return DISK_MIGRATIONS_FOLDER;
  }
  if (!embeddedMigrationsFolder) {
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-migrations-"));
    mkdirSync(join(dir, "meta"), { recursive: true });
    writeFileSync(join(dir, "meta", "_journal.json"), EMBEDDED_MIGRATIONS_JOURNAL);
    for (const [tag, sql] of Object.entries(EMBEDDED_MIGRATIONS)) writeFileSync(join(dir, `${tag}.sql`), sql);
    embeddedMigrationsFolder = dir;
  }
  return embeddedMigrationsFolder;
}

export interface AppDb {
  sqlite: Database;
  orm: BunSQLiteDatabase<typeof schema>;
}

/**
 * Colunas de `runs` adicionadas por ALTER TABLE em versões antigas (o extinto
 * migrate() de dashboard/db.ts). Um banco antigo pode não tê-las — e a baseline
 * (CREATE TABLE IF NOT EXISTS) não adiciona coluna em tabela existente.
 */
const LEGACY_RUN_COLUMNS: Array<[string, string]> = [
  ["cost_input_usd", "cost_input_usd REAL"],
  ["cost_output_usd", "cost_output_usd REAL"],
  ["openrouter_session_id", "openrouter_session_id TEXT"],
  ["goose_session_id", "goose_session_id TEXT"],
  ["usage_source", "usage_source TEXT"],
  ["usage_reconciled_at", "usage_reconciled_at INTEGER"],
];

function normalizeLegacyRuns(database: Database): void {
  const hasRuns = database
    .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
    .get();
  if (!hasRuns) return;
  const cols = new Set(
    (database.query(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name)
  );
  for (const [name, ddl] of LEGACY_RUN_COLUMNS) {
    if (!cols.has(name)) database.exec(`ALTER TABLE runs ADD COLUMN ${ddl}`);
  }
}

/**
 * Papel canônico `senior-engineer` → `dev`. O CHECK do SQLite não dá pra
 * ALTER — precisa rebuild. Não cabe numa migration Drizzle com
 * statement-breakpoint (PRAGMA foreign_keys=OFF não sobrevive ao próximo
 * statement isolado; o DROP falha com FK). Roda no mesmo `exec()` multi-
 * statement da conexão aberta, uma vez, quando o DDL ainda cita o nome antigo.
 */
function normalizeAgentRoleDev(database: Database): void {
  const row = database
    .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'`)
    .get() as { sql: string } | null;
  if (!row?.sql || !row.sql.includes("senior-engineer")) return;

  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE agents_new (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('pmo', 'dev', 'reviewer', 'orchestrator')),
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      active_version_id TEXT,
      active_harness_id TEXT NOT NULL DEFAULT 'goose',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO agents_new (id, role, name, description, is_active, active_version_id, active_harness_id, created_at, updated_at)
    SELECT
      id,
      CASE WHEN role = 'senior-engineer' THEN 'dev' ELSE role END,
      CASE WHEN name = 'senior-engineer' THEN 'dev' ELSE name END,
      description,
      is_active,
      active_version_id,
      active_harness_id,
      created_at,
      updated_at
    FROM agents;
    DROP TABLE agents;
    ALTER TABLE agents_new RENAME TO agents;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_one_active_per_role ON agents(role) WHERE is_active = 1;
    PRAGMA foreign_keys = ON;
  `);
}


/**
 * Abre (e migra) um banco num path arbitrário — usada pelo singleton e pelos
 * testes de migration (banco vazio E cópia de banco real).
 */
export function openAppDb(path: string): AppDb {
  // Nada persiste/lê segredo sem a chave — e o erro no boot precisa ser o
  // instrutivo de secrets.ts, não um crash tardio no meio de um request.
  assertEncryptionKey();

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  normalizeLegacyRuns(sqlite);
  const orm = drizzle(sqlite, { schema });
  migrate(orm, { migrationsFolder: migrationsFolder() });
  // Depois das migrations: o CHECK de role ainda pode ser o da 0001 até este
  // rebuild (ver comentário em normalizeAgentRoleDev).
  normalizeAgentRoleDev(sqlite);
  return { sqlite, orm };
}

let instance: AppDb | null = null;

/** Conexão singleton (lazy) no path configurado (bootstrap DASHBOARD_DB_PATH). */
export function appDb(): AppDb {
  if (!instance) instance = openAppDb(bootstrap.dashboardDbPath);
  return instance;
}
