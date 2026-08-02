// §9.3: baseline em banco VAZIO e adoção de banco LEGADO (schema antigo +
// dados) sem perda — mesma verificação do critério de aceite §5.8.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openAppDb } from "../src/db";
import { TEST_TMP_DIR } from "./setup";

const EXPECTED_TABLES = [
  "runs",
  "run_events",
  "run_generations",
  "webhook_events",
  "log_lines",
  "users",
  "settings",
  "linear_connections",
];

function tableNames(sqlite: Database): string[] {
  return (sqlite.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
    (t) => t.name
  );
}

describe("migrations (Drizzle baseline)", () => {
  test("banco vazio: baseline cria todas as tabelas", () => {
    const { sqlite } = openAppDb(join(TEST_TMP_DIR, "fresh.sqlite"));
    const tables = tableNames(sqlite);
    for (const t of EXPECTED_TABLES) expect(tables).toContain(t);
  });

  test("é idempotente: reabrir o mesmo banco não falha nem duplica", () => {
    const path = join(TEST_TMP_DIR, "idempotent.sqlite");
    openAppDb(path).sqlite.close();
    const { sqlite } = openAppDb(path);
    expect(tableNames(sqlite).filter((t) => t === "runs")).toHaveLength(1);
  });

  test("banco legado (schema antigo, sem colunas novas) é adotado sem perda", () => {
    const path = join(TEST_TMP_DIR, "legacy.sqlite");
    const legacy = new Database(path, { create: true });
    // DDL da PRIMEIRA versão da dashboard: runs sem cost_input_usd/session ids.
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, backend TEXT NOT NULL, operation TEXT NOT NULL, role TEXT NOT NULL,
        issue_id TEXT, issue_identifier TEXT, mode TEXT, status TEXT NOT NULL, provider TEXT, model TEXT,
        stop_reason TEXT, error_message TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL,
        started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER
      );
      CREATE TABLE run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT,
        tool_name TEXT, tool_status TEXT, payload_json TEXT NOT NULL
      );
      INSERT INTO runs (id, backend, operation, role, status, started_at) VALUES
        ('r1', 'goose', 'implement', 'worker', 'completed', 1000),
        ('r2', 'hermes', 'refine', 'pmo', 'failed', 2000);
      INSERT INTO run_events (run_id, seq, ts, kind, payload_json) VALUES
        ('r1', 1, 1000, 'tool_call', '{}'), ('r1', 2, 1100, 'message_chunk', '{}');
    `);
    legacy.close();

    const { sqlite } = openAppDb(path);
    // dados preservados 1:1
    expect((sqlite.query(`SELECT COUNT(*) c FROM runs`).get() as { c: number }).c).toBe(2);
    expect((sqlite.query(`SELECT COUNT(*) c FROM run_events`).get() as { c: number }).c).toBe(2);
    // colunas novas adicionadas + tabelas novas criadas
    const cols = (sqlite.query(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name);
    for (const col of ["cost_input_usd", "cost_output_usd", "openrouter_session_id", "goose_session_id", "usage_source"]) {
      expect(cols).toContain(col);
    }
    for (const t of EXPECTED_TABLES) expect(tableNames(sqlite)).toContain(t);
  });
});
