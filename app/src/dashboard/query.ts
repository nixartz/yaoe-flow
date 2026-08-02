// Motor de query genérico e reutilizável (fields/filter/busca livre/sort/limit/
// page) sobre as tabelas "consultáveis" da dashboard (logs hoje; runs/webhooks já
// mapeadas, pra reaproveitar a mesma UI/API se fizer sentido depois).
//
// Aceita a query de duas formas, que podem ser combinadas: um objeto estruturado
// (fields/filters/sort/limit já separados) e/ou uma string na mini-linguagem
// estilo CloudWatch Insights (`query`, ver queryLang.ts) — quando `query` vem
// preenchida, ela é parseada e sobrepõe fields/filters/sort/limit estruturados.
// from/to (janela de tempo) e page continuam sempre fora da linguagem, como
// controles próprios da UI.
//
// Dois tipos de campo:
//  • coluna SQL de verdade (whitelist fixa por entidade — nunca interpolada crua,
//    só aceita se bater exatamente com a whitelist);
//  • campo "virtual" dentro do blob JSON da entidade (ex.: `issueId` dentro de
//    `fields_json` de um log) — extraído via `json_extract`, com o NOME do campo
//    sempre indo como valor de parâmetro bindado (nunca concatenado no SQL) e
//    validado por regex (só identificador simples) antes de virar alias.
import { db } from "./db";
import { parseQueryString } from "./queryLang";

export type EntityName = "log_lines" | "runs" | "webhook_events";

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";

export interface QueryFilter {
  field: string;
  op: FilterOp;
  value: string | number;
}

export interface QuerySort {
  field: string;
  dir: "asc" | "desc";
}

export interface QuerySpec {
  fields?: string[];
  filters?: QueryFilter[];
  // Mini-linguagem estilo CloudWatch Insights (ver queryLang.ts) — se presente,
  // parseada e sobrepõe fields/filters/sort/limit estruturados acima.
  query?: string;
  q?: string; // busca livre nas colunas de texto "buscáveis" da entidade
  from?: number; // epoch ms, inclusive — aplicado na coluna de tempo da entidade
  to?: number;
  sort?: QuerySort[];
  limit?: number;
  page?: number;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  fields: string[];
}

interface EntityDef {
  table: string;
  timeColumn: string;
  columns: string[];
  /** Coluna com o blob JSON de onde campos "virtuais" (fora da whitelist) são extraídos. */
  jsonColumn?: string;
  defaultFields: string[];
  searchColumns: string[];
  defaultSort: QuerySort;
}

const ENTITIES: Record<EntityName, EntityDef> = {
  log_lines: {
    table: "log_lines",
    timeColumn: "ts",
    columns: ["id", "ts", "level", "feature", "msg", "fields_json", "raw"],
    jsonColumn: "fields_json",
    defaultFields: ["ts", "level", "feature", "msg"],
    searchColumns: ["msg", "raw"],
    defaultSort: { field: "ts", dir: "desc" },
  },
  runs: {
    table: "runs",
    timeColumn: "started_at",
    columns: [
      "id",
      "backend",
      "operation",
      "role",
      "issue_id",
      "issue_identifier",
      "mode",
      "status",
      "provider",
      "model",
      "stop_reason",
      "error_message",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_usd",
      "cost_input_usd",
      "cost_output_usd",
      "openrouter_session_id",
      "goose_session_id",
      "usage_source",
      "usage_reconciled_at",
      "started_at",
      "ended_at",
      "duration_ms",
    ],
    defaultFields: ["started_at", "role", "operation", "status", "issue_identifier", "duration_ms"],
    searchColumns: ["operation", "role", "issue_identifier", "error_message"],
    defaultSort: { field: "started_at", dir: "desc" },
  },
  webhook_events: {
    table: "webhook_events",
    timeColumn: "received_at",
    columns: [
      "id",
      "received_at",
      "entity_type",
      "action",
      "issue_id",
      "issue_identifier",
      "issue_title",
      "team_id",
      "team_key",
      "team_name",
      "project_id",
      "project_name",
      "milestone_id",
      "milestone_name",
      "actor_name",
      "actor_type",
      "summary",
      "triggered_scheduler",
      "raw_json",
    ],
    jsonColumn: "raw_json",
    defaultFields: ["received_at", "entity_type", "issue_identifier", "summary", "actor_name"],
    searchColumns: ["summary", "issue_title", "issue_identifier"],
    defaultSort: { field: "received_at", dir: "desc" },
  },
};

export const ENTITY_COLUMNS: Record<EntityName, string[]> = Object.fromEntries(
  Object.entries(ENTITIES).map(([k, v]) => [k, v.columns])
) as Record<EntityName, string[]>;

const OP_SQL: Record<FilterOp, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "LIKE",
};

const SAFE_FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Gera chaves de parâmetro únicas ($p0, $p1, ...) por chamada de runQuery. */
function makeParamKeyGen(): () => string {
  let n = 0;
  return () => `$p${n++}`;
}

/**
 * Resolve um nome de campo pro trecho de SQL que o representa: coluna direta se
 * estiver na whitelist, ou `json_extract(<jsonColumn>, '$.' || $key)` se for um
 * campo virtual dentro do blob JSON da entidade. Em ambos os casos o valor
 * retornado é seguro pra colar no SQL — nunca inclui o `field` bruto do usuário.
 */
function resolveField(
  def: EntityDef,
  field: string,
  params: Record<string, string | number>,
  nextKey: () => string
): string {
  if (def.columns.includes(field)) return field;
  if (def.jsonColumn && SAFE_FIELD_NAME.test(field)) {
    const key = nextKey();
    params[key] = field;
    return `json_extract(${def.jsonColumn}, '$.' || ${key})`;
  }
  throw new Error(`campo desconhecido: "${field}"`);
}

export function runQuery(entity: EntityName, spec: QuerySpec): QueryResult {
  const def = ENTITIES[entity];
  if (!def) throw new Error(`entidade desconhecida: "${entity}"`);

  const parsed = spec.query?.trim() ? parseQueryString(spec.query) : {};
  const merged: QuerySpec = { ...spec, ...parsed };

  const nextKey = makeParamKeyGen();
  const params: Record<string, string | number> = {};

  // Campos "de exibição" (o que o frontend deve renderizar como coluna) vs.
  // campos extras sempre incluídos no SELECT (id pra keying, timeColumn pro
  // histograma — que quebrava se `fields` não pedisse `ts` —, jsonColumn pro
  // detalhe "JSON completo") mesmo que não estejam em `fields` — sem aparecer
  // na lista `fields` devolvida, que é só o que foi pedido/mostrado.
  const fieldNames = merged.fields?.length ? merged.fields : def.defaultFields;
  const extraFields = ["id", def.timeColumn, ...(def.jsonColumn ? [def.jsonColumn] : [])].filter(
    (f) => !fieldNames.includes(f)
  );
  const selectExprs = [...fieldNames, ...extraFields].map((f) => `${resolveField(def, f, params, nextKey)} AS "${f}"`);

  const clauses: string[] = [];

  for (const filter of merged.filters ?? []) {
    const expr = resolveField(def, filter.field, params, nextKey);
    const op = OP_SQL[filter.op];
    if (!op) throw new Error(`operador desconhecido: "${filter.op}"`);
    const key = nextKey();
    clauses.push(`${expr} ${op} ${key}`);
    params[key] = filter.op === "contains" ? `%${filter.value}%` : filter.value;
  }

  if (merged.q) {
    const key = nextKey();
    params[key] = `%${merged.q}%`;
    clauses.push(`(${def.searchColumns.map((c) => `${c} LIKE ${key}`).join(" OR ")})`);
  }

  if (merged.from !== undefined) {
    const key = nextKey();
    params[key] = merged.from;
    clauses.push(`${def.timeColumn} >= ${key}`);
  }
  if (merged.to !== undefined) {
    const key = nextKey();
    params[key] = merged.to;
    clauses.push(`${def.timeColumn} <= ${key}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const sortSpecs = merged.sort?.length ? merged.sort : [def.defaultSort];
  const orderBy = sortSpecs
    .map((s) => `${resolveField(def, s.field, params, nextKey)} ${s.dir === "asc" ? "ASC" : "DESC"}`)
    .join(", ");

  const pageSize = Math.min(1000, Math.max(1, merged.limit ?? 50));
  const page = Math.max(1, merged.page ?? 1);

  const limitKey = nextKey();
  const offsetKey = nextKey();
  params[limitKey] = pageSize;
  params[offsetKey] = (page - 1) * pageSize;

  const rows = db()
    .query(`SELECT ${selectExprs.join(", ")} FROM ${def.table} ${where} ORDER BY ${orderBy} LIMIT ${limitKey} OFFSET ${offsetKey}`)
    .all(params) as Record<string, unknown>[];

  // total: mesmo WHERE, sem limit/offset/order — reusa os params exceto os dois últimos.
  const { [limitKey]: _l, [offsetKey]: _o, ...countParams } = params;
  const total = (db().query(`SELECT COUNT(*) as c FROM ${def.table} ${where}`).get(countParams) as { c: number }).c;

  return { rows, total, page, pageSize, fields: fieldNames };
}
