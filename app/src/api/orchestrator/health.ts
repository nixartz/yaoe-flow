import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { backendName } from "../../agent";
import { jsonContent } from "../shared/openapi";
import { healthResponse } from "./health.schema";

export const healthRoutes = new Hono();

healthRoutes.get(
  "/health",
  describeRoute({
    tags: ["Health"],
    summary: "Health check do orquestrador",
    responses: {
      200: jsonContent(healthResponse, "Serviço no ar"),
    },
  }),
  (c) => c.json({ ok: true as const, backend: backendName() })
);
