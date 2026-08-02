// Parser de uma mini-linguagem de query inspirada no CloudWatch Logs Insights —
// comandos separados por "|", sem estado entre si:
//   fields <campo>, <campo>, ...       — escolhe/ordena as colunas mostradas
//   filter <campo> <op> <valor> [and <campo> <op> <valor> ...]
//                                      — op ∈ = != > >= < <= like; várias
//                                        linhas "filter" (ou "and" na mesma
//                                        linha) sempre se combinam em AND —
//                                        sem suporte a "or" nesta v1
//   sort <campo> [asc|desc], ...       — direção default: desc (visão de logs)
//   limit <n>
//
// Só alimenta QuerySpec (fields/filters/sort/limit) — from/to (janela de
// tempo) e page continuam vindo de fora, como controles próprios da UI, do
// jeito que o CloudWatch também separa o seletor de tempo da query box.
import type { FilterOp, QueryFilter, QuerySort } from "./query";

const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Split que ignora delimitadores dentro de aspas (simples ou duplas) — sem isso,
// um valor legítimo como `filter msg like "connect and retry"` era partido no
// meio pelo split de "and" (e `|` dentro de aspas partia o statement inteiro).
// `matchDelim` devolve o comprimento do delimitador na posição i (0 = não é).
function splitOutsideQuotes(text: string, matchDelim: (text: string, i: number) => number): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const len = matchDelim(text, i);
    if (len > 0) {
      parts.push(current);
      current = "";
      i += len - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const isPipe = (text: string, i: number): number => (text[i] === "|" ? 1 : 0);

// "and" como palavra inteira (case-insensitive), fora de aspas.
const isAndWord = (text: string, i: number): number => {
  if (text.slice(i, i + 3).toLowerCase() !== "and") return 0;
  const before = i === 0 ? "" : text[i - 1];
  const after = text[i + 3] ?? "";
  const isWordChar = (c: string) => /[a-zA-Z0-9_]/.test(c);
  if (before && isWordChar(before)) return 0;
  if (after && isWordChar(after)) return 0;
  return 3;
};

const OP_MAP: Record<string, FilterOp> = {
  "=": "eq",
  "!=": "neq",
  ">=": "gte",
  "<=": "lte",
  ">": "gt",
  "<": "lt",
  like: "contains",
};
// Ordem importa: operadores de 2 chars precisam vir antes dos de 1 char na alternação.
const OP_TOKEN_SRC = "(!=|>=|<=|=|>|<|like)";

export interface ParsedQuery {
  fields?: string[];
  filters?: QueryFilter[];
  sort?: QuerySort[];
  limit?: number;
}

function parseValue(raw: string): string | number {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\(['"])/g, "$1");
  }
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

function parseFilterExpr(expr: string): QueryFilter {
  const m = expr.trim().match(new RegExp(`^([a-zA-Z_][a-zA-Z0-9_]*)\\s*${OP_TOKEN_SRC}\\s*(.+)$`, "i"));
  if (!m) throw new Error(`filtro inválido: "${expr.trim()}" (esperado: campo op valor)`);
  const [, field, opToken, valueRaw] = m;
  return { field, op: OP_MAP[opToken.toLowerCase()], value: parseValue(valueRaw) };
}

function parseFields(arg: string): string[] {
  const fields = arg
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (fields.length === 0) throw new Error('"fields" precisa de ao menos uma coluna');
  for (const f of fields) {
    if (!FIELD_RE.test(f)) throw new Error(`nome de campo inválido em "fields": "${f}"`);
  }
  return fields;
}

function parseFilter(arg: string): QueryFilter[] {
  return splitOutsideQuotes(arg, isAndWord)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map(parseFilterExpr);
}

function parseSort(arg: string): QuerySort[] {
  return arg.split(",").map((chunk) => {
    const m = chunk.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(asc|desc))?$/i);
    if (!m) throw new Error(`ordenação inválida: "${chunk.trim()}" (esperado: campo [asc|desc])`);
    return { field: m[1], dir: (m[2]?.toLowerCase() as "asc" | "desc") ?? "desc" };
  });
}

function parseLimit(arg: string): number {
  const n = Number(arg.trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`"limit" precisa de um inteiro positivo, recebeu: "${arg.trim()}"`);
  return n;
}

export function parseQueryString(raw: string): ParsedQuery {
  const text = raw.replace(/\n/g, " ").trim();
  if (!text) return {};

  const result: ParsedQuery = {};
  for (const stmt of splitOutsideQuotes(text, isPipe)) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.search(/\s/);
    const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

    if (cmd === "fields") result.fields = parseFields(arg);
    else if (cmd === "filter") result.filters = [...(result.filters ?? []), ...parseFilter(arg)];
    else if (cmd === "sort") result.sort = parseSort(arg);
    else if (cmd === "limit") result.limit = parseLimit(arg);
    else throw new Error(`comando desconhecido: "${cmd}" (use fields, filter, sort ou limit)`);
  }
  return result;
}
