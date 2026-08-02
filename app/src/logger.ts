import pino from "pino";
import { logBufferStream } from "./dashboard/logBuffer";

const base = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "yaoe-flow" },
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  pino.multistream([{ stream: process.stdout }, { stream: logBufferStream }])
);

/** Loggers com label `feature` por domínio da aplicação. */
export const log = {
  server: base.child({ feature: "server" }),
  webhook: base.child({ feature: "webhook" }),
  scheduler: base.child({ feature: "scheduler" }),
  linear: base.child({ feature: "linear" }),
  hermes: base.child({ feature: "hermes" }),
  // Camada de execução de agent, comum a TODOS os harness — quem é o harness
  // vai no campo `harness` (ver agentLog()), não no `feature`. Antes disto todo
  // log de dispatch saía como feature "goose" mesmo rodando cursor/codex.
  agent: base.child({ feature: "agent" }),
  openrouter: base.child({ feature: "openrouter" }),
  valkey: base.child({ feature: "valkey" }),
  github: base.child({ feature: "github" }),
  dashboard: base.child({ feature: "dashboard" }),
} as const;

/**
 * Logger de um run de harness: `feature: "agent"` + `harness` (+ runId/role
 * quando conhecidos) em todas as linhas. Use em vez de `log.agent` direto
 * sempre que houver um harness identificado — é o que permite filtrar
 * "só o que o cursor fez" nos logs e na tela Logs da dashboard.
 */
export function agentLog(ctx: { harness: string; runId?: string; role?: string }): pino.Logger {
  return log.agent.child({
    harness: ctx.harness,
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(ctx.role ? { role: ctx.role } : {}),
  });
}

/**
 * Campos de erro pro log. Objetos que não são `Error` também vão em `err`
 * (o serializer do pino repassa non-Error como está, preservando `code`/`data`)
 * — erro de JSON-RPC do ACP é exatamente isso, e com `String(e)` ele saía como
 * `errMessage: "[object Object]"`, escondendo a causa real da falha.
 */
export function errFields(e: unknown): { err: unknown } | { errMessage: string } {
  if (typeof e === "object" && e !== null) return { err: e };
  return { errMessage: String(e) };
}

/** Nível de log efetivo (LOG_LEVEL ou default "info") — útil pra log de boot. */
export const logLevel = base.level;

/** Aplica LOG_LEVEL em runtime (hot-reload da tela Config). */
export function setLogLevel(level: string): void {
  base.level = level;
  for (const child of Object.values(log)) child.level = level;
}

/**
 * Mostra só o suficiente de um segredo pra confirmar QUAL credencial está
 * carregada (ex.: distinguir dois .env parecidos) sem vazar o valor no log.
 */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "não configurado";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}
