import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { looseObject } from "../shared/schemas";
import { overviewQuery } from "./overview.schema";
import * as store from "../../dashboard/store";

export const overviewRoutes = new Hono();

overviewRoutes.get(
  "/overview",
  describeRoute({
    tags: ["Overview"],
    summary: "Resumo da dashboard (runs, status, stats)",
    responses: { 200: jsonContent(looseObject, "Overview") },
  }),
  validator("query", overviewQuery),
  (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.valid("query").days ?? 14)));
    return c.json(store.overview(days));
  }
);
