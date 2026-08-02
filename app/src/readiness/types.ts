/** Fase do pipeline refletida na tela de prontidão (não é status Linear). */
export type ReadinessPhase = "refine" | "implement" | "review" | "merge" | "blocked";

/**
 * Status agregado da candidata — a UI usa isto pra badge/ordenação.
 * Motivos tipados ficam em `reasons` (pode haver mais de um).
 */
export type ReadinessStatus =
  | "ready"
  | "waiting_capacity"
  | "blocked_by_rule"
  | "estimating"
  | "waiting_human";

export type ReadinessReasonCode =
  | "ready"
  | "no_capacity"
  | "missing_label"
  | "deps_unsatisfied"
  | "footprint_collision"
  | "estimating_footprint"
  | "budget_paused"
  | "lock_held"
  | "circuit_breaker"
  | "merge_mutex_held"
  | "orchestrator_workers_disabled"
  | "missing_pr"
  | "unauthorized_repo"
  | "waiting_human";

export interface ReadinessDep {
  /** UUID Linear da issue (`issue.id`). */
  issueId: string;
  /** Identifier amigável Linear (ex.: ENG-123). */
  identifier: string;
  stateName: string;
}

/** Colisão de footprint com outra issue que ainda segura lock ativo. */
export interface ReadinessCollision {
  /** UUID Linear da issue que segura o lock. */
  issueId: string;
  /** Identifier amigável Linear (ex.: ENG-120); fallback = UUID completo se a API falhar. */
  identifier: string;
  stateName: string | null;
  /** Entradas de footprint que colidem (formato `repo:path` ou legado sem repo). */
  overlappingEntries: { ours: string; theirs: string }[];
}

export interface ReadinessReason {
  code: ReadinessReasonCode;
  /** Texto curto em PT-BR pra UI (já resolvido — o client não traduz enums). */
  detail: string;
  label?: string;
  deps?: ReadinessDep[];
  /** @deprecated preferir `collisions` — mantido pra compat. */
  collidingIssueIds?: string[];
  collisions?: ReadinessCollision[];
  attempts?: number;
  maxAttempts?: number;
  /** UUID Linear da issue que segura o mutex de merge. */
  mergingIssueId?: string | null;
  /** Identifier amigável da issue no mutex de merge, quando resolvido. */
  mergingIssueIdentifier?: string | null;
  prOwner?: string;
}

export interface ReadinessIssue {
  issueId: string;
  identifier: string;
  title: string;
  stateName: string;
  phase: ReadinessPhase;
  status: ReadinessStatus;
  reasons: ReadinessReason[];
  /** Reopened tem prioridade sobre Planned no pick Dev. */
  tier: "reopened" | "planned" | null;
  attempts: number;
  maxAttempts: number;
  hasFootprint: boolean;
  hasLock: boolean;
  /** Comentário recente relevante (Blocked) — markdown truncado. */
  blockedComment: string | null;
}

export interface ReadinessSeatCapacity {
  occupied: number;
  max: number;
  free: number;
}

export interface ReadinessSnapshot {
  updatedAt: number;
  connectionId: string;
  connectionName: string;
  organizationId: string;
  organizationKey: string | null;
  capacity: {
    refine: ReadinessSeatCapacity;
    implement: ReadinessSeatCapacity;
    review: ReadinessSeatCapacity;
    merge: {
      max: number;
      busy: boolean;
      mergingIssueId: string | null;
    };
  };
  flags: {
    autoDispatchIssues: boolean;
    autoMergeIssues: boolean;
    orchestratorEnabled: boolean;
  };
  issues: ReadinessIssue[];
}

/** Espelha locks.READINESS_TTL_SECONDS — documentado aqui pro contrato da API. */
export const READINESS_TTL_SECONDS = 15 * 60;
