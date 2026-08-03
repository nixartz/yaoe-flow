// Entrega de notificações (§8.1): fila leve em memória com retry exponencial
// simples (3 tentativas); falha de canal loga e NUNCA afeta o pipeline —
// mesma filosofia "best-effort" do resto da dashboard (ver store.ts safe()).
import { log, errFields } from "../logger";
import type { ChannelRow } from "./store";

export interface NotificationPayload {
  title: string;
  /** Corpo em texto simples — cada transporte formata a seu jeito. */
  body: string;
  /** Link pro run/issue na dashboard ou no Linear. */
  links?: Array<{ label: string; url: string }>;
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

async function sendWebhook(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
  const url = String(config.url ?? "");
  if (!url) throw new Error("webhook: config.url ausente");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
}

async function sendSlack(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
  const url = String(config.url ?? "");
  if (!url) throw new Error("slack: config.url (incoming webhook) ausente");
  const links = (payload.links ?? []).map((l) => `<${l.url}|${l.label}>`).join(" · ");
  const text = `*${payload.title}*\n${payload.body}${links ? `\n${links}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`slack ${res.status}: ${await res.text()}`);
}

async function sendTelegram(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
  const botToken = String(config.botToken ?? "");
  const chatId = String(config.chatId ?? "");
  if (!botToken || !chatId) throw new Error("telegram: config.botToken/chatId ausente");
  const links = (payload.links ?? []).map((l) => `${l.label}: ${l.url}`).join("\n");
  const text = `${payload.title}\n${payload.body}${links ? `\n${links}` : ""}`;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${await res.text()}`);
}

async function deliverOnce(channel: ChannelRow, config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
  switch (channel.type) {
    case "webhook":
      return sendWebhook(config, payload);
    case "slack":
      return sendSlack(config, payload);
    case "telegram":
      return sendTelegram(config, payload);
    default:
      throw new Error(`tipo de canal desconhecido: ${channel.type}`);
  }
}

/** Entrega com retry exponencial (3 tentativas) — nunca lança; loga e retorna. */
export async function deliver(channel: ChannelRow, config: Record<string, unknown>, payload: NotificationPayload): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await deliverOnce(channel, config, payload);
      return true;
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        log.dashboard.warn(
          { channel: channel.name, type: channel.type, attempt, ...errFields(e) },
          "notification delivery failed (best-effort — pipeline unaffected)"
        );
        return false;
      }
      await Bun.sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  return false;
}
