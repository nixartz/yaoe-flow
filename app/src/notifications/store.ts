// Persistência das notificações (§8.1): canais (webhook/slack/telegram) +
// regras canal×evento. configJson (URL/token/chat_id) é cifrado at-rest —
// mesma família de segredos do resto da Fase 0/1 (db/secrets.ts).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appDb } from "../db";
import { notificationChannels, notificationRules } from "../db/schema";
import { decryptSecret, encryptSecret, isEncrypted } from "../db/secrets";

export type ChannelType = "webhook" | "slack" | "telegram";
export type NotificationEvent =
  | "issue_blocked"
  | "issue_pending_merge"
  | "run_failed"
  | "circuit_breaker"
  | "budget_exceeded"
  | "reclaim_timeout"
  | "harness_quota_exceeded";

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  "issue_blocked",
  "issue_pending_merge",
  "run_failed",
  "circuit_breaker",
  "budget_exceeded",
  "reclaim_timeout",
  "harness_quota_exceeded",
];

export type ChannelRow = typeof notificationChannels.$inferSelect;

export class NotificationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Campos de configJson que carregam credencial — cifrados na escrita, nunca
// devolvidos em claro pela API (mesmo padrão de db/agents.ts).
const SECRET_CONFIG_FIELDS = new Set(["url", "token", "botToken"]);

function encryptConfigFields(configJson: string): string {
  try {
    const parsed = JSON.parse(configJson) as Record<string, unknown>;
    for (const field of SECRET_CONFIG_FIELDS) {
      const v = parsed[field];
      if (typeof v === "string" && v && !isEncrypted(v)) parsed[field] = encryptSecret(v);
    }
    return JSON.stringify(parsed);
  } catch {
    throw new NotificationError("configJson inválido");
  }
}

export function decryptConfig(row: ChannelRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.configJson) as Record<string, unknown>;
    for (const field of SECRET_CONFIG_FIELDS) {
      const v = parsed[field];
      if (typeof v === "string" && isEncrypted(v)) parsed[field] = decryptSecret(v);
    }
    return parsed;
  } catch {
    return {};
  }
}

/** Config mascarada pra API (nunca devolve credencial em claro). */
export function maskedConfig(row: ChannelRow): Record<string, unknown> {
  const decrypted = decryptConfig(row);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decrypted)) {
    if (SECRET_CONFIG_FIELDS.has(k) && typeof v === "string" && v) {
      out[k] = v.length < 12 ? "***" : `${v.slice(0, 4)}…${v.slice(-4)}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function listChannels(): ChannelRow[] {
  return appDb().orm.select().from(notificationChannels).all();
}

export function getChannel(id: string): ChannelRow | undefined {
  return appDb().orm.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
}

export interface CreateChannelInput {
  type: ChannelType;
  name: string;
  configJson: string;
}

export function createChannel(input: CreateChannelInput): ChannelRow {
  if (!["webhook", "slack", "telegram"].includes(input.type)) throw new NotificationError("type inválido");
  if (!input.name?.trim()) throw new NotificationError("nome é obrigatório");
  const now = Date.now();
  const row: typeof notificationChannels.$inferInsert = {
    id: randomUUID(),
    type: input.type,
    name: input.name.trim(),
    configJson: encryptConfigFields(input.configJson),
    createdAt: now,
    updatedAt: now,
  };
  appDb().orm.insert(notificationChannels).values(row).run();
  return getChannel(row.id)!;
}

export function updateChannel(id: string, input: { name?: string; configJson?: string }): ChannelRow {
  const existing = getChannel(id);
  if (!existing) throw new NotificationError("canal não encontrado", 404);
  const set: Partial<typeof notificationChannels.$inferInsert> = { updatedAt: Date.now() };
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.configJson !== undefined) set.configJson = encryptConfigFields(input.configJson);
  appDb().orm.update(notificationChannels).set(set).where(eq(notificationChannels.id, id)).run();
  return getChannel(id)!;
}

export function deleteChannel(id: string): void {
  appDb().orm.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();
}

export function listRules(channelId: string): (typeof notificationRules.$inferSelect)[] {
  return appDb().orm.select().from(notificationRules).where(eq(notificationRules.channelId, channelId)).all();
}

export function setRule(channelId: string, event: NotificationEvent, enabled: boolean): void {
  if (!NOTIFICATION_EVENTS.includes(event)) throw new NotificationError("evento desconhecido");
  const { orm } = appDb();
  orm
    .insert(notificationRules)
    .values({ id: randomUUID(), channelId, event, enabled: enabled ? 1 : 0 })
    .onConflictDoUpdate({ target: [notificationRules.channelId, notificationRules.event], set: { enabled: enabled ? 1 : 0 } })
    .run();
}

/** Canais habilitados pra um evento, com config já decifrada (uso interno de send.ts). */
export function channelsForEvent(event: NotificationEvent): Array<{ channel: ChannelRow; config: Record<string, unknown> }> {
  const { sqlite } = appDb();
  const rows = sqlite
    .query(
      `SELECT c.* FROM notification_channels c
       JOIN notification_rules r ON r.channel_id = c.id
       WHERE r.event = $event AND r.enabled = 1`
    )
    .all({ $event: event }) as ChannelRow[];
  return rows.map((channel) => ({ channel, config: decryptConfig(channel) }));
}
