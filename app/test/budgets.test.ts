// §9.3: janelas diária/semanal/mensal e ações avisar/pausar dos budgets por
// harness (§7.4). Popula `runs` diretamente (bun:sqlite) pra simular gasto
// dentro/fora da janela, sem depender de um harness real.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appDb } from "../src/db";
import { createAgent, listAgents } from "../src/db/agents";
import { setBudgets } from "../src/agent/harness/detect";
import { checkBudget, isActiveHarnessPausedForRole, isHarnessPaused } from "../src/agent/harness/budget";

function insertRun(harnessId: string, costUsd: number, startedAgoMs: number): void {
  const { sqlite } = appDb();
  sqlite
    .query(
      `INSERT INTO runs (id, backend, operation, role, status, harness_id, cost_usd, started_at)
       VALUES ($id, $harnessId, 'dispatchWorker', 'worker', 'completed', $harnessId, $cost, $started)`
    )
    .run({ $id: randomUUID(), $harnessId: harnessId, $cost: costUsd, $started: Date.now() - startedAgoMs });
}

const H = 3_600_000;

describe("budgets por harness (§7.4)", () => {
  test("sem limite configurado, nunca excede", () => {
    insertRun("goose", 999, 1_000);
    const status = checkBudget("goose");
    expect(status.exceeded).toBe(false);
  });

  test("janela diária: gasto dentro das últimas 24h conta; fora não conta", () => {
    setBudgets("claude-code", { dailyLimit: 10, unit: "usd", action: "avisar" });
    insertRun("claude-code", 6, 2 * H); // dentro da janela
    insertRun("claude-code", 100, 30 * H); // fora da janela (>24h atrás)
    expect(checkBudget("claude-code").exceeded).toBe(false); // 6 < 10

    insertRun("claude-code", 5, 1 * H); // 6+5=11 >= 10
    const status = checkBudget("claude-code");
    expect(status.exceeded).toBe(true);
    expect(status.window).toBe("daily");
    expect(status.spend).toBeCloseTo(11);
  });

  test("ação avisar: excedido mas NÃO pausa dispatches", () => {
    setBudgets("codex", { dailyLimit: 1, unit: "usd", action: "avisar" });
    insertRun("codex", 5, 1_000);
    expect(checkBudget("codex").exceeded).toBe(true);
    expect(isHarnessPaused("codex")).toBe(false);
  });

  test("ação pausar: excedido E pausa dispatches (isHarnessPaused=true)", () => {
    // cursor tem costSource=subscription → checkBudget usa TOKENS como
    // unidade (ignora o `unit` pedido — nunca estima custo de assinatura).
    setBudgets("cursor", { dailyLimit: 100, unit: "tokens", action: "pausar" });
    const { sqlite } = appDb();
    sqlite
      .query(
        `INSERT INTO runs (id, backend, operation, role, status, harness_id, input_tokens, output_tokens, started_at)
         VALUES ($id, 'cursor', 'dispatchWorker', 'worker', 'completed', 'cursor', 80, 30, $started)`
      )
      .run({ $id: randomUUID(), $started: Date.now() - 1_000 });
    expect(checkBudget("cursor").exceeded).toBe(true);
    expect(isHarnessPaused("cursor")).toBe(true);
  });

  test("harness de assinatura (costSource=subscription) usa TOKENS como unidade, não USD", () => {
    setBudgets("copilot", { dailyLimit: 1000, unit: "tokens", action: "avisar" });
    const { sqlite } = appDb();
    sqlite
      .query(
        `INSERT INTO runs (id, backend, operation, role, status, harness_id, input_tokens, output_tokens, started_at)
         VALUES ($id, 'copilot', 'dispatchWorker', 'worker', 'completed', 'copilot', 600, 500, $started)`
      )
      .run({ $id: randomUUID(), $started: Date.now() - 1_000 });
    const status = checkBudget("copilot");
    expect(status.unit).toBe("tokens");
    expect(status.exceeded).toBe(true); // 600+500=1100 >= 1000
  });

  test("janela semanal/mensal: só a janela configurada é checada", () => {
    setBudgets("hermes", { weeklyLimit: 20, unit: "usd", action: "avisar" });
    insertRun("hermes", 25, 3 * 24 * H); // dentro de 7 dias, fora de 24h
    const status = checkBudget("hermes");
    expect(status.exceeded).toBe(true);
    expect(status.window).toBe("weekly");
  });

  test("isActiveHarnessPausedForRole: gate do scheduler — pausar no harness ATIVO do papel", () => {
    // Sem agente ativo pro papel → não é pause de budget (dispatch falha depois).
    expect(isActiveHarnessPausedForRole("dev")).toBe(false);

    // Garante um worker ativo no harness goose (seed dos testes não cria agents).
    if (!listAgents().some((a) => a.role === "dev" && a.isActive === 1)) {
      createAgent({
        role: "dev",
        name: "worker-budget-gate",
        soulMarkdown: "# soul",
        comment: "test budget gate",
        harnessId: "goose",
        activate: true,
      });
    }

    setBudgets("goose", { dailyLimit: 1, unit: "usd", action: "pausar" });
    insertRun("goose", 5, 1_000);
    expect(isHarnessPaused("goose")).toBe(true);
    expect(isActiveHarnessPausedForRole("dev")).toBe(true);

    // Ação avisar NÃO pausa o papel (só notifica).
    setBudgets("goose", { dailyLimit: 1, unit: "usd", action: "avisar" });
    expect(isActiveHarnessPausedForRole("dev")).toBe(false);
  });
});
