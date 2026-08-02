// Budgets por harness (§7.4/§7.9): limite diário/semanal/mensal em USD
// (quando costSource=api) ou TOKENS como proxy (quando subscription), com
// ação `avisar` (notificação, Fase 3) ou `pausar` (dispatches desse harness
// ficam em espera — a issue NÃO é movida, só não despacha, igual seat cheio).
import { appDb } from "../../db";
import { activeAgentForRole } from "../../db/agents";
import type { SchedulerRole } from "../recipe/defaults";
import { getBudgets } from "./detect";
import { harnessAdapter, HARNESS_ADAPTERS } from "./registry";
import type { HarnessId } from "./types";

const WINDOW_MS = { daily: 24 * 3_600_000, weekly: 7 * 24 * 3_600_000, monthly: 30 * 24 * 3_600_000 } as const;

function windowSpend(harnessId: HarnessId, sinceMs: number, unit: "usd" | "tokens"): number {
  const { sqlite } = appDb();
  // Queries fixas (sem interpolar identificadores) — unit só escolhe qual
  // statement pré-escrito rodar.
  const row =
    unit === "usd"
      ? (sqlite
          .query(
            `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE harness_id = $harnessId AND started_at >= $since`
          )
          .get({ $harnessId: harnessId, $since: sinceMs }) as { total: number })
      : (sqlite
          .query(
            `SELECT COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) AS total FROM runs WHERE harness_id = $harnessId AND started_at >= $since`
          )
          .get({ $harnessId: harnessId, $since: sinceMs }) as { total: number });
  return row.total;
}

export interface BudgetStatus {
  harnessId: HarnessId;
  exceeded: boolean;
  action: "avisar" | "pausar";
  unit: "usd" | "tokens";
  window?: "daily" | "weekly" | "monthly";
  spend?: number;
  limit?: number;
}

export function checkBudget(harnessId: HarnessId): BudgetStatus {
  const budgets = getBudgets(harnessId);
  const unit = HARNESS_ADAPTERS[harnessId].capabilities.costSource === "api" ? "usd" : "tokens";
  const now = Date.now();

  const checks: Array<["daily" | "weekly" | "monthly", number | undefined]> = [
    ["daily", budgets.dailyLimit],
    ["weekly", budgets.weeklyLimit],
    ["monthly", budgets.monthlyLimit],
  ];
  for (const [window, limit] of checks) {
    if (!limit) continue;
    const spend = windowSpend(harnessId, now - WINDOW_MS[window], unit);
    if (spend >= limit) {
      return { harnessId, exceeded: true, action: budgets.action, unit, window, spend, limit };
    }
  }
  return { harnessId, exceeded: false, action: budgets.action, unit };
}

/** true = dispatches deste harness devem ESPERAR (ação pausar + budget estourado). */
export function isHarnessPaused(harnessId: HarnessId): boolean {
  const status = checkBudget(harnessId);
  return status.exceeded && status.action === "pausar";
}

/**
 * Gate do scheduler (§7.4): o harness ATIVO do papel está com budget estourado
 * + ação `pausar`? Se sim, o tick NÃO deve mover a issue — igual seat cheio /
 * footprint collision. Checar AQUI (antes de moveState/acquireLock), não só
 * dentro de runDispatch (que já é tarde demais: a issue já teria sido movida).
 *
 * Sem agente ativo → false (o dispatch falha alto depois com HarnessNotReadyError
 * por falta de agente — não confundir com pause de budget).
 */
export function isActiveHarnessPausedForRole(role: SchedulerRole): boolean {
  const active = activeAgentForRole(role);
  if (!active) return false;
  if (!harnessAdapter(active.harnessId)) return false;
  return isHarnessPaused(active.harnessId as HarnessId);
}

export function budgetBanners(): BudgetStatus[] {
  return (Object.keys(HARNESS_ADAPTERS) as HarnessId[]).map(checkBudget).filter((s) => s.exceeded);
}
