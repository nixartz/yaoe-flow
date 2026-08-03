import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody, keyParam, looseObject } from "../shared/schemas";
import { settingValueBody } from "./settings.schema";
import { settingsReport, setSetting, resetSetting, resolveSetting, SettingWriteError } from "../../config/service";
import { SETTINGS_REGISTRY } from "../../config/registry";
import { listTeamStateNames, listTeamLabelNames, organizationUrlKey } from "../../linear";
import { authUser } from "../../dashboard/auth";
import { log, errFields } from "../../logger";

export const settingsRoutes = new Hono();

settingsRoutes.get(
  "/settings",
  describeRoute({
    tags: ["Settings"],
    summary: "Registry completo de settings (grupos, valores efetivos, origens)",
    responses: { 200: jsonContent(looseObject, "Settings") },
  }),
  (c) => c.json({ groups: settingsReport() })
);

settingsRoutes.put(
  "/settings/:key",
  describeRoute({
    tags: ["Settings"],
    summary: "Grava setting no banco",
    responses: {
      200: jsonContent(okBody.extend({ groups: looseObject }), "Salvo"),
      400: jsonContent(errorBody, "Erro de validação"),
    },
  }),
  validator("param", keyParam),
  validator("json", settingValueBody),
  async (c) => {
    const { key } = c.req.valid("param");
    const { value } = c.req.valid("json");
    try {
      setSetting(key, value, authUser(c).id);
    } catch (e) {
      if (e instanceof SettingWriteError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
    log.dashboard.info({ key, user: authUser(c).username }, "setting updated via dashboard");
    return c.json({ ok: true as const, groups: settingsReport() });
  }
);

settingsRoutes.delete(
  "/settings/:key",
  describeRoute({
    tags: ["Settings"],
    summary: "Reseta setting pro default (remove do banco)",
    responses: {
      200: jsonContent(okBody.extend({ groups: looseObject }), "Resetado"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", keyParam),
  (c) => {
    const { key } = c.req.valid("param");
    try {
      resetSetting(key, authUser(c).id);
    } catch (e) {
      if (e instanceof SettingWriteError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
    log.dashboard.info({ key, user: authUser(c).username }, "setting reset via dashboard");
    return c.json({ ok: true as const, groups: settingsReport() });
  }
);

settingsRoutes.post(
  "/settings/validate-linear",
  describeRoute({
    tags: ["Settings"],
    summary: "Valida STATE_*/LABEL_* contra workflow states e labels do Linear",
    responses: {
      200: jsonContent(looseObject, "Resultado da validação"),
      502: jsonContent(errorBody, "Erro de conexão com Linear"),
    },
  }),
  async (c) => {
    try {
      const [stateNames, labelNames] = await Promise.all([listTeamStateNames(), listTeamLabelNames()]);
      const states = new Set(stateNames);
      const labels = new Set(labelNames);
      const results = SETTINGS_REGISTRY.filter((m) => m.linearValidatable).map((m) => {
        const value = resolveSetting(m.key).raw;
        const ok = m.linearValidatable === "state" ? states.has(value) : labels.has(value);
        return { key: m.key, value, kind: m.linearValidatable, ok };
      });
      return c.json({ ok: true, results, teamStates: stateNames, teamLabels: labelNames });
    } catch (e) {
      log.dashboard.error(errFields(e), "validate-linear failed");
      return c.json({ error: `falha ao consultar o Linear: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  }
);

settingsRoutes.get(
  "/linear/workspace",
  describeRoute({
    tags: ["Settings"],
    summary: "urlKey do workspace Linear (base do link run→Linear)",
    responses: { 200: jsonContent(looseObject, "Workspace") },
  }),
  async (c) => {
    try {
      return c.json({ urlKey: await organizationUrlKey() });
    } catch (e) {
      log.dashboard.debug(errFields(e), "organizationUrlKey failed (Linear link unavailable)");
      return c.json({ urlKey: null });
    }
  }
);
