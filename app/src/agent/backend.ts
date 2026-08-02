// ─────────────────────────────────────────────────────────────────────────
// AgentBackend — a fronteira entre o orchestrator e o "cérebro" que executa.
//
// O scheduler fala SÓ com esta interface; quem dispara o trabalho (Hermes,
// Goose, ou um backend futuro) é detalhe de implementação escolhido por
// `AGENT_BACKEND`. Trocar de backend = trocar a implementação, nada no
// scheduler muda. Cada papel do pipeline (pmo/worker/reviewer/orchestrator)
// vira um "perfil" (Hermes) ou "recipe" (Goose) com a respectiva SOUL.
// ─────────────────────────────────────────────────────────────────────────
import { config } from "../config";
import type { Footprint, WorkerMode } from "../types";

export interface AgentBackend {
  /** Nome do backend ativo (aparece nos logs e no /health). */
  readonly name: string;

  /** SÍNCRONO: estima o footprint ANTES de despachar (p/ checar colisão). */
  estimateFootprint(issueId: string): Promise<Footprint>;

  /** FIRE-AND-REPORT: o agent roda e ele mesmo atualiza o status no Linear. */
  dispatchRefine(issueId: string): Promise<void>;
  /**
   * `pendingMergeIssues`: identifiers das issues paradas em Pending Merge no
   * momento do despacho (PRs aprovadas aguardando merge — acumulam sobretudo
   * com AUTO_MERGE_ISSUES=false). Vira a linha `pendingMergeIssues:` do input;
   * a SOUL do worker é obrigada a checar sobreposição com essas PRs antes de
   * criar branch — se houver, empilha na branch pendente em vez da main.
   */
  dispatchWorker(issueId: string, mode: WorkerMode, pendingMergeIssues?: string[]): Promise<void>;
  dispatchReviewer(issueId: string): Promise<void>;
  dispatchMerge(issueId: string): Promise<void>;

  /**
   * Opcional: encerra o processo do run em voo (dashboard "pausar/encerrar").
   * Só o backend Goose implementa (processo local, `Bun.spawn` por dispatch);
   * Hermes não tem processo para matar (o agent roda na infra do Hermes).
   * Retorna false se o runId não corresponde a um processo ativo.
   */
  cancelRun?(runId: string): boolean;
}

// Linha extra do input de despacho com as orgs/owners autorizados (fail-safe
// anti-fork/repo-errado). Vazio quando AGENT_AUTHORIZED_ORGS não está setado —
// nesse caso o único limite é o repositório que a própria issue declara.
// Repassada a pmo/worker/merge (quem lê/escreve footprint ou toca git) para que a
// SOUL possa se recusar a operar fora da lista mesmo antes do scope-check do
// serviço rodar (defesa em profundidade — ver protocolo §10.3).
export function authorizedOrgsLine(): string {
  const orgs = config.security.authorizedOrgs;
  return orgs.length ? `\nauthorizedOrgs: ${orgs.join(",")}` : "";
}

/** Concatena linhas opcionais de contexto de despacho (orgs, Linear hints, …). */
export function joinDispatchLines(...parts: (string | Promise<string> | undefined)[]): Promise<string> {
  return Promise.all(parts.map((p) => Promise.resolve(p ?? ""))).then((xs) => xs.join(""));
}

// Linha extra do input do WORKER com as issues em Pending Merge no momento do
// despacho. Omitida quando vazia. Ver o comentário em dispatchWorker acima.
export function pendingMergeLine(ids: string[] | undefined): string {
  return ids && ids.length ? `\npendingMergeIssues: ${ids.join(",")}` : "";
}

// Extrai o JSON do footprint do texto do agent. Tolerante a texto ao redor
// (o agent às vezes embrulha o JSON em explicação) — pega o primeiro objeto
// `{ … }` e lê `footprint`. Lança em parse inválido; o caller decide o fallback.
export function extractFootprint(out: string): Footprint {
  const match = out.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : out) as { footprint?: Footprint };
  return parsed.footprint ?? ["*"];
}
