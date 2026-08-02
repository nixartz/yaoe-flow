import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent, sseContent } from "../shared/openapi";
import { logsRecentQuery, logsRecentResponse } from "./logs.schema";
import { heartbeatLoop } from "./sse";
import { bus } from "../../dashboard/bus";
import { recentLogs } from "../../dashboard/logBuffer";

export const logsRoutes = new Hono();

logsRoutes.get(
  "/logs/recent",
  describeRoute({
    tags: ["Logs"],
    summary: "Últimas linhas de log",
    responses: { 200: jsonContent(logsRecentResponse, "Logs recentes") },
  }),
  validator("query", logsRecentQuery),
  (c) => {
    const limit = c.req.valid("query").limit;
    return c.json({ lines: recentLogs(limit) });
  }
);

logsRoutes.get(
  "/logs/stream",
  describeRoute({
    tags: ["Logs"],
    summary: "SSE de log lines ao vivo",
    responses: { 200: sseContent },
  }),
  (c) =>
    streamSSE(c, async (stream) => {
      const onLog = (line: string) => {
        stream.writeSSE({ event: "log", data: line }).catch(() => {});
      };
      bus.on("log", onLog);
      stream.onAbort(() => { bus.off("log", onLog); });
      await heartbeatLoop(stream);
    })
);
