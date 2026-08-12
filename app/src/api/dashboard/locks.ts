import { z } from "zod";
import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { okBody } from "../shared/schemas";
import { locksListResponse, releaseLockParam } from "./locks.schema";
import { resolveActiveContexts } from "../../db/linearConnections";
import * as locks from "../../locks";

export const locksRoutes = new Hono();

// Read-only view of live footprint locks per Linear connection — the manual
// "release" action below exists for the rare case a webhook is lost AND the
// next tick's reconcileStaleLocks() hasn't self-healed yet (e.g. the issue
// itself is stuck in a holding state for a reason only a human can resolve).
locksRoutes.get(
  "/locks",
  describeRoute({
    tags: ["Locks"],
    summary: "Active footprint locks per Linear connection (Valkey)",
    responses: { 200: jsonContent(locksListResponse, "Locks ativos") },
  }),
  async (c) => {
    const contexts = resolveActiveContexts();
    const connections = await Promise.all(
      contexts.map(async (ctx) => ({
        connectionId: ctx.connectionId,
        connectionName: ctx.name,
        locks: await locks.activeFootprints(ctx.connectionId),
      }))
    );
    return c.json({ connections });
  }
);

locksRoutes.post(
  "/locks/:connectionId/:issueId/release",
  describeRoute({
    tags: ["Locks"],
    summary: "Manually release a footprint lock",
    description:
      "Best-effort — tolerant of an already-released lock. Does not touch Linear; the next tick's reconcileStaleLocks() is the authoritative self-heal.",
    responses: { 200: jsonContent(okBody.extend({ warning: z.string().optional() }), "Liberado") },
  }),
  validator("param", releaseLockParam),
  async (c) => {
    const { connectionId, issueId } = c.req.valid("param");
    const had = await locks.hasLock(connectionId, issueId);
    await locks.releaseLock(connectionId, issueId);
    return c.json({
      ok: true as const,
      warning: had ? undefined : "O lock já não estava mais ativo (provavelmente liberado por outro processo ou tick).",
    });
  }
);
