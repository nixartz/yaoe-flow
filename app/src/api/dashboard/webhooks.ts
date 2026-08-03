import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent, sseContent } from "../shared/openapi";
import { errorBody, looseObject } from "../shared/schemas";
import { webhooksQuery } from "./webhooks.schema";
import { heartbeatLoop } from "./sse";
import { bus, type WebhookTopic } from "../../dashboard/bus";
import * as store from "../../dashboard/store";

export const webhooksRoutes = new Hono();

webhooksRoutes.get(
  "/webhooks",
  describeRoute({
    tags: ["Webhooks"],
    summary: "List webhook events with filters and pagination",
    responses: { 200: jsonContent(looseObject, "Webhooks") },
  }),
  validator("query", webhooksQuery),
  (c) => {
    const q = c.req.valid("query");
    return c.json(
      store.listWebhooks({
        issueId: q.issueId,
        teamId: q.teamId,
        projectId: q.projectId,
        q: q.q,
        page: q.page,
        pageSize: q.pageSize,
      })
    );
  }
);

webhooksRoutes.get(
  "/webhooks/stream",
  describeRoute({
    tags: ["Webhooks"],
    summary: "SSE stream of webhook events",
    responses: { 200: sseContent },
  }),
  (c) =>
    streamSSE(c, async (stream) => {
      const onWebhook = (payload: WebhookTopic) => {
        stream.writeSSE({ event: payload.type, data: JSON.stringify(payload) }).catch(() => {});
      };
      bus.on("webhook", onWebhook);
      stream.onAbort(() => { bus.off("webhook", onWebhook); });
      await heartbeatLoop(stream);
    })
);

webhooksRoutes.get(
  "/webhooks/:id",
  describeRoute({
    tags: ["Webhooks"],
    summary: "Webhook event detail",
    responses: {
      200: jsonContent(looseObject, "Webhook encontrado"),
      404: jsonContent(errorBody, "Não encontrado"),
    },
  }),
  (c) => {
    const row = store.getWebhook(Number(c.req.param("id")));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  }
);
