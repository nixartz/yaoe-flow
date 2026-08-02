import type { ReadinessReason, ReadinessReasonCode, ReadinessStatus } from "./types";

/** Prioridade do status agregado (menor = mais “travado”). */
export function statusRank(s: ReadinessStatus): number {
  switch (s) {
    case "waiting_human":
      return 0;
    case "blocked_by_rule":
      return 1;
    case "estimating":
      return 2;
    case "waiting_capacity":
      return 3;
    case "ready":
      return 4;
  }
}

export function deriveStatus(reasons: ReadinessReason[]): ReadinessStatus {
  const codes = new Set(reasons.map((r) => r.code));
  if (codes.has("waiting_human")) return "waiting_human";
  const hard: ReadinessReasonCode[] = [
    "missing_label",
    "deps_unsatisfied",
    "footprint_collision",
    "budget_paused",
    "lock_held",
    "circuit_breaker",
    "merge_mutex_held",
    "orchestrator_workers_disabled",
    "missing_pr",
    "unauthorized_repo",
  ];
  if (hard.some((c) => codes.has(c))) return "blocked_by_rule";
  if (codes.has("estimating_footprint")) return "estimating";
  if (codes.has("no_capacity")) return "waiting_capacity";
  return "ready";
}

/**
 * Score de um comentário pra explicar Blocked.
 * Prioriza o MOTIVO da parada (circuit breaker, fora do footprint, 🙋),
 * não o último “Retry N/M” de um ciclo anterior.
 */
export function scoreBlockedComment(body: string, index: number, total: number): number {
  // Recência leve: Linear costuma devolver mais antigos primeiro.
  let score = index * 2;
  // Últimos 20% da lista ganham um empurrão (costuma ser o comentário de Blocked).
  if (total > 0 && index >= Math.floor(total * 0.8)) score += 50;

  if (/Circuit breaker/i.test(body)) score += 10_000;
  if (/fora do footprint|Arquivos fora do footprint|footprint declarado|Scope-check/i.test(body)) {
    score += 8_000;
  }
  if (/🙋|decisão humana|Pausando para decisão|aguardando (resposta|humano)/i.test(body)) {
    score += 7_000;
  }
  if (/repositório.*não está.*AGENT_AUTHORIZED|organizações autorizadas/i.test(body)) {
    score += 7_500;
  }
  // Retry é ruído quando o motivo real veio depois (scope-check / circuit breaker).
  if (/Retry\s+\d+\/\d+|re-despachando para correção/i.test(body)) {
    score -= 5_000;
  }
  if (/Orchestrator|yaoe-flow/i.test(body)) score += 200;
  return score;
}

/** Pega o comentário que melhor explica por que a issue está Blocked. */
export function pickBlockedComment(bodies: string[]): string | null {
  if (bodies.length === 0) return null;
  const scored = bodies.map((body, idx) => ({
    body,
    score: scoreBlockedComment(body, idx, bodies.length),
  }));
  scored.sort((a, b) => b.score - a.score);
  const raw = scored[0]?.body?.trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^🤖\s*\*\*Orchestrator\*\*[^\n]*\n+/u, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 720 ? `${cleaned.slice(0, 717)}…` : cleaned;
}
