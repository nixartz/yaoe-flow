import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { config } from "../../config";
import { log, errFields } from "../../logger";
import { parseWebhook, parseWebhookEnvelope, authenticateWebhook } from "../../webhook";
import { onStatusChange } from "../../scheduler";
import { listConnections } from "../../db/linearConnections";
import { insertWebhookEvent } from "../../dashboard/store";
import { jsonContent } from "../shared/openapi";
import { webhookOk, webhookUnauthorized } from "./webhook.schema";

export const webhookRoutes = new Hono();

webhookRoutes.post(
  "/webhook/linear",
  describeRoute({
    tags: ["Webhook"],
    summary: "Webhook Linear (status change)",
    description:
      "Body raw assinado com header linear-signature. Multi-Linear resolve a connection por organizationId + HMAC.",
    parameters: [
      {
        name: "linear-signature",
        in: "header",
        required: false,
        schema: { type: "string" },
        description: "HMAC-SHA256 do body com o webhook secret da connection",
      },
    ],
    responses: {
      200: jsonContent(webhookOk, "Webhook aceito"),
      401: jsonContent(webhookUnauthorized, "Assinatura inválida"),
    },
  }),
  async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header("linear-signature") ?? "";

    const hasAnySecret =
      listConnections({ enabled: true }).length > 0 || Boolean(config.linear.webhookSecret);
    const linearCtx = authenticateWebhook(raw, sig);
    if (hasAnySecret && !linearCtx) {
      log.webhook.warn({ hasSignature: Boolean(sig) }, "webhook rejected: invalid signature");
      return c.json({ error: "invalid signature" }, 401);
    }
    const ctx = linearCtx;

    const evt = parseWebhook(raw);
    const triggeredScheduler = Boolean(evt) && config.orchestratorEnabled;
    if (evt) {
      log.webhook.info(
        {
          issueId: evt.issueId,
          stateName: evt.stateName,
          action: evt.action,
          type: evt.type,
          connectionId: ctx?.connectionId,
          organizationId: ctx?.organizationId,
        },
        "webhook received"
      );
      if (config.orchestratorEnabled && ctx) {
        onStatusChange(evt.issueId, evt.stateName, ctx).catch((e) =>
          log.scheduler.error(
            {
              issueId: evt.issueId,
              stateName: evt.stateName,
              connectionId: ctx.connectionId,
              ...errFields(e),
            },
            "onStatusChange failed"
          )
        );
      } else if (!config.orchestratorEnabled) {
        log.webhook.debug(
          "orchestrator disabled (ORCHESTRATOR_ENABLED=false) — webhook só auditado, scheduler não acionado"
        );
      }
    } else {
      log.webhook.debug("webhook ignored: not a relevant issue status event");
    }

    try {
      const envelope = parseWebhookEnvelope(raw);
      if (envelope) {
        insertWebhookEvent({
          entityType: envelope.entityType,
          action: envelope.action,
          issueId: envelope.issueId,
          issueIdentifier: envelope.issueIdentifier,
          issueTitle: envelope.issueTitle,
          teamId: envelope.teamId,
          teamKey: envelope.teamKey,
          teamName: envelope.teamName,
          projectId: envelope.projectId,
          projectName: envelope.projectName,
          milestoneId: envelope.milestoneId,
          milestoneName: envelope.milestoneName,
          actorName: envelope.actorName,
          actorType: envelope.actorType,
          organizationId: envelope.organizationId ?? ctx?.organizationId,
          connectionId: ctx?.connectionId,
          summary: envelope.summary,
          triggeredScheduler,
          raw: envelope.raw,
        });
      }
    } catch (e) {
      log.dashboard.warn(errFields(e), "webhook audit capture failed (best-effort)");
    }

    return c.json({ ok: true as const });
  }
);
