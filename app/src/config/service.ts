// Config service (§5.4): resolve cada setting com precedência ENV > banco >
// default, com cache invalidado em escrita — é o que torna a config HOT (o
// tick/dispatch lê pelo serviço a cada execução, então mudar MAX_DEV_WORKERS pela
// UI muda o comportamento sem restart).
//
// Campo com ENV setada: a ENV VALE e a UI bloqueia a edição (badge "definido
// via ENV") — mecanismo deliberado pra travar campos críticos por ambiente.
// No primeiro boot, os valores vindos do ambiente são SEMEADOS no banco — o
// que permite depois remover a ENV e manter o valor (D8).
import { eq } from "drizzle-orm";
import { appDb } from "../db";
import { settings } from "../db/schema";
import { decryptSecret, encryptSecret } from "../db/secrets";
import { SETTINGS_REGISTRY, settingMeta, isEditable, type SettingMeta } from "./registry";

export type SettingSource = "env" | "db" | "default";

export interface ResolvedSetting {
  meta: SettingMeta;
  /** Valor efetivo, como string (cru). Segredos NÃO são mascarados aqui — mascarar é papel da API. */
  raw: string;
  source: SettingSource;
}

const SEED_SENTINEL = "__meta.seeded_from_env";

// cache por key do valor resolvido; invalidado em escrita (e nunca usado pros
// bootstrap, que são lidos direto de env em config/bootstrap.ts).
const cache = new Map<string, ResolvedSetting>();

type ChangeListener = (key: string, raw: string) => void;
const listeners: ChangeListener[] = [];

/** Registra callback disparado quando um setting muda pela UI (ex.: LOG_LEVEL → pino). */
export function onSettingChange(listener: ChangeListener): void {
  listeners.push(listener);
}

let seeded = false;

function ensureSeeded(): void {
  if (seeded) return;
  const { orm } = appDb();
  const sentinel = orm.select().from(settings).where(eq(settings.key, SEED_SENTINEL)).get();
  if (!sentinel) {
    const now = Date.now();
    const rows: (typeof settings.$inferInsert)[] = [];
    for (const meta of SETTINGS_REGISTRY) {
      if (!isEditable(meta)) continue;
      const envValue = process.env[meta.key];
      if (envValue === undefined) continue;
      rows.push({
        key: meta.key,
        value: meta.secret ? encryptSecret(envValue) : envValue,
        updatedAt: now,
        updatedBy: null,
      });
    }
    rows.push({ key: SEED_SENTINEL, value: new Date(now).toISOString(), updatedAt: now, updatedBy: null });
    for (const row of rows) {
      orm.insert(settings).values(row).onConflictDoNothing().run();
    }
  }
  seeded = true;
}

function readDbValueByKey(key: string, secret: boolean): string | undefined {
  ensureSeeded();
  const { orm } = appDb();
  const row = orm.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;
  return secret ? decryptSecret(row.value) : row.value;
}

function readDbValue(meta: SettingMeta): string | undefined {
  return readDbValueByKey(meta.key, Boolean(meta.secret));
}

function envValueFor(meta: SettingMeta): string | undefined {
  return process.env[meta.key];
}

export function resolveSetting(key: string): ResolvedSetting {
  const cached = cache.get(key);
  if (cached) return cached;

  const meta = settingMeta(key);
  if (!meta) throw new Error(`setting desconhecido: ${key}`);

  let resolved: ResolvedSetting;
  const envValue = envValueFor(meta);
  if (envValue !== undefined) {
    resolved = { meta, raw: envValue, source: "env" };
  } else {
    const dbValue = meta.scope === "bootstrap" ? undefined : readDbValue(meta);
    resolved =
      dbValue !== undefined
        ? { meta, raw: dbValue, source: "db" }
        : { meta, raw: String(meta.default), source: "default" };
  }
  cache.set(key, resolved);
  return resolved;
}

// ── Getters tipados (usados pelos getters de config.ts) ──

export function str(key: string): string {
  return resolveSetting(key).raw;
}

export function num(key: string): number {
  return Number(resolveSetting(key).raw);
}

export function bool(key: string): boolean {
  return resolveSetting(key).raw === "true";
}

// ── Escrita (API da tela Config) ──

export class SettingWriteError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function validateValue(meta: SettingMeta, value: string): void {
  switch (meta.type) {
    case "number":
    case "duration_ms": {
      if (!Number.isFinite(Number(value))) throw new SettingWriteError(`${meta.key}: valor numérico inválido`);
      break;
    }
    case "boolean": {
      if (value !== "true" && value !== "false") throw new SettingWriteError(`${meta.key}: use true ou false`);
      break;
    }
    case "enum": {
      if (!meta.enumValues?.includes(value))
        throw new SettingWriteError(`${meta.key}: valor deve ser um de ${meta.enumValues?.join(", ")}`);
      break;
    }
    case "json": {
      if (value.trim()) {
        try {
          JSON.parse(value);
        } catch {
          throw new SettingWriteError(`${meta.key}: JSON inválido`);
        }
      }
      break;
    }
  }
  const custom = meta.validate?.(value);
  if (custom) throw new SettingWriteError(`${meta.key}: ${custom}`);
}

export function setSetting(key: string, value: string, updatedBy: string | null): void {
  const meta = settingMeta(key);
  if (!meta) throw new SettingWriteError(`setting desconhecido: ${key}`, 404);
  if (!isEditable(meta)) throw new SettingWriteError(`${key} não é editável pela dashboard (escopo ${meta.scope})`, 403);
  if (process.env[key] !== undefined)
    throw new SettingWriteError(`${key} está definido via ENV — remova a variável de ambiente pra editar pelo banco`, 409);
  validateValue(meta, value);

  const { orm } = appDb();
  const stored = meta.secret ? encryptSecret(value) : value;
  orm
    .insert(settings)
    .values({ key, value: stored, updatedAt: Date.now(), updatedBy })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: Date.now(), updatedBy } })
    .run();
  cache.delete(key);
  for (const l of listeners) l(key, value);
}

/** Remove o valor do banco (volta pro default — ou pra ENV, se existir). */
export function resetSetting(key: string, _updatedBy: string | null): void {
  const meta = settingMeta(key);
  if (!meta) throw new SettingWriteError(`setting desconhecido: ${key}`, 404);
  if (!isEditable(meta)) throw new SettingWriteError(`${key} não é editável pela dashboard (escopo ${meta.scope})`, 403);
  const { orm } = appDb();
  orm.delete(settings).where(eq(settings.key, key)).run();
  cache.delete(key);
  for (const l of listeners) l(key, resolveSetting(key).raw);
}

/** Limpa o cache inteiro (testes / pós-migração). */
export function invalidateSettingsCache(): void {
  cache.clear();
}

// ── Relatório pra tela Config (segredos mascarados; nunca há "ler de volta") ──

export interface SettingReportEntry {
  key: string;
  group: string;
  type: SettingMeta["type"];
  enumValues?: string[];
  description: string;
  secret: boolean;
  scope: SettingMeta["scope"];
  requiresRestart: boolean;
  editable: boolean;
  linearValidatable?: "state" | "label";
  value: string;
  defaultValue: string;
  source: SettingSource;
}

export interface SettingReportGroup {
  group: string;
  entries: SettingReportEntry[];
}

function maskValue(v: string): string {
  if (!v) return "";
  if (v.length < 20) return `*** (${v.length} chars)`;
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
}

function sanitizeUrl(v: string): string {
  return v.replace(/\/\/([^/@:]+):([^/@]+)@/, "//$1:***@");
}

export function settingsReport(): SettingReportGroup[] {
  const groups: SettingReportGroup[] = [];
  let current: SettingReportGroup | null = null;
  for (const meta of SETTINGS_REGISTRY) {
    const resolved = resolveSetting(meta.key);
    const display = meta.secret ? maskValue(resolved.raw) : meta.url ? sanitizeUrl(resolved.raw) : resolved.raw;
    const entry: SettingReportEntry = {
      key: meta.key,
      group: meta.group,
      type: meta.type,
      enumValues: meta.enumValues,
      description: meta.description,
      secret: Boolean(meta.secret),
      scope: meta.scope,
      requiresRestart: Boolean(meta.requiresRestart),
      editable: isEditable(meta) && process.env[meta.key] === undefined,
      linearValidatable: meta.linearValidatable,
      value: display,
      defaultValue: meta.secret ? "" : String(meta.default),
      source: resolved.source,
    };
    if (!current || current.group !== meta.group) {
      current = { group: meta.group, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}
