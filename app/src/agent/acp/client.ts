// Cliente ACP genérico (§7.1) — extraído de goose.ts, que era o único
// consumidor. Spawna um binário que fala ACP (`<bin> <args>`), JSON-RPC sobre
// stdio via ndjson (SDK oficial @zed-industries/agent-client-protocol),
// normaliza `session/update` para `NormalizedEvent` e devolve usage/session
// id no resultado. Qualquer harness ACP (goose, claude-code, codex) monta um
// `HarnessAdapter` por cima disto — a diferença entre eles é só o comando de
// spawn e como o SOUL/prompt entra na sessão (deeplink de recipe vs. system
// prompt simples).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type pino from "pino";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type McpServer,
  type ModelInfo,
  type SessionModelState,
} from "@zed-industries/agent-client-protocol";
import { log, errFields } from "../../logger";
import type { McpServerConfig } from "../recipe/defaults";
import type { HarnessUsage, NormalizedEvent } from "../harness/types";

export interface AcpSpawnSpec {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface AcpNewSessionMeta {
  /** goose: `_meta.recipeDeeplink`. Outros harness ACP não usam isto (system prompt vai no prompt inicial). */
  recipeDeeplink?: string;
  /** Suporte a notificações custom (goose accumulated usage). */
  gooseCustomNotifications?: boolean;
}

export interface AcpRunOptions {
  spawn: AcpSpawnSpec;
  newSessionMeta?: AcpNewSessionMeta;
  /**
   * Após `initialize`, chama `authenticate` com este methodId.
   * Cursor ACP exige `cursor_login` antes de `session/new` (senão a sessão trava).
   * Ver https://cursor.com/docs/cli/acp
   */
  authenticateMethodId?: string;
  /** Modelo a aplicar via setSessionModel após criar a sessão (Cursor ACP). */
  model?: string;
  /**
   * Planning/merge do Orchestrator: resolveAcpModelId prioriza variantes
   * com `fast=true` (grok-4.5 / composer-2.5 / qualquer fast do harness).
   */
  preferFast?: boolean;
  /**
   * MCPs do agente ativo (banco) — vão no param `mcpServers` do `session/new`,
   * que é a forma PADRÃO do ACP de plugar MCP numa sessão. O goose é a exceção:
   * lá os MCPs já entram como `extensions` do recipe (deeplink), então ele
   * passa a lista vazia pra não duplicar cada servidor.
   */
  mcpServers?: McpServerConfig[];
  /** Primeiro turno (system prompt + task, quando o harness não usa recipe). */
  promptText: string;
  /** Teto de um turno (prompt). */
  requestTimeoutMs: number;
  /** Retries no MESMO processo/sessão quando o provider falha transitoriamente. */
  promptRetries?: number;
  resumeSessionId?: string;
  /**
   * Logger do run (`logger.agentLog({ harness, runId, role })`) — é o que faz
   * o log sair com `feature: "agent"` + `harness` em vez do antigo
   * `feature: "goose"` pra qualquer harness.
   */
  log: pino.Logger;
  onEvent(evt: NormalizedEvent): void;
  /** Side-channel de usage fora do schema padrão do SDK (goose custom). */
  onUsageSnapshot?(usage: HarnessUsage): void;
  /**
   * Chamado logo após o spawn, ANTES de qualquer await — é como o adapter
   * obtém a referência pra matar o processo NO MEIO de um run. O `process` do
   * retorno só existe quando o turno já terminou (tarde demais pra kill).
   */
  onProcess?(p: AcpProcess): void;
}

/** Modelo enumerado pelo agente (`models.availableModels` do `session/new`). */
export interface AcpModelInfo {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpRunResult {
  outputText: string;
  stopReason?: string;
  sessionId: string;
  usage?: HarnessUsage;
}

// Tipos de `session/update` que o SDK 0.4.5 conhece. Harness ACP às vezes
// mandam outros (`usage_update` ACP padrão, ou custom) que o SDK rejeita com
// -32602 — filtramos ANTES do SDK; o processo segue rodando.
const SAFE_SESSION_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
]);
const SIDE_CHANNEL_UPDATES = new Set(["usage_update", "session_info_update"]);

/** Keys Linear que o MCP precisa, mas o shell do agent NÃO pode herdar (evita curl GraphQL duplicando comentários). */
export const LINEAR_API_SECRET_ENV_KEYS = ["LINEAR_API_KEY", "LINEAR_API_TOKEN"] as const;

/**
 * Remove tokens Linear do env do processo do harness. Chamar DEPOIS de
 * `toAcpMcpServers` / materializar `envKeys` no recipe — o MCP já recebeu o
 * valor embutido; o agent (shell/python) não deve conseguir `commentCreate` via curl.
 */
export function stripLinearApiSecretsFromEnv(env: Record<string, string>): void {
  for (const key of LINEAR_API_SECRET_ENV_KEYS) delete env[key];
}

/**
 * Detecta tool call de shell que fala com a API GraphQL do Linear (fallback
 * curl/python que duplica/parte comentários). Usado em `requestPermission`.
 */
export function isForbiddenLinearShellToolCall(toolCall: unknown): boolean {
  if (!toolCall || typeof toolCall !== "object") return false;
  const tc = toolCall as {
    kind?: string;
    title?: string;
    rawInput?: unknown;
    content?: unknown;
  };
  const kind = String(tc.kind ?? "");
  // Só bloqueia execute/shell — MCP `linear_createComment` passa.
  if (kind && kind !== "execute" && kind !== "shell" && kind !== "terminal") return false;
  const parts: string[] = [];
  if (typeof tc.title === "string") parts.push(tc.title);
  if (typeof tc.rawInput === "string") parts.push(tc.rawInput);
  else if (tc.rawInput && typeof tc.rawInput === "object") {
    try {
      parts.push(JSON.stringify(tc.rawInput));
    } catch {
      /* ignore */
    }
  }
  if (Array.isArray(tc.content)) {
    for (const c of tc.content) {
      if (!c || typeof c !== "object") continue;
      const inner = (c as { content?: { text?: string }; text?: string }).content ?? c;
      const text = (inner as { text?: string }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  const blob = parts.join("\n");
  if (!blob) return false;
  const hitsApi = /api\.linear\.app/i.test(blob);
  const hitsMutation = /\b(commentCreate|issueUpdate|commentUpdate)\b/.test(blob);
  const hitsGraphql = /graphql/i.test(blob) && (/linear/i.test(blob) || /LINEAR_API_(KEY|TOKEN)/.test(blob));
  return hitsApi || (hitsMutation && (hitsGraphql || /LINEAR_API_(KEY|TOKEN)/.test(blob)));
}

/**
 * Traduz a config de MCP agnóstica do banco (`McpServerConfig`) pro shape do
 * ACP (`McpServer`). Segredo NUNCA vai pra disco: `envKeys` é resolvido aqui a
 * partir do env do run e viaja em memória pelo stdio do JSON-RPC (mesma
 * garantia que o goose dá com `env_keys`).
 */
export function toAcpMcpServers(
  servers: McpServerConfig[] | undefined,
  env: Record<string, string>,
  logger: pino.Logger
): McpServer[] {
  const out: McpServer[] = [];
  for (const s of servers ?? []) {
    if (s.type === "builtin") {
      // `builtin` (ex.: `developer` do goose) não existe no ACP — quem fala ACP
      // já traz as próprias ferramentas de arquivo/shell embutidas.
      logger.debug({ mcp: s.name }, "mcp builtin ignorado (sem equivalente ACP)");
      continue;
    }
    if (s.type === "stdio") {
      const envVars: Array<{ name: string; value: string }> = [];
      for (const key of s.envKeys ?? []) {
        const value = env[key];
        if (value) envVars.push({ name: key, value });
        else logger.warn({ mcp: s.name, envKey: key }, "mcp stdio: envKey sem valor no ambiente do run");
      }
      for (const [name, value] of Object.entries(s.envs ?? {})) envVars.push({ name, value });
      out.push({ name: s.name, command: s.cmd, args: s.args, env: envVars });
      continue;
    }
    // streamable_http do goose == transporte "http" do ACP. Headers podem
    // referenciar segredo como ${VAR} (convenção do recipe) — expandimos aqui,
    // porque só o goose sabe resolver isso sozinho.
    const headers = Object.entries(s.headers ?? {}).map(([name, raw]) => ({
      name,
      value: raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v: string) => env[v] ?? ""),
    }));
    out.push({ type: "http", name: s.name, url: s.uri, headers });
  }
  return out;
}

/**
 * Copia `envKeys` → `envs` com valores do ambiente do run e remove `envKeys`.
 * Assim o recipe goose / MCP stdio carrega o segredo sem o processo do agent
 * precisar herdar `LINEAR_API_*` (evita fallback curl).
 */
export function materializeMcpEnvKeys(
  servers: McpServerConfig[] | undefined,
  env: Record<string, string>
): McpServerConfig[] {
  return (servers ?? []).map((s) => {
    if (s.type !== "stdio" || !s.envKeys?.length) return s;
    const envs = { ...(s.envs ?? {}) };
    for (const key of s.envKeys) {
      const value = env[key];
      if (value) envs[key] = value;
    }
    return { ...s, envs, envKeys: undefined };
  });
}

/** Nome-base do modelId parametrizado do Cursor (`foo[bar=baz]` → `foo`). */
export function acpModelBaseId(id: string): string {
  return id.replace(/\[.*\]$/, "");
}

/** `fast=true` no bracket params (Cursor: `composer-2.5[fast=true]`, grok com effort+fast). */
export function acpModelHasFastTrue(modelId: string): boolean {
  return /(?:^|[,\[]\s*)fast\s*=\s*true(?:\s*[,\]|]|$)/i.test(modelId);
}

function isAcpDefaultishModel(requested: string): boolean {
  const lower = requested.trim().toLowerCase();
  if (!lower || lower === "auto" || lower === "default") return true;
  return acpModelBaseId(lower) === "default";
}

function isGrok45Base(base: string): boolean {
  return /^grok[-_.]?4[-_.]?5$/i.test(base.trim());
}

/**
 * Score de variantes "rápidas" na lista do harness. Usado em planning/merge
 * do Orchestrator pra não ficar preso no Auto/default lento.
 *
 * Prioridade (Cursor): grok-4.5 + effort=high + fast → grok-4.5 + fast →
 * composer-2.5 + fast → qualquer outro com fast=true.
 */
export function scoreAcpFastModel(modelId: string): number {
  if (!acpModelHasFastTrue(modelId)) return -1;
  const base = acpModelBaseId(modelId);
  if (isGrok45Base(base)) {
    return /(?:^|[,\[]\s*)effort\s*=\s*high(?:\s*[,\]|]|$)/i.test(modelId) ? 100 : 90;
  }
  if (/^composer-2\.5$/i.test(base)) return 80;
  return 50;
}

/**
 * Escolhe o melhor modelId "rápido" disponível.
 * - default/auto/`default[]`: prioridade grok-4.5[fast] → composer-2.5[fast] → qualquer fast.
 * - modelo específico sem fast: mesma base com `fast=true`, se existir.
 * - já com fast=true (ou sem variante rápida): null (caller segue resolução normal).
 */
export function pickPreferredFastAcpModelId(
  requested: string,
  available: ModelInfo[]
): string | null {
  if (!available.length) return null;

  if (isAcpDefaultishModel(requested)) {
    let best: ModelInfo | undefined;
    let bestScore = -1;
    for (const m of available) {
      const s = scoreAcpFastModel(m.modelId);
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }
    return best?.modelId ?? null;
  }

  if (acpModelHasFastTrue(requested)) return null;

  const base = acpModelBaseId(requested.trim()).toLowerCase();
  let best: ModelInfo | undefined;
  let bestScore = -1;
  for (const m of available) {
    if (acpModelBaseId(m.modelId).toLowerCase() !== base) continue;
    const s = scoreAcpFastModel(m.modelId);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return best?.modelId ?? null;
}

export interface ResolveAcpModelIdOptions {
  /**
   * Planning/merge do Orchestrator: prioriza variantes com `fast=true` quando
   * o agente está em Auto/default[] (ou quando a base configurada tem variante rápida).
   */
  preferFast?: boolean;
}

/**
 * Resolve o modelo configurado contra o que o agente REALMENTE aceita.
 *
 * O Cursor expõe modelId parametrizado (`default[]`, `composer-2.5[fast=true]`,
 * `claude-opus-5[thinking=true,context=300k,…]`) e rejeita qualquer outra
 * string com `-32602 Invalid model value` — era exatamente o caso do "auto"
 * configurado na dashboard, que morria no setSessionModel e caía no default
 * silenciosamente. Aceitamos modelId exato, nome legível ("Auto",
 * "composer-2.5") e o nome-base antes do `[`.
 *
 * `null` = não chamar setSessionModel (fica no default do agente).
 */
export function resolveAcpModelId(
  requested: string,
  models: SessionModelState | null | undefined,
  logger: pino.Logger,
  opts?: ResolveAcpModelIdOptions
): string | null {
  const available = models?.availableModels;
  if (!available?.length) {
    // Agente não enumera modelos — repassa como veio (ex.: goose, que resolve
    // o modelo por env/recipe e nem implementa setSessionModel).
    return requested;
  }

  if (opts?.preferFast) {
    const fast = pickPreferredFastAcpModelId(requested, available);
    if (fast) {
      logger.info(
        { model: requested, modelId: fast, preferFast: true },
        "acp: preferindo modelo rápido (planning/merge)"
      );
      return fast;
    }
  }

  const wanted = requested.trim();
  const lower = wanted.toLowerCase();

  const pick = (m: ModelInfo | undefined): string | null => m?.modelId ?? null;
  const exact = available.find((m) => m.modelId === wanted);
  if (exact) return exact.modelId;
  const byName = available.find((m) => m.name.toLowerCase() === lower);
  if (byName) return byName.modelId;
  const byBase = available.find((m) => acpModelBaseId(m.modelId).toLowerCase() === lower);
  if (byBase) return byBase.modelId;
  // "auto"/"default" é como a dashboard nomeia "deixa o harness escolher";
  // no Cursor isso é o modelo de nome "Auto" (modelId "default[]").
  if (lower === "auto" || lower === "default") {
    const auto = pick(
      available.find((m) => m.name.toLowerCase() === "auto") ??
        available.find((m) => acpModelBaseId(m.modelId) === "default")
    );
    if (auto) return auto;
    return null;
  }
  logger.warn(
    { model: requested, currentModelId: models?.currentModelId, available: available.map((m) => m.modelId).slice(0, 40) },
    "modelo configurado não existe na lista do harness — seguindo com o default da sessão"
  );
  return null;
}

function numField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function extractGooseAccumulatedUsage(update: Record<string, unknown>): HarnessUsage | null {
  const inputTokens = numField(update, "accumulatedInputTokens", "accumulated_input_tokens");
  const outputTokens = numField(update, "accumulatedOutputTokens", "accumulated_output_tokens");
  const costUsd = numField(update, "accumulatedCost", "accumulated_cost");
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return null;
  return { inputTokens, outputTokens, costUsd };
}

function extractAcpUsageCost(update: Record<string, unknown>): number | undefined {
  const cost = update.cost;
  if (cost && typeof cost === "object" && !Array.isArray(cost)) {
    return numField(cost as Record<string, unknown>, "amount");
  }
  return numField(update, "cost", "cost_usd", "costUsd");
}

function extractPromptResponseUsage(resp: unknown): HarnessUsage | null {
  if (!resp || typeof resp !== "object") return null;
  const usage = (resp as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = numField(usage, "inputTokens", "input_tokens", "prompt_tokens");
  const outputTokens = numField(usage, "outputTokens", "output_tokens", "completion_tokens");
  const cacheReadTokens = numField(usage, "cachedReadTokens", "cache_read_tokens", "cache_read_input_tokens");
  const cacheWriteTokens = numField(usage, "cachedWriteTokens", "cache_write_tokens", "cache_write_input_tokens");
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

// Métodos que o SDK 0.4.5 sabe tratar no lado cliente. Qualquer OUTRO método
// (sem o prefixo `_` que o SDK usa como envelope de extensão) o SDK responde
// com -32601 methodNotFound — foi o que acontecia com os `cursor/*`.
const ACP_CLIENT_METHODS = new Set([
  "session/update",
  "session/request_permission",
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
  "terminal/kill",
]);

interface AcpStreamHooks {
  onSideChannel(kind: string, update: Record<string, unknown>): void;
  /**
   * Resposta a um request que NÓS mandamos fora do SDK (ver rawRequest —
   * workaround do bug de `setSessionModel` no SDK 0.4.5). Devolve true quando
   * consumiu, e aí a linha não chega ao SDK (que não conhece aquele id).
   */
  onResponse(id: number | string, result: unknown, error: unknown): boolean;
  /**
   * Request de extensão que o SDK rejeitaria (Cursor manda `cursor/ask_question`,
   * `cursor/create_plan`, `cursor/update_todos` — SEM o `_` que o SDK exige).
   * `cursor/create_plan` e `cursor/ask_question` são BLOQUEANTES: sem resposta
   * o turno pendura. Quem implementa isto tem que responder pelo `respond`.
   */
  onExtRequest(method: string, id: number | string, params: Record<string, unknown>): void;
  onExtNotification(method: string, params: Record<string, unknown>): void;
}

function filterAcpStream(
  input: ReadableStream<Uint8Array>,
  hooks: AcpStreamHooks,
  logger: pino.Logger
): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";

  const keepLine = (line: string): string | null => {
    if (!line.trim()) return line;
    try {
      const msg = JSON.parse(line) as {
        id?: number | string;
        method?: string;
        result?: unknown;
        error?: unknown;
        params?: { update?: Record<string, unknown> & { sessionUpdate?: string } } & Record<string, unknown>;
      };
      if (msg.method === undefined && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        if (hooks.onResponse(msg.id, msg.result, msg.error)) return null;
        return line;
      }
      if (msg.method === "_goose/unstable/session/update") {
        const update = msg.params?.update;
        if (update?.sessionUpdate === "usage_update") hooks.onSideChannel("goose_usage_snapshot", update);
        else if (update) hooks.onSideChannel(String(update.sessionUpdate ?? "goose_session_update"), update);
        return null;
      }
      if (msg.method === "session/update") {
        const su = msg.params?.update?.sessionUpdate;
        if (su && !SAFE_SESSION_UPDATES.has(su)) {
          if (SIDE_CHANNEL_UPDATES.has(su) && msg.params?.update) hooks.onSideChannel(su, msg.params.update);
          logger.debug({ sessionUpdate: su }, "acp session/update ignorado (fora do schema do SDK)");
          return null;
        }
        return line;
      }
      // Extensão fora do envelope `_` do SDK: tratamos AQUI, senão o SDK
      // responde methodNotFound e a call bloqueante do Cursor morre.
      if (msg.method && !ACP_CLIENT_METHODS.has(msg.method) && !msg.method.startsWith("_")) {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (msg.id !== undefined) hooks.onExtRequest(msg.method, msg.id, params);
        else hooks.onExtNotification(msg.method, params);
        return null;
      }
    } catch {
      /* não-JSON: repassa como está */
    }
    return line;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buf) {
            const out = keepLine(buf);
            if (out) controller.enqueue(enc.encode(out));
          }
          controller.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
        let idx: number;
        let emitted = false;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx + 1);
          buf = buf.slice(idx + 1);
          const out = keepLine(line);
          if (out !== null) {
            controller.enqueue(enc.encode(out));
            emitted = true;
          }
        }
        if (emitted) return;
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/**
 * Método de autenticação a usar depois do `initialize`. Deliberadamente NÃO
 * pega "o primeiro que o agente anuncia": o claude-code-acp anuncia um método
 * que não implementa. Só `cursor_login` (exigência real do Cursor ACP antes do
 * session/new) ou o que o adapter pedir explicitamente.
 */
function pickAuthMethodId(initResult: unknown, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const authMethods = (initResult as { authMethods?: Array<{ id?: string }> }).authMethods ?? [];
  return authMethods.some((m) => m.id === "cursor_login") ? "cursor_login" : undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  // O clearTimeout não é detalhe: sem ele cada request deixa um timer vivo até
  // estourar (15 min no caso do prompt), segurando o event loop de quem chamou
  // — era o que fazia scripts/CLI ficarem ~80s pendurados depois do trabalho
  // ter terminado.
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`acp timeout: ${label} (${ms}ms)`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Auto-retry de erro transitório do provider (mesma heurística do goose.ts
// original — o texto "Ran into this error… please retry" é convenção do
// goose, mas manter aqui não tem custo pros outros adapters: eles simplesmente
// nunca emitem esse texto, então o regex nunca casa).
const TRANSIENT_TURN_ERROR = /ran into this error[\s\S]{0,600}(?:please retry|transient or recoverable)/i;
const TRANSIENT_REJECT = /empty response|rate.?limit|overloaded|429|502|503|529|ECONNRESET|ETIMEDOUT/i;

// Cursor (e outros harness com provider próprio) NÃO falham o `session/prompt`
// quando o provider recusa o turno: devolvem `stopReason: "end_turn"` e cospem
// o erro como texto do agente. Sem detectar isto, o run era marcado "completed"
// com zero trabalho feito e o scheduler entrava em loop de re-dispatch
// ("re-dispatching worker for fix") até estourar maxAttempts.
// Ex. real: "Error: NonRetriableError: Provider Error Too many MCP tools are
// enabled for this model. Please disable some MCP servers and try again."
const PROVIDER_TURN_ERROR = /\bError:\s*(?:Non)?RetriableError:\s*(.+)/i;
const NON_RETRIABLE_TURN_ERROR = /\bNonRetriableError\b/i;

/** Erro de provider cuspido como texto do agente (não como rejeição do JSON-RPC). */
function detectProviderTurnError(turnText: string): { message: string; retriable: boolean } | null {
  const m = PROVIDER_TURN_ERROR.exec(turnText);
  if (!m) return null;
  return { message: m[1].trim().slice(0, 400), retriable: !NON_RETRIABLE_TURN_ERROR.test(m[0]) };
}
const RETRY_NUDGE =
  "The previous turn was interrupted by a transient provider error (e.g. an empty response from the model provider). " +
  "Retry now: continue exactly from where you stopped — do NOT redo work you already completed. If you had in fact " +
  "already finished the task, just verify the Linear issue reflects your final routing and end the turn.";

export class AcpProcess {
  readonly proc: ReturnType<typeof Bun.spawn>;
  private killed = false;

  constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.proc = proc;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    shutdownAcpProcess(this.proc);
  }
}

/**
 * Encerra um agente ACP. Fechar o stdin PRIMEIRO é o fim-de-sessão do
 * protocolo (só o SIGTERM deixa o CLI dando voltas por dezenas de segundos
 * antes de sair).
 */
function shutdownAcpProcess(proc: {
  // `stdin` do Bun é FileSink só quando spawnado com "pipe" — o tipo genérico
  // admite fd numérico, daí a assinatura larga e o guard abaixo.
  stdin?: { end(): unknown } | number | null;
  kill(): void;
}): void {
  const stdin = proc.stdin;
  if (stdin && typeof stdin === "object") {
    try {
      stdin.end();
    } catch {
      /* já fechado */
    }
  }
  try {
    proc.kill();
  } catch {
    /* já morto */
  }
}

/**
 * Roda UM turno de conversa via ACP contra um processo spawnado (process-per-run
 * — cada run isola seu próprio `<bin>` com seu próprio workspace/env). Aplica
 * o mesmo auto-retry de erro transitório do goose.ts original, generalizado.
 */
export async function runAcpTurn(opts: AcpRunOptions): Promise<{ result: AcpRunResult; process: AcpProcess }> {
  mkdirSync(opts.spawn.cwd, { recursive: true });
  const logger = opts.log;

  // Resolver MCP (com segredos embutidos) ANTES do spawn, depois stripar
  // LINEAR_API_* do env do agent — senão shell/curl herda a key e duplica
  // comentários via GraphQL (evidência: dual path MCP + commentCreate).
  const spawnEnv = { ...opts.spawn.env };
  const acpMcpServers = toAcpMcpServers(opts.mcpServers, spawnEnv, logger);
  const hadLinearSecret = LINEAR_API_SECRET_ENV_KEYS.some((k) => Boolean(spawnEnv[k]));
  stripLinearApiSecretsFromEnv(spawnEnv);

  const proc = Bun.spawn([opts.spawn.bin, ...opts.spawn.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
    cwd: opts.spawn.cwd,
  });
  const wrapped = new AcpProcess(proc);
  opts.onProcess?.(wrapped);

  let stderrTail = "";
  (async () => {
    const dec = new TextDecoder();
    try {
      for await (const c of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        stderrTail = (stderrTail + dec.decode(c)).slice(-4000);
      }
    } catch {
      /* pipe fechado ao matar o processo */
    }
  })();

  let collected = "";
  let sawAccumulatedSnapshot = false;
  let sideChannelUsage: HarnessUsage | undefined;

  /** Resposta JSON-RPC crua — usada pelos `cursor/*`, que não passam pelo SDK. */
  function respondRaw(id: number | string, result: unknown): void {
    try {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      proc.stdin.flush();
    } catch (e) {
      logger.debug({ ...errFields(e) }, "acp: falha ao responder request de extensão (processo já morto?)");
    }
  }

  // Canal de request CRU, fora do SDK. Existe por um bug do
  // @zed-industries/agent-client-protocol 0.4.5 (última versão publicada):
  // `ClientSideConnection.setSessionModel()` manda `session/set_mode` em vez de
  // `session/set_model` (copy-paste no wrapper). Ou seja: escolher modelo via
  // SDK NUNCA funcionou — o agente recebia o método de MODO com `{modelId}` e
  // recusava. Ids em faixa alta pra não colidir com o contador do SDK.
  let nextRawId = 9_000_000;
  const pendingRaw = new Map<number | string, (r: { result?: unknown; error?: unknown }) => void>();
  function rawRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = nextRawId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRaw.delete(id);
        reject(new Error(`acp timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      pendingRaw.set(id, ({ result, error }) => {
        clearTimeout(timer);
        if (error) reject(new Error(typeof error === "object" ? JSON.stringify(error) : String(error)));
        else resolve(result);
      });
      try {
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        proc.stdin.flush();
      } catch (e) {
        clearTimeout(timer);
        pendingRaw.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // `tool_call_update` só carrega os campos que MUDARAM (spec do ACP), então o
  // título vem apenas no `tool_call` inicial. Sem guardar por toolCallId, a
  // timeline da dashboard mostrava "Tool (update)" sem nome nenhum.
  const toolTitles = new Map<string, string>();

  const client: Client = {
    async sessionUpdate(p) {
      const u = p.update as {
        sessionUpdate: string;
        content?: { type?: string; text?: string };
        toolCallId?: string;
        title?: string;
        status?: string;
      };
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && u.content.text) {
        collected += u.content.text;
        opts.onEvent({ kind: "agent_message_chunk", text: u.content.text, payload: u });
      } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text" && u.content.text) {
        opts.onEvent({ kind: "agent_thought_chunk", text: u.content.text, payload: u });
      } else if (u.sessionUpdate === "tool_call") {
        if (u.toolCallId && u.title) toolTitles.set(u.toolCallId, u.title);
        opts.onEvent({ kind: "tool_call", toolName: u.title, toolStatus: u.status, payload: u });
      } else if (u.sessionUpdate === "tool_call_update") {
        const title = u.title ?? (u.toolCallId ? toolTitles.get(u.toolCallId) : undefined);
        if (u.toolCallId && u.title) toolTitles.set(u.toolCallId, u.title);
        opts.onEvent({ kind: "tool_call_update", toolName: title, toolStatus: u.status, payload: u });
      } else if (u.sessionUpdate === "plan") {
        opts.onEvent({ kind: "plan", payload: u });
      }
    },
    async requestPermission(p) {
      // Orquestrador é autônomo: não existe humano pra aprovar tool call. Damos
      // preferência a `allow_always` — com `allow_once` cada comando de shell
      // vira um round-trip novo no meio do turno.
      const kind = (o: unknown): string => String((o as { kind?: string }).kind ?? "");
      const tc = p.toolCall as { title?: string; toolCallId?: string; kind?: string } | undefined;
      // Bloqueia shell→GraphQL Linear (duplica/parte comentários). MCP Linear ok.
      const forbidLinearShell = isForbiddenLinearShellToolCall(p.toolCall);
      const opt = forbidLinearShell
        ? (p.options.find((o) => kind(o).startsWith("reject")) ??
          p.options.find((o) => kind(o) === "cancel") ??
          null)
        : (p.options.find((o) => kind(o) === "allow_always") ??
          p.options.find((o) => kind(o).startsWith("allow")) ??
          p.options[0]);
      opts.onEvent({
        kind: "tool_call_update",
        toolName: tc?.title ?? (tc?.toolCallId ? toolTitles.get(tc.toolCallId) : undefined),
        toolStatus: opt
          ? `permission:${(opt as { optionId: string }).optionId}${forbidLinearShell ? ":blocked-linear-shell" : ""}`
          : "permission:cancelled",
        payload: {
          method: "session/request_permission",
          params: p,
          selectedOptionId: opt ? (opt as { optionId: string }).optionId : undefined,
          blockedLinearShell: forbidLinearShell || undefined,
        },
      });
      if (!opt) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: (opt as { optionId: string }).optionId } };
    },
    // Extensões COM o prefixo `_` (envelope que o SDK entende). As do Cursor
    // vêm sem `_` e são tratadas antes do SDK, no filterAcpStream.
    async extMethod(method: string, params: Record<string, unknown>) {
      return handleExtRequest(method, params);
    },
    async extNotification(method: string, params: Record<string, unknown>) {
      opts.onEvent({ kind: "plan", payload: { method, params } });
    },
  };

  /**
   * Métodos de extensão do Cursor (https://cursor.com/docs/cli/acp). Os
   * bloqueantes (`cursor/ask_question`, `cursor/create_plan`) PRECISAM de
   * resposta — sem ela o turno pendura até o requestTimeoutMs. Como o
   * orquestrador roda sem humano, a política é: aceitar plano/todos (só
   * registrar na timeline) e PULAR pergunta (o agente segue com o próprio
   * julgamento em vez de esperar por alguém).
   */
  function handleExtRequest(method: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case "cursor/ask_question":
        opts.onEvent({ kind: "plan", payload: { method, params } });
        return { outcome: { outcome: "skipped", reason: "autonomous pipeline: no human in the loop" } };
      case "cursor/create_plan":
        opts.onEvent({ kind: "plan", payload: { method, params } });
        return { outcome: { outcome: "accepted" } };
      case "cursor/update_todos":
        opts.onEvent({ kind: "plan", payload: { method, params } });
        return { outcome: { outcome: "accepted", todos: Array.isArray(params.todos) ? params.todos : [] } };
      case "cursor/task":
        opts.onEvent({ kind: "plan", payload: { method, params } });
        return { outcome: { outcome: "completed" } };
      case "cursor/generate_image":
        // Sem canal pra imagem no pipeline — rejeitamos explicitamente em vez
        // de devolver `{}`, que o Cursor leria como resposta malformada.
        opts.onEvent({ kind: "plan", payload: { method, params } });
        return { outcome: { outcome: "rejected", reason: "image generation not supported by the orchestrator" } };
      default:
        logger.debug({ method }, "acp: request de extensão sem handler específico — resposta vazia");
        return {};
    }
  }

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      try {
        proc.stdin.end();
      } catch {
        /* já fechado */
      }
    },
  });
  const filtered = filterAcpStream(
    proc.stdout as unknown as ReadableStream<Uint8Array>,
    {
      onSideChannel(kind, update) {
        if (kind === "goose_usage_snapshot") {
          const snap = extractGooseAccumulatedUsage(update);
          if (snap) {
            sawAccumulatedSnapshot = true;
            sideChannelUsage = snap;
            opts.onUsageSnapshot?.(snap);
          } else {
            opts.onEvent({ kind: "usage_update", payload: update });
          }
        } else if (kind === "usage_update") {
          const costUsd = extractAcpUsageCost(update);
          if (costUsd !== undefined) {
            sawAccumulatedSnapshot = true;
            sideChannelUsage = { costUsd };
            opts.onUsageSnapshot?.({ costUsd });
          } else {
            opts.onEvent({ kind: "usage_update", payload: update });
          }
        } else if (kind === "session_info_update") {
          // Cursor manda o TÍTULO que ele deu pra conversa. Não é usage —
          // antes caía como `usage_update` vazio e sujava a timeline.
          opts.onEvent({ kind: "plan", payload: { sessionUpdate: kind, ...update } });
        } else {
          opts.onEvent({ kind: "usage_update", payload: update });
        }
      },
      onResponse(id, result, error) {
        const waiter = pendingRaw.get(id);
        if (!waiter) return false;
        pendingRaw.delete(id);
        waiter({ result, error });
        return true;
      },
      onExtRequest(method, id, params) {
        respondRaw(id, handleExtRequest(method, params));
      },
      onExtNotification(method, params) {
        opts.onEvent({ kind: "plan", payload: { method, params } });
      },
    },
    logger
  );
  const stream = ndJsonStream(writable, filtered);
  const conn = new ClientSideConnection(() => client, stream);

  // O SDK NÃO rejeita requests pendentes quando o processo morre (stdout só
  // fecha) — sem isto, um kill() ou morte abrupta deixava o turno pendurado
  // até o requestTimeoutMs inteiro, com o run "running" e o seat preso.
  // Promise pré-armada (catch vazio) pra não virar unhandled rejection quando
  // o turno termina normalmente e o processo é morto depois.
  const exitedMidTurn = new Promise<never>((_, reject) => {
    proc.exited.then((code) => reject(new Error(`acp: processo encerrou (code ${code}) antes do fim do turno`)));
  });
  exitedMidTurn.catch(() => {});

  try {
    const initResult = await withTimeout(
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: opts.newSessionMeta?.gooseCustomNotifications
          ? { _meta: { goose: { customNotifications: true } } }
          : { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "yaoe-flow", version: "0.1.0" },
      } as Parameters<typeof conn.initialize>[0]),
      15_000,
      "initialize"
    );

    // Cursor ACP exige authenticate(cursor_login) antes de session/new —
    // sem isso a sessão trava. Goose/Claude/Codex ignoram se não anunciam.
    const methodId = pickAuthMethodId(initResult, opts.authenticateMethodId);
    if (methodId) {
      await withTimeout(conn.authenticate({ methodId }), 60_000, "authenticate");
    }

    // MCPs já resolvidos antes do spawn (segredos embutidos; agent env limpo).
    if (acpMcpServers.length > 0) {
      logger.info({ mcpServers: acpMcpServers.map((m) => m.name) }, "acp: MCPs da sessão");
    }

    // §7.6: session resume — tenta `loadSession` quando há sessão anterior DA
    // MESMA issue NO MESMO harness. Fallback transparente: agente sem a
    // capability opcional (`loadSession` ausente na interface Agent) ou
    // sessão não encontrada → cai pro newSession normal, sem travar o
    // pipeline (só loga). NUNCA lança pro caller por causa de resume falho.
    let sessionModels: SessionModelState | null | undefined;
    async function resumeSession(id: string): Promise<string | null> {
      try {
        await withTimeout(
          conn.loadSession({ sessionId: id, cwd: opts.spawn.cwd, mcpServers: acpMcpServers } as Parameters<
            typeof conn.loadSession
          >[0]),
          30_000,
          "loadSession"
        );
        return id;
      } catch (e) {
        logger.info(
          { resumeSessionId: id, ...errFields(e) },
          "session resume falhou (agente sem loadSession ou sessão expirada) — começando do zero"
        );
        return null;
      }
    }
    async function startNewSession(): Promise<string> {
      const sess = await withTimeout(
        conn.newSession({
          cwd: opts.spawn.cwd,
          mcpServers: acpMcpServers,
          ...(opts.newSessionMeta?.recipeDeeplink
            ? ({ _meta: { recipeDeeplink: opts.newSessionMeta.recipeDeeplink } } as Record<string, unknown>)
            : {}),
        } as Parameters<typeof conn.newSession>[0]),
        30_000,
        "newSession"
      );
      sessionModels = (sess as { models?: SessionModelState | null }).models;
      return sess.sessionId;
    }
    const sessionId = (opts.resumeSessionId ? await resumeSession(opts.resumeSessionId) : null) ?? (await startNewSession());

    // Modelo via setSessionModel (o `session/new` não aceita modelo). O id tem
    // que ser um dos `availableModels` do próprio agente — ver resolveAcpModelId.
    // preferFast (planning/merge): mesmo sem model configurado, tenta uma
    // variante rápida da lista em vez de ficar no Auto/default da sessão.
    if (opts.model || opts.preferFast) {
      const requested = opts.model?.trim() || "default";
      const modelId = resolveAcpModelId(requested, sessionModels, logger, {
        preferFast: opts.preferFast,
      });
      if (modelId) {
        try {
          // rawRequest, não conn.setSessionModel(): o SDK 0.4.5 manda o método
          // errado (`session/set_mode`) — ver comentário em rawRequest.
          await rawRequest("session/set_model", { sessionId, modelId }, 15_000);
          logger.info(
            { model: requested, modelId, preferFast: !!opts.preferFast },
            "acp: modelo da sessão aplicado"
          );
        } catch (e) {
          logger.warn(
            { model: requested, modelId, preferFast: !!opts.preferFast, ...errFields(e) },
            "session/set_model falhou — seguindo com modelo default da sessão"
          );
        }
      }
    }
    let resp: Awaited<ReturnType<typeof conn.prompt>>;
    let attempt = 0;
    const maxRetries = opts.promptRetries ?? 0;
    for (;;) {
      const turnStart = collected.length;
      const promptText = attempt === 0 ? opts.promptText : RETRY_NUDGE;
      try {
        resp = await withTimeout(
          Promise.race([conn.prompt({ sessionId, prompt: [{ type: "text", text: promptText }] }), exitedMidTurn]),
          opts.requestTimeoutMs,
          "prompt"
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < maxRetries && !msg.startsWith("acp timeout") && TRANSIENT_REJECT.test(msg)) {
          attempt++;
          logger.warn({ attempt, maxRetries, error: msg.slice(0, 300) }, "acp prompt: erro transitório, retry na mesma sessão");
          await Bun.sleep(2_000 * attempt);
          continue;
        }
        throw e;
      }
      const turnText = collected.slice(turnStart);
      const turnTail = turnText.slice(-800);

      // Erro de provider que veio como TEXTO do agente com stopReason normal.
      // Tem que virar run "failed": marcar "completed" fazia o scheduler
      // re-despachar em loop achando que o agente simplesmente não entregou.
      const providerError = detectProviderTurnError(turnText);
      if (providerError) {
        opts.onEvent({
          kind: "error",
          text: providerError.message,
          payload: { source: "provider", retriable: providerError.retriable, stopReason: resp.stopReason },
        });
        if (providerError.retriable && attempt < maxRetries) {
          attempt++;
          logger.warn({ attempt, maxRetries, error: providerError.message }, "acp: erro de provider no turno, retry na mesma sessão");
          await Bun.sleep(2_000 * attempt);
          continue;
        }
        // Não-retriável (ex.: "Too many MCP tools are enabled for this model")
        // não gasta retry: repetir dá o mesmo erro.
        throw new Error(
          `${providerError.retriable ? "erro de provider persistiu" : "erro não-retriável do provider"}: ${providerError.message}`
        );
      }

      if (TRANSIENT_TURN_ERROR.test(turnTail)) {
        if (attempt < maxRetries) {
          attempt++;
          await Bun.sleep(2_000 * attempt);
          continue;
        }
        throw new Error(`provider error persistiu após ${attempt} retry(s): ${turnTail.trim().slice(-300)}`);
      }
      // Usage padrão do ACP vem na RESPOSTA do prompt. O side-channel do goose
      // (totais acumulados) tem prioridade quando existe; sem ele, o do turno
      // precisa chegar ao resultado — antes ia só pro onUsageSnapshot, que
      // nenhum adapter conecta, então harness ACP não-goose reportava zero.
      let turnUsage: HarnessUsage | undefined;
      if (!sawAccumulatedSnapshot) {
        turnUsage = extractPromptResponseUsage(resp) ?? undefined;
        if (turnUsage) opts.onUsageSnapshot?.(turnUsage);
      }
      return {
        result: {
          outputText: collected,
          stopReason: resp.stopReason,
          sessionId,
          usage: sideChannelUsage ?? turnUsage,
        },
        process: wrapped,
      };
    }
  } catch (e) {
    logger.debug({ ...errFields(e), stderrTail: stderrTail.trim().slice(-1500) }, "acp turn failed");
    throw e;
  } finally {
    // Process-per-run: acabado o turno, ninguém mais precisa deste agente
    // (resume acontece em processo NOVO, por sessionId). Sem isto o CLI ficava
    // vivo depois de cada run bem-sucedido — só o cancelamento manual matava —
    // e num daemon 24/7 isso acumula um node inteiro (+ MCPs filhos) por run.
    wrapped.kill();
  }
}

/**
 * Enumera os modelos que o agente aceita, SEM mandar prompt (zero token).
 *
 * O ACP 0.4.5 não tem RPC de listagem: `models.availableModels` só existe na
 * resposta do `session/new`. Então a sonda é: spawn → initialize →
 * authenticate → session/new (com `mcpServers: []`, pra não subir MCP nenhum
 * só pra ler uma lista) → mata o processo. É o que alimenta o select de modelo
 * da dashboard em vez do campo de texto livre.
 */
export async function listAcpModels(opts: {
  spawn: AcpSpawnSpec;
  authenticateMethodId?: string;
  log: pino.Logger;
  timeoutMs?: number;
}): Promise<{ models: AcpModelInfo[]; defaultModelId?: string }> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  mkdirSync(opts.spawn.cwd, { recursive: true });
  const proc = Bun.spawn([opts.spawn.bin, ...opts.spawn.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.spawn.env,
    cwd: opts.spawn.cwd,
  });

  // Drenar o stderr é o que dá diagnóstico quando a sonda falha (é lá que o
  // CLI reclama de login) — e um pipe que ninguém lê ainda segura o event loop
  // depois do processo morrer.
  let stderrTail = "";
  void (async () => {
    try {
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        stderrTail = (stderrTail + new TextDecoder().decode(chunk)).slice(-2000);
      }
    } catch {
      /* processo encerrado */
    }
  })();

  // Cliente mínimo: a sonda não conversa, então nada além de recusar o que
  // exigir decisão. Se o agente pedir permissão aqui, algo está muito errado.
  const client: Client = {
    async sessionUpdate() {},
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
    async extMethod() {
      return {};
    },
    async extNotification() {},
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      try {
        proc.stdin.end();
      } catch {
        /* já fechado */
      }
    },
  });
  const filtered = filterAcpStream(
    proc.stdout as unknown as ReadableStream<Uint8Array>,
    {
      onSideChannel() {},
      onResponse: () => false,
      // Extensão durante a sonda: responder vazio basta (ninguém está num turno).
      onExtRequest(method, id) {
        try {
          proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
          proc.stdin.flush();
        } catch {
          /* processo já morto */
        }
      },
      onExtNotification() {},
    },
    opts.log
  );
  const conn = new ClientSideConnection(() => client, ndJsonStream(writable, filtered));

  try {
    const initResult = await withTimeout(
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "yaoe-flow", version: "0.1.0" },
      } as Parameters<typeof conn.initialize>[0]),
      15_000,
      "initialize"
    );
    // Mesma regra do run (só cursor_login, ou o que o adapter pedir): tentar
    // qualquer método anunciado quebrava o claude-code-acp, que ANUNCIA um
    // método e responde "Method not implemented". E aqui a falha nunca é fatal
    // — o CLI pode já estar logado, e uma lista de modelos não vale abortar.
    const methodId = pickAuthMethodId(initResult, opts.authenticateMethodId);
    if (methodId) {
      try {
        await withTimeout(conn.authenticate({ methodId }), 60_000, "authenticate");
      } catch (e) {
        opts.log.debug({ methodId, ...errFields(e) }, "sonda de modelos: authenticate falhou — seguindo pro session/new");
      }
    }

    const sess = await withTimeout(
      conn.newSession({ cwd: opts.spawn.cwd, mcpServers: [] } as Parameters<typeof conn.newSession>[0]),
      timeoutMs,
      "newSession"
    );
    const models = (sess as { models?: SessionModelState | null }).models;
    return {
      models: (models?.availableModels ?? []).map((m) => ({
        id: m.modelId,
        ...(m.name ? { name: m.name } : {}),
        ...((m as { description?: string }).description ? { description: (m as { description?: string }).description } : {}),
      })),
      ...(models?.currentModelId ? { defaultModelId: models.currentModelId } : {}),
    };
  } catch (e) {
    opts.log.debug({ ...errFields(e), stderrTail: stderrTail.trim().slice(-1000) }, "sonda de modelos ACP falhou");
    throw e;
  } finally {
    shutdownAcpProcess(proc);
  }
}

export function cleanupWorkspace(cwd: string, keep: boolean): void {
  if (keep) return;
  try {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  } catch (e) {
    log.agent.warn({ cwd, ...errFields(e) }, "falha ao remover workspace do run (best-effort)");
  }
}
