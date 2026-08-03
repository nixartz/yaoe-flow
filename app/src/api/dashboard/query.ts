import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, looseObject } from "../shared/schemas";
import { queryBody, entityParam } from "./query.schema";
import { runQuery, ENTITY_COLUMNS, type QuerySpec, type EntityName } from "../../dashboard/query";

export const queryRoutes = new Hono();

const QUERYABLE_ENTITIES = new Set<EntityName>(["log_lines", "runs", "webhook_events"]);

queryRoutes.get(
  "/query/:entity/columns",
  describeRoute({
    tags: ["Query"],
    summary: "Columns available for an entity",
    responses: {
      200: jsonContent(looseObject, "Colunas"),
      404: jsonContent(errorBody, "Entidade desconhecida"),
    },
  }),
  validator("param", entityParam),
  (c) => {
    const entity = c.req.valid("param").entity;
    if (!QUERYABLE_ENTITIES.has(entity)) return c.json({ error: "unknown entity" }, 404);
    return c.json({ columns: ENTITY_COLUMNS[entity] });
  }
);

queryRoutes.post(
  "/query/:entity",
  describeRoute({
    tags: ["Query"],
    summary: "Generic query (fields/filter/sort/limit/page)",
    responses: {
      200: jsonContent(looseObject, "Resultado da query"),
      400: jsonContent(errorBody, "Query inválida"),
      404: jsonContent(errorBody, "Entidade desconhecida"),
    },
  }),
  validator("param", entityParam),
  validator("json", queryBody),
  async (c) => {
    const entity = c.req.valid("param").entity;
    if (!QUERYABLE_ENTITIES.has(entity)) return c.json({ error: "unknown entity" }, 404);
    const spec = c.req.valid("json") as QuerySpec;
    try {
      return c.json(runQuery(entity, spec));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "invalid query" }, 400);
    }
  }
);
