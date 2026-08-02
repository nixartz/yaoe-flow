// Remapeamento UI das settings: categorias amigáveis + labels humanas.
// A API continua devolvendo group/key crus — só a apresentação muda.
import type { SettingEntry, SettingGroup } from "@/lib/api";

export interface UiCategory {
  id: string;
  label: string;
  description?: string;
  /** Se true, categoria começa colapsada / só leitura. */
  readOnlySection?: boolean;
}

export const UI_CATEGORIES: UiCategory[] = [
  { id: "service", label: "Operação do serviço", description: "Liga/desliga o orquestrador, intervalo do ciclo e logs." },
  { id: "capacity", label: "Capacidade", description: "Quantos agentes de cada papel podem rodar ao mesmo tempo." },
  { id: "reliability", label: "Automação e confiabilidade", description: "Timeouts, tentativas e despacho/merge automáticos." },
  { id: "linear", label: "Integração Linear", description: "Credenciais e time padrão (quando não há conexão dedicada)." },
  { id: "labels", label: "Gates e labels", description: "Labels que liberam refino, implementação e merge." },
  { id: "states", label: "Estados do fluxo", description: "Nomes exatos dos status no seu workspace Linear." },
  { id: "github", label: "GitHub e segurança", description: "Token e orgs autorizadas." },
  { id: "dashboard", label: "Retenção da dashboard", description: "Por quanto tempo runs, eventos e logs ficam guardados." },
  {
    id: "harness",
    label: "Harness (avançado)",
    description:
      "Parâmetros globais de Goose, Hermes, Cursor, Claude Code e Codex (inclui atribuição/co-autoria em commits e PRs). Prefira a tela Harness quando possível.",
  },
  {
    id: "readonly",
    label: "Somente leitura / legado",
    description: "Valores definidos só no ambiente, seeds de agentes e opções deprecadas.",
    readOnlySection: true,
  },
];

const GROUP_TO_CATEGORY: Record<string, string> = {
  "Bootstrap (somente ENV)": "readonly",
  Serviço: "service",
  Linear: "linear",
  "GitHub & segurança": "github",
  Capacidade: "capacity",
  "Confiabilidade & merge": "reliability",
  "Labels de curadoria": "labels",
  "Estados do Linear": "states",
  Dashboard: "dashboard",
  "Backend de agents (legacy)": "harness",
  "Harness Goose / OpenRouter (migra pra tela Harness — Fase 2)": "harness",
  "Harness Hermes (migra pra tela Harness — Fase 2)": "harness",
  "Harness Cursor": "harness",
  "Harness Claude Code": "harness",
  "Harness Codex": "harness",
  "Agentes por papel (migra pra entidade Agent — Fase 1)": "readonly",
  Deprecadas: "readonly",
};

export function categoryForGroup(group: string): string {
  return GROUP_TO_CATEGORY[group] ?? "readonly";
}

const LABEL_OVERRIDES: Record<string, string> = {
  ORCHESTRATOR_ENABLED: "Orquestrador ligado",
  TICK_INTERVAL_MS: "Intervalo do ciclo",
  HTTP_TIMEOUT_MS: "Timeout das requisições HTTP",
  LOG_LEVEL: "Nível de log",
  LINEAR_API_KEY: "Chave da API Linear",
  LINEAR_TEAM_ID: "ID do time Linear",
  LINEAR_TEAM_KEY: "Prefixo do time (ex.: ENG)",
  LINEAR_WEBHOOK_SECRET: "Segredo do webhook Linear",
  GITHUB_TOKEN: "Token do GitHub",
  AGENT_AUTHORIZED_ORGS: "Orgs GitHub autorizadas",
  MAX_PMO_WORKERS: "Limite de agentes PMO",
  MAX_DEV_WORKERS: "Limite de agentes Dev",
  MAX_REVIEWER_WORKERS: "Limite de agentes Reviewer",
  MAX_ORCHESTRATOR_WORKERS: "Limite de agentes Orchestrator",
  MAX_ATTEMPTS: "Tentativas antes de bloquear",
  REFINING_TIMEOUT_MS: "Timeout de inatividade (refino)",
  IN_PROGRESS_TIMEOUT_MS: "Timeout de inatividade (implementação)",
  IN_REVIEW_TIMEOUT_MS: "Timeout de inatividade (review)",
  MERGE_TIMEOUT_MS: "Timeout de inatividade (merge)",
  AUTO_MERGE_ISSUES: "Merge automático sem label de liberação",
  AUTO_DISPATCH_ISSUES: "Despachar refino/implementação sem label",
  LABEL_READY_TO_REFINE: "Label: liberar refino",
  LABEL_READY_TO_IMPLEMENT: "Label: liberar implementação",
  LABEL_READY_TO_MERGE: "Label: liberar merge",
  STATE_TODO: "Status: fila de refino",
  STATE_REFINING: "Status: refinando",
  STATE_PLANNED: "Status: planejado",
  STATE_IN_PROGRESS: "Status: em progresso",
  STATE_CODE_REVIEW: "Status: aguardando review",
  STATE_IN_REVIEW: "Status: em review",
  STATE_PENDING_MERGE: "Status: aguardando merge",
  STATE_REOPENED: "Status: reaberto",
  STATE_COMPLETED: "Status: concluído",
  STATE_BLOCKED: "Status: bloqueado",
  DASHBOARD_RUN_RETENTION_DAYS: "Retenção de execuções (dias)",
  DASHBOARD_WEBHOOK_RETENTION_DAYS: "Retenção de eventos Linear (dias)",
  DASHBOARD_LOG_RETENTION_DAYS: "Retenção de logs (dias)",
  DASHBOARD_RETENTION_SWEEP_INTERVAL_MS: "Intervalo da limpeza automática",
  DASHBOARD_LOG_BUFFER_SIZE: "Buffer de logs em memória",
  AGENT_BACKEND: "Backend legado de agents",
  CURSOR_ISOLATE_MCP_CONFIG: "Isolar MCPs e git do Cursor por run",
  CURSOR_ATTRIBUTION: "Adicionar atribuição e co-autoria do Cursor nos commits e PRs",
  CLAUDE_CODE_ATTRIBUTION: "Adicionar atribuição e co-autoria do Claude Code nos commits e PRs",
  CODEX_ATTRIBUTION: "Adicionar atribuição e co-autoria do Codex nos commits e PRs",
};

export function settingLabel(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  // Fallback: tira prefixo comum e humaniza
  return key
    .replace(/^GOOSE_|^HERMES_|^OPENROUTER_|^DASHBOARD_|^STATE_|^LABEL_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export const ENUM_LABELS: Record<string, Record<string, string>> = {
  LOG_LEVEL: {
    trace: "Trace",
    debug: "Debug",
    info: "Informação",
    warn: "Aviso",
    error: "Erro",
    fatal: "Fatal",
  },
  AGENT_BACKEND: {
    hermes: "Hermes",
    goose: "Goose",
  },
};

export function entriesByCategory(groups: SettingGroup[]): Map<string, SettingEntry[]> {
  const map = new Map<string, SettingEntry[]>();
  for (const cat of UI_CATEGORIES) map.set(cat.id, []);
  for (const g of groups) {
    const catId = categoryForGroup(g.group);
    const list = map.get(catId) ?? [];
    list.push(...g.entries);
    map.set(catId, list);
  }
  return map;
}

/** Converte ms ↔ unidade amigável pra UI. */
export function msToUi(ms: number): { value: number; unit: "s" | "min" | "h" } {
  if (ms < 60_000) return { value: Math.round(ms / 1000), unit: "s" };
  if (ms < 3_600_000) return { value: Math.round(ms / 60_000), unit: "min" };
  return { value: Math.round(ms / 3_600_000), unit: "h" };
}

export function uiToMs(value: number, unit: "s" | "min" | "h"): number {
  if (unit === "s") return value * 1000;
  if (unit === "min") return value * 60_000;
  return value * 3_600_000;
}

export function unitLabel(unit: "s" | "min" | "h"): string {
  if (unit === "s") return "segundos";
  if (unit === "min") return "minutos";
  return "horas";
}
