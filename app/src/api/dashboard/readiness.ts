import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { readinessQuery, readinessListResponse } from "./readiness.schema";
import { resolveActiveContexts } from "../../db/linearConnections";
import { loadReadinessSnapshot, READINESS_TTL_SECONDS } from "../../readiness";

export const readinessRoutes = new Hono();

readinessRoutes.get(
  "/readiness",
  describeRoute({
    tags: ["Readiness"],
    summary: "Snapshot de prontidão das candidatas do orquestrador (Valkey)",
    description:
      "Lê o cache gravado no fim de cada tick — não consulta o Linear. Sem snapshot = próximo tick ainda não rodou.",
    responses: { 200: jsonContent(readinessListResponse, "Snapshots por connection") },
  }),
  validator("query", readinessQuery),
  async (c) => {
    const { connectionId } = c.req.valid("query");
    const contexts = resolveActiveContexts();
    const wanted = connectionId ? contexts.filter((ctx) => ctx.connectionId === connectionId) : contexts;

    const snapshots = [];
    const missingConnectionIds: string[] = [];
    for (const ctx of wanted) {
      const snap = await loadReadinessSnapshot(ctx.connectionId);
      if (snap) snapshots.push(snap);
      else missingConnectionIds.push(ctx.connectionId);
    }

    return c.json({
      ttlSeconds: READINESS_TTL_SECONDS,
      snapshots,
      missingConnectionIds,
    });
  }
);
