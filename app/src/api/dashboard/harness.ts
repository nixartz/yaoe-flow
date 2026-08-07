import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody, looseObject } from "../shared/schemas";
import {
  harnessListResponse,
  harnessModelsResponse,
  budgetsBody,
  cursorLoginResponse,
  cursorLoginStatusResponse,
} from "./harness.schema";
import { harnessReport, redetectHarness, detectAllHarnesses, getCachedDetection } from "../../agent/harness/detect";
import { budgetBanners, type BudgetStatus } from "../../agent/harness/budget";
import { listHarnessIds, HARNESS_ADAPTERS } from "../../agent/harness/registry";
import type { HarnessId } from "../../agent/harness/types";
import {
  cancelCursorInteractiveLogin,
  getCursorInteractiveLoginState,
  probeCursorAuthStatus,
  startCursorInteractiveLogin,
} from "../../agent/harness/cursorAuth";
import { settingsReport } from "../../config/service";
import { setBudgets as persistBudgets, type HarnessBudgets } from "../../agent/harness/detect";
import { authUser } from "../../dashboard/auth";
import { log } from "../../logger";

export const harnessRoutes = new Hono();

/** Must match `group` in app/src/config/registry.ts (English names). */
const SETTINGS_GROUP_BY_HARNESS: Record<HarnessId, string[]> = {
  goose: ["Harness Goose / OpenRouter"],
  hermes: ["Harness Hermes"],
  "claude-code": ["Harness Claude Code"],
  codex: ["Harness Codex"],
  cursor: ["Harness Cursor"],
  copilot: [],
};

harnessRoutes.get(
  "/",
  describeRoute({
    tags: ["Harness"],
    summary: "List harnesses with detection, settings and budget banners",
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
    summary: "Re-detect all harnesses",
    responses: { 200: jsonContent(looseObject, "Detecções") },
  }),
  async (c) => {
    const detections = await detectAllHarnesses();
    log.dashboard.info({ by: authUser(c).username }, "harness detect-all requested via dashboard");
    return c.json({ ok: true, detections });
  }
);

harnessRoutes.get(
  "/budget-banners",
  describeRoute({
    tags: ["Harness"],
    summary: "Active budget banners",
    responses: { 200: jsonContent(looseObject, "Banners") },
  }),
  (c) => c.json({ banners: budgetBanners() satisfies BudgetStatus[] })
);

harnessRoutes.post(
  "/cursor/login",
  describeRoute({
    tags: ["Harness"],
    summary: "Start Cursor CLI browserless login (prints a URL to open elsewhere)",
    responses: { 200: jsonContent(cursorLoginResponse, "Login started") },
  }),
  async (c) => {
    const result = await startCursorInteractiveLogin();
    log.dashboard.info(
      { by: authUser(c).username, alreadyLoggedIn: result.alreadyLoggedIn, hasUrl: Boolean(result.url) },
      "cursor interactive login started via dashboard"
    );
    return c.json(result);
  }
);

harnessRoutes.get(
  "/cursor/login",
  describeRoute({
    tags: ["Harness"],
    summary: "Cursor login session + auth probe status",
    responses: { 200: jsonContent(cursorLoginStatusResponse, "Login status") },
  }),
  async (c) => {
    const session = getCursorInteractiveLoginState();
    const auth = await probeCursorAuthStatus();
    return c.json({
      session,
      auth: {
        loggedIn: auth.loggedIn,
        account: auth.account,
        raw: auth.raw.slice(0, 500),
      },
    });
  }
);

harnessRoutes.delete(
  "/cursor/login",
  describeRoute({
    tags: ["Harness"],
    summary: "Cancel an in-progress Cursor CLI login",
    responses: { 200: jsonContent(okBody, "Cancelled") },
  }),
  async (c) => {
    await cancelCursorInteractiveLogin();
    log.dashboard.info({ by: authUser(c).username }, "cursor interactive login cancelled via dashboard");
    return c.json({ ok: true as const });
  }
);

harnessRoutes.get(
  "/:id/models",
  describeRoute({
    tags: ["Harness"],
    summary: "Models accepted by the harness (from the detection cache)",
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
    summary: "Re-detect a specific harness",
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
    summary: "Update harness budgets",
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
