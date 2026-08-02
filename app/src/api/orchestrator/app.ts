import { Hono } from "hono";
import pkg from "../../../package.json" with { type: "json" };
import { mountOpenApiDocs } from "../shared/openapi";
import { healthRoutes } from "./health";
import { webhookRoutes } from "./webhook";

/** App Hono da porta principal (health + webhook Linear + docs). */
export function createOrchestratorApp(): Hono {
  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", webhookRoutes);
  mountOpenApiDocs(app, {
    title: "Orchestrator",
    version: pkg.version,
    description: "API da porta principal: health e webhook Linear.",
  });
  return app;
}
