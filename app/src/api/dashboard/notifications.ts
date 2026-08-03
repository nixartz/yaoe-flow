import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody, idParam, looseObject } from "../shared/schemas";
import { createChannelBody, updateChannelBody, setRuleBody } from "./notifications.schema";
import * as repo from "../../notifications/store";
import { NotificationError, NOTIFICATION_EVENTS, decryptConfig, maskedConfig } from "../../notifications/store";
import { deliver } from "../../notifications/send";
import { authUser } from "../../dashboard/auth";
import { log } from "../../logger";

export const notificationsRoutes = new Hono();

function withRulesAndMaskedConfig(channel: repo.ChannelRow) {
  const rules = repo.listRules(channel.id);
  const enabledEvents = new Set(rules.filter((r) => r.enabled === 1).map((r) => r.event));
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    config: maskedConfig(channel),
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    events: NOTIFICATION_EVENTS.map((event) => ({ event, enabled: enabledEvents.has(event) })),
  };
}

notificationsRoutes.get(
  "/",
  describeRoute({
    tags: ["Notifications"],
    summary: "List channels with rules and masked config",
    responses: { 200: jsonContent(looseObject, "Canais") },
  }),
  (c) => c.json({ channels: repo.listChannels().map(withRulesAndMaskedConfig), events: NOTIFICATION_EVENTS })
);

notificationsRoutes.post(
  "/",
  describeRoute({
    tags: ["Notifications"],
    summary: "Create a notification channel",
    responses: {
      200: jsonContent(okBody.extend({ channel: looseObject }), "Canal criado"),
      400: jsonContent(errorBody, "Erro de validação"),
    },
  }),
  validator("json", createChannelBody),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const channel = repo.createChannel({
        type: body.type as repo.ChannelType,
        name: body.name,
        configJson: JSON.stringify(body.config ?? {}),
      });
      log.dashboard.info({ channel: channel.name, type: channel.type, by: authUser(c).username }, "notification channel created");
      return c.json({ ok: true as const, channel: withRulesAndMaskedConfig(channel) });
    } catch (e) {
      if (e instanceof NotificationError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

notificationsRoutes.patch(
  "/:id",
  describeRoute({
    tags: ["Notifications"],
    summary: "Update a channel",
    responses: {
      200: jsonContent(okBody.extend({ channel: looseObject }), "Atualizado"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  validator("json", updateChannelBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const channel = repo.updateChannel(id, {
        name: body.name,
        configJson: body.config !== undefined ? JSON.stringify(body.config) : undefined,
      });
      return c.json({ ok: true as const, channel: withRulesAndMaskedConfig(channel) });
    } catch (e) {
      if (e instanceof NotificationError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

notificationsRoutes.delete(
  "/:id",
  describeRoute({
    tags: ["Notifications"],
    summary: "Delete a channel",
    responses: { 200: jsonContent(okBody, "Removido") },
  }),
  validator("param", idParam),
  (c) => {
    repo.deleteChannel(c.req.valid("param").id);
    return c.json({ ok: true as const });
  }
);

notificationsRoutes.put(
  "/:id/rules/:event",
  describeRoute({
    tags: ["Notifications"],
    summary: "Toggle an event on a channel",
    responses: {
      200: jsonContent(looseObject, "Regra atualizada"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("json", setRuleBody),
  async (c) => {
    try {
      repo.setRule(c.req.param("id"), c.req.param("event") as repo.NotificationEvent, Boolean(c.req.valid("json").enabled));
      const channel = repo.getChannel(c.req.param("id"));
      return c.json({ ok: true as const, channel: channel ? withRulesAndMaskedConfig(channel) : null });
    } catch (e) {
      if (e instanceof NotificationError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

notificationsRoutes.post(
  "/:id/test",
  describeRoute({
    tags: ["Notifications"],
    summary: "Test a channel with a real message",
    responses: {
      200: jsonContent(looseObject, "Resultado do teste"),
      404: jsonContent(errorBody, "Canal não encontrado"),
    },
  }),
  validator("param", idParam),
  async (c) => {
    const channel = repo.getChannel(c.req.valid("param").id);
    if (!channel) return c.json({ error: "canal não encontrado" }, 404);
    const ok = await deliver(channel, decryptConfig(channel), {
      title: "🔔 Teste de notificação",
      body: `Canal "${channel.name}" (${channel.type}) configurado corretamente — disparado por ${authUser(c).username} via dashboard.`,
    });
    return c.json({ ok });
  }
);
