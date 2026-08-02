import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody, idParam, looseObject } from "../shared/schemas";
import { harnessListResponse, harnessModelsResponse, budgetsBody } from "./harness.schema";
import { harnessReport, redetectHarness, detectAllHarnesses, getCachedDetection } from "../../agent/harness/detect";
import { budgetBanners, type BudgetStatus } from "../../agent/harness/budget";
import { listHarnessIds, HARNESS_ADAPTERS } from "../../agent/harness/registry";
import type { HarnessId } from "../../agent/harness/types";
import { settingsReport } from "../../config/service";
import { setBudgets as persistBudgets, type HarnessBudgets } from "../../agent/harness/detect";
import { authUser } from "../../dashboard/auth";
import { log } from "../../logger";

export const harnessRoutes = new Hono();

const SETTINGS_GROUP_BY_HARNESS: Record<HarnessId, string[]> = {
  goose: ["Harness Goose / OpenRouter (migra pra tela Harness — Fase 2)"],
  hermes: ["Harness Hermes (migra pra tela Harness — Fase 2)"],
  "claude-code": [],
  codex: [],
  cursor: [],
  copilot: [],
};

harnessRoutes.get(
  "/",
  describeRoute({
    tags: ["Harness"],
    summary: "Lista harnesses com detecção, settings e banners de budget",
    responses: { 200: jsonContent(harnessListResponse, "Harnesses") },
  }),
  (c) => {
    const settingsGroups = settingsReport();
    const report = harnessReport().map((h) => ({
      ...h,
      settings: settingsGroups
        .filter((g) => SETTINGS_GROUP_BY_HARNESS[h.id]?.includes(g.group))
        .flatMap((g) => g.entries),
    }));
    return c.json({ harnesses: report, banners: budgetBanners() });
  }
);

harnessRoutes.post(
  "/detect-all",
  describeRoute({
    tags: ["Harness"],
    summary: "Re-detecta todos os harnesses",
    responses: { 200: jsonContent(looseObject, "Detecções") },
  }),
  async (c) => {
    const detections = await detectAllHarnesses();
    log.dashboard.info({ by: authUser(c).username }, "harness detect-all requested via dashboard");
    return c.json({ ok: true, detections });
  }
);

harnessRoutes.get(
  "/:id/models",
  describeRoute({
    tags: ["Harness"],
    summary: "Modelos aceitos pelo harness (do cache da detecção)",
    responses: {
      200: jsonContent(harnessModelsResponse, "Modelos"),
      404: jsonContent(errorBody, "Harness desconhecido"),
    },
  }),
  (c) => {
    const id = c.req.param("id") as HarnessId;
    if (!listHarnessIds().includes(id)) return c.json({ error: "harness desconhecido" }, 404);
    const detection = getCachedDetection(id);
    return c.json({
      harnessId: id,
      modelSelection: HARNESS_ADAPTERS[id].capabilities.modelSelection,
      models: detection?.models ?? [],
      defaultModelId: detection?.defaultModelId,
      checkedAt: detection?.checkedAt,
    });
  }
);

harnessRoutes.post(
  "/:id/redetect",
  describeRoute({
    tags: ["Harness"],
    summary: "Re-detecta um harness específico",
    responses: {
      200: jsonContent(looseObject, "Detecção atualizada"),
      404: jsonContent(errorBody, "Harness desconhecido"),
    },
  }),
  async (c) => {
    const id = c.req.param("id") as HarnessId;
    if (!listHarnessIds().includes(id)) return c.json({ error: "harness desconhecido" }, 404);
    const detection = await redetectHarness(id);
    log.dashboard.info({ harness: id, by: authUser(c).username }, "harness redetect requested via dashboard");
    return c.json({ ok: true, detection });
  }
);

harnessRoutes.put(
  "/:id/budgets",
  describeRoute({
    tags: ["Harness"],
    summary: "Atualiza budgets do harness",
    responses: {
      200: jsonContent(okBody.extend({ budgets: looseObject }), "Budgets atualizados"),
      404: jsonContent(errorBody, "Harness desconhecido"),
    },
  }),
  validator("json", budgetsBody),
  async (c) => {
    const id = c.req.param("id") as HarnessId;
    if (!listHarnessIds().includes(id)) return c.json({ error: "harness desconhecido" }, 404);
    const body = c.req.valid("json");
    const budgets: HarnessBudgets = {
      dailyLimit: typeof body.dailyLimit === "number" ? body.dailyLimit : undefined,
      weeklyLimit: typeof body.weeklyLimit === "number" ? body.weeklyLimit : undefined,
      monthlyLimit: typeof body.monthlyLimit === "number" ? body.monthlyLimit : undefined,
      unit: body.unit === "tokens" ? "tokens" : "usd",
      action: body.action === "pausar" ? "pausar" : "avisar",
    };
    persistBudgets(id, budgets);
    log.dashboard.info({ harness: id, budgets, by: authUser(c).username }, "harness budgets updated via dashboard");
    return c.json({ ok: true as const, budgets });
  }
);

harnessRoutes.get(
  "/budget-banners",
  describeRoute({
    tags: ["Harness"],
    summary: "Banners de budget ativos",
    responses: { 200: jsonContent(looseObject, "Banners") },
  }),
  (c) => c.json({ banners: budgetBanners() satisfies BudgetStatus[] })
);
