// Servidor secundário (porta DASHBOARD_PORT) — SPA estática + API REST/SSE.
// Processo único com o orchestrator; só a porta é diferente. Ver src/index.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "hono/bun";
import { config } from "../config";
import { EMBEDDED_DASHBOARD_ASSETS } from "../embedded-assets.generated";
import { log } from "../logger";
import { seedAdminFromEnv } from "./auth";
import { createDashboardApp } from "../api/dashboard/app";
import { startRetentionSweep } from "./retention";
import { db } from "./db";
import { bus } from "./bus";
import { insertLogLine } from "./store";

// Segundos — bem acima do heartbeat de 15s das SSE e do default do Bun
// (que fecha conexão sem tráfego em ~10s).
const IDLE_TIMEOUT_S = 120;

export function startDashboardServer(): void {
  if (!config.dashboard.enabled) {
    log.server.info("dashboard disabled (DASHBOARD_ENABLED=false)");
    return;
  }
  if (!config.dashboard.sessionSecret) {
    log.server.warn("dashboard enabled but DASHBOARD_SESSION_SECRET not set — login will fail");
  }

  db();
  seedAdminFromEnv().catch((e) => log.dashboard.error({ err: e }, "seedAdminFromEnv failed"));
  startRetentionSweep();

  bus.on("log", (line: string) => insertLogLine(line));

  const app = createDashboardApp();

  const embeddedAssetCount = Object.keys(EMBEDDED_DASHBOARD_ASSETS).length;
  if (embeddedAssetCount > 0) {
    app.get("*", (c) => {
      const path = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\//, "");
      const asset = EMBEDDED_DASHBOARD_ASSETS[path] ?? EMBEDDED_DASHBOARD_ASSETS["index.html"];
      if (!asset) return c.text("dashboard build not found", 404);
      return new Response(Buffer.from(asset.base64, "base64"), {
        headers: { "Content-Type": asset.contentType },
      });
    });
    log.server.info({ assets: embeddedAssetCount }, "dashboard SPA embutida servida do bundle");
  } else if (existsSync(config.dashboard.staticDir)) {
    app.use("/assets/*", serveStatic({ root: config.dashboard.staticDir }));
    app.get("*", async (c) => {
      const index = Bun.file(join(config.dashboard.staticDir, "index.html"));
      if (!(await index.exists())) return c.text("dashboard build not found", 404);
      return c.html(await index.text());
    });
  } else {
    log.server.warn({ staticDir: config.dashboard.staticDir }, "dashboard static build not found — API-only mode");
  }

  Bun.serve({
    port: config.dashboard.port,
    fetch: app.fetch,
    hostname: config.host,
    idleTimeout: IDLE_TIMEOUT_S,
  });
  log.server.info({ url: `http://${config.host}:${config.dashboard.port}` }, "dashboard listening");
}
