// Interface HarnessAdapter (§7.1 do blueprint multi-harness): a camada ABAIXO
// de AgentBackend — o scheduler continua vendo só AgentBackend (invariante
// §3.2); quem conhece cada CLI/protocolo é o adapter. A dashboard não conhece
// harness: os adapters TRADUZEM seus eventos nativos pro NormalizedEvent
// (superset do que a timeline já conhecia do Goose).
//
// Diferença deliberada vs. o pseudocódigo do blueprint: eventos chegam por
// CALLBACK (input.onEvent) em vez de AsyncIterable — mesmo poder de
// observabilidade (alimenta run_events + liveness por inatividade) com menos
// maquinário; `result` continua Promise e `kill()` continua síncrono.
import type { McpServerConfig, SchedulerRole } from "../recipe/defaults";

export type HarnessId = "goose" | "hermes" | "claude-code" | "codex" | "cursor" | "copilot";

export const HARNESS_IDS: HarnessId[] = ["goose", "hermes", "claude-code", "codex", "cursor", "copilot"];

/**
 * Modelo aceito por um harness. `id` é a string EXATA que vai pro harness
 * (no Cursor, parametrizada: `claude-opus-5[thinking=true,effort=high]`);
 * `name` é o rótulo legível que o próprio CLI dá pra ela.
 */
export interface HarnessModelInfo {
  id: string;
  name?: string;
  description?: string;
}

export interface HarnessDetection {
  installed: boolean;
  binPath?: string;
  version?: string;
  authStatus: "ok" | "not-logged" | "unknown";
  authAccount?: string;
  /** Como instalar/logar — mostrado na tela Harness quando faltando. */
  installHint?: string;
  loginHint?: string;
  /**
   * Modelos enumerados pelo próprio harness (`modelSelection: "list"`), pra
   * dashboard oferecer escolha em vez de texto livre. Ausente = não sondado
   * ou harness que não enumera.
   */
  models?: HarnessModelInfo[];
  /** Modelo que o harness usa quando nada é configurado (ex.: `default[]`). */
  defaultModelId?: string;
  checkedAt: number;
}

export interface HarnessCapabilities {
  integration: "acp" | "native" | "http";
  modelSelection: "list" | "flag" | "none";
  usageReporting: "tokens+cost" | "tokens" | "none";
  costSource: "api" | "subscription";
  sessionResume: boolean;
  mcp: boolean;
  kill: boolean;
}

export interface NormalizedEvent {
  kind:
    | "user_message"
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan"
    | "usage_update"
    | "error";
  text?: string;
  toolName?: string;
  toolStatus?: string;
  payload: unknown;
}

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface HarnessRunInput {
  /** runId da dashboard — também usado como correlação externa (ex.: session_id OpenRouter). */
  runId: string;
  role: SchedulerRole;
  /** planning = precisa do texto de volta (síncrono); dispatch = fire-and-report. */
  kind: "planning" | "dispatch";
  /**
   * Today: the active version's SOUL only (`dispatch.ts` passes `soulMarkdown`).
   * Goose concatenates protocol + overlay in `buildGooseRecipe`; ACP/native append
   * the overlay (not the protocol) on the first turn. Target: one assembler fills
   * this with SOUL + protocol + overlays — see knowledge/product/pipeline-policy-overlay.md.
   */
  systemPrompt: string;
  /** Metadados do papel (title/description/prompt do recipe goose). */
  roleMeta: { title: string; description: string; prompt: string };
  /** Input da task (issueId/mode/linhas extras). */
  promptText: string;
  /** Workspace EFÊMERO exclusivo do run (criado/removido pelo backend). */
  cwd: string;
  mcpServers: McpServerConfig[];
  model?: string;
  /**
   * Orchestrator em planning/merge: adapters ACP priorizam modelos com
   * `fast=true` quando a lista do harness expõe essa opção.
   */
  preferFast?: boolean;
  /** settingsJson do harness neste agente, decifrado. */
  settings: Record<string, unknown>;
  /** Ambiente base (process.env + extras) — o adapter acrescenta o que precisar. */
  env: Record<string, string>;
  /** §7.6: retomar a sessão anterior DA MESMA issue NO MESMO harness. */
  resumeSessionId?: string;
  onEvent(evt: NormalizedEvent): void;
}

export interface HarnessResult {
  outputText: string;
  stopReason?: string;
  usage?: HarnessUsage;
  /** Id da sessão na ferramenta (resume §7.6 + refs externas §7.5). */
  sessionId?: string;
  /** Ids/paths pra achar a conversa no histórico da ferramenta. */
  externalRefs?: Record<string, string>;
  /** Hermes fire-and-report termina "dispatched", não "completed". */
  finalStatus?: "completed" | "dispatched";
}

export interface HarnessRun {
  result: Promise<HarnessResult>;
  kill(): void;
}

export interface HarnessAdapter {
  id: HarnessId;
  label: string;
  capabilities: HarnessCapabilities;
  detect(): Promise<HarnessDetection>;
  /**
   * Sonda a lista de modelos aceitos (só quando
   * `capabilities.modelSelection === "list"`). Custa um spawn do CLI, mas NÃO
   * gasta token: em ACP a lista vem na resposta do `session/new`, sem prompt.
   */
  listModels?(): Promise<{ models: HarnessModelInfo[]; defaultModelId?: string }>;
  createRun(input: HarnessRunInput): HarnessRun;
}
