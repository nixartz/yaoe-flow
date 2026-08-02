import { z } from "zod";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import pkg from "../../../package.json" with { type: "json" };
import { requireAuth } from "../../dashboard/auth";
import { mountOpenApiDocs, jsonContent } from "../shared/openapi";
import { authRoutes } from "./auth";
import { overviewRoutes } from "./overview";
import { runsRoutes } from "./runs";
import { webhooksRoutes } from "./webhooks";
import { logsRoutes } from "./logs";
import { settingsRoutes } from "./settings";
import { usersRoutes } from "./users";
import { recipesRoutes } from "./recipes";
import { configRoutes } from "./config";
import { queryRoutes } from "./query";
import { agentsRoutes } from "./agents";
import { harnessRoutes } from "./harness";
import { notificationsRoutes } from "./notifications";
import { linearConnectionsRoutes } from "./linear-connections";
import { readinessRoutes } from "./readiness";

const healthOk = z.object({ ok: z.literal(true) });

export function createDashboardApp(): Hono {
  const app = new Hono();

  app.get(
    "/api/health",
    describeRoute({
      tags: ["Health"],
      summary: "Health check da dashboard",
      responses: { 200: jsonContent(healthOk, "Dashboard no ar") },
    }),
    (c) => c.json({ ok: true as const })
  );

  app.route("/api/auth", authRoutes);

  mountOpenApiDocs(app, {
    title: "Orchestrator Dashboard",
    version: pkg.version,
    description: "REST/SSE API of the YAOE-FLOW observability dashboard.",
  });

  app.use("/api/*", requireAuth);

  app.route("/api", overviewRoutes);
  app.route("/api", runsRoutes);
  app.route("/api", webhooksRoutes);
  app.route("/api", logsRoutes);
  app.route("/api", settingsRoutes);
  app.route("/api", usersRoutes);
  app.route("/api", recipesRoutes);
  app.route("/api", configRoutes);
  app.route("/api", queryRoutes);
  app.route("/api/agents", agentsRoutes);
  app.route("/api/harness", harnessRoutes);
  app.route("/api/notifications", notificationsRoutes);
  app.route("/api/linear-connections", linearConnectionsRoutes);
  app.route("/api", readinessRoutes);

  return app;
}
