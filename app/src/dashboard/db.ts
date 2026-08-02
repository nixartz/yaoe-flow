// Conexão SQLite da dashboard — hoje um alias fino da conexão única da
// aplicação (src/db, Drizzle + migrations versionadas). O contrato `db()`
// (bun:sqlite cru) é mantido porque store.ts/query.ts/retention.ts usam
// prepared statements e a mini-linguagem da tela de Logs (queryLang.ts)
// compila pra SQL cru — decisão deliberada do blueprint (§5.1): migrations no
// Drizzle, queries de telemetria continuam SQL.
import type { Database } from "bun:sqlite";
import { appDb } from "../db";

/** Conexão lazy — só abre (e migra) quando algo do banco for de fato usado. */
export function db(): Database {
  return appDb().sqlite;
}
