export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat("pt-BR", { notation: n >= 10_000 ? "compact" : "standard" }).format(n);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = Math.round(s % 60);
    return `${m}m${rem ? ` ${rem}s` : ""}`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

export function formatElapsed(startedAt: number, now: number = Date.now()): string {
  return formatDuration(now - startedAt);
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "–";
  return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "–";
  return `US$ ${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export const ROLE_LABEL: Record<string, string> = {
  pmo: "PMO",
  dev: "Dev",
  worker: "Dev",
  "senior-engineer": "Dev",
  reviewer: "Reviewer",
  orchestrator: "Orchestrator",
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** Operação do run em linguagem de produto (sem enum cru). */
export function operationLabel(operation: string | null | undefined): string {
  if (!operation) return "—";
  const map: Record<string, string> = {
    refine: "Refinar",
    implement: "Implementar",
    fix: "Corrigir",
    review: "Revisar",
    merge: "Merge",
    plan_footprint: "Planejar footprint",
    dispatch: "Despacho",
  };
  return map[operation] ?? operation;
}

export const HARNESS_OPTIONS = [
  { value: "goose", label: "Goose" },
  { value: "hermes", label: "Hermes" },
  { value: "cursor", label: "Cursor" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "Copilot" },
] as const;

export function harnessLabel(id: string | null | undefined): string {
  if (!id) return "—";
  const found = HARNESS_OPTIONS.find((h) => h.value === id);
  return found?.label ?? id;
}

/** Harness efetivo do run (snapshot → backend legado). */
export function runHarnessId(run: {
  harness_id?: string | null;
  backend?: string | null;
}): string | null {
  return run.harness_id ?? run.backend ?? null;
}

/**
 * Harness de assinatura (CLI pessoal) — o campo `provider` no run muitas vezes
 * vem das settings do agente (ex.: "openrouter") e NÃO reflete a cobrança real.
 * Nesses casos a UI não deve exibir o provider como badge de billing.
 */
export function isSubscriptionBilling(run: {
  cost_source?: string | null;
  harness_id?: string | null;
  backend?: string | null;
}): boolean {
  if (run.cost_source === "subscription") return true;
  if (run.cost_source === "api") return false;
  const id = runHarnessId(run);
  return id === "cursor" || id === "copilot";
}

/**
 * Label curto provider/modelo pra badges — omite provider enganoso em
 * harness de assinatura (mostra só o modelo, se houver).
 */
export function runModelBadgeLabel(run: {
  provider?: string | null;
  model?: string | null;
  cost_source?: string | null;
  harness_id?: string | null;
  backend?: string | null;
}): string | null {
  if (isSubscriptionBilling(run)) {
    const m = run.model?.trim();
    return m || null;
  }
  const parts = [run.provider, run.model].filter((p): p is string => !!p?.trim());
  return parts.length ? parts.join(" · ") : null;
}

export function roleColorVar(role: string): string {
  if (role === "pmo") return "var(--role-pmo)";
  if (role === "reviewer") return "var(--role-reviewer)";
  if (role === "orchestrator") return "var(--role-orchestrator)";
  return "var(--role-worker)"; // worker / senior-engineer / dev
}
