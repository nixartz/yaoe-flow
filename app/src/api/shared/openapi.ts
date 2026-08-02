import type { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { resolver } from "hono-openapi";
import type { z } from "zod";

type DocsInfo = {
  title: string;
  version: string;
  description?: string;
};

/** Response JSON tipada via Zod para `describeRoute`. */
export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
  return {
    description,
    content: {
      "application/json": { schema: resolver(schema) },
    },
  };
}

/** Resposta SSE — sem schema de body JSON. */
export const sseContent = {
  description: "Server-Sent Events stream",
  content: {
    "text/event-stream": {
      schema: { type: "string" as const },
    },
  },
};

/** Monta GET /api/openapi (JSON) e GET /api/docs (Scalar). */
export function mountOpenApiDocs(
  app: Hono,
  info: DocsInfo,
  opts?: { servers?: Array<{ url: string; description?: string }> }
): void {
  app.get(
    "/api/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: info.title,
          version: info.version,
          description: info.description,
        },
        servers: opts?.servers,
      },
    })
  );

  app.get(
    "/api/docs",
    Scalar({
      url: "/api/openapi",
      pageTitle: info.title,
      theme: "default",
    })
  );
}
