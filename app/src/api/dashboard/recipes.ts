import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody } from "../shared/schemas";
import { recipeResponse } from "./recipes.schema";
import { config } from "../../config";

export const recipesRoutes = new Hono();

recipesRoutes.get(
  "/recipes/:role",
  describeRoute({
    tags: ["Recipes"],
    summary: "Detalhes do recipe (Goose) de um papel",
    responses: {
      200: jsonContent(recipeResponse, "Recipe"),
      404: jsonContent(errorBody, "Não encontrado / backend não é goose"),
      500: jsonContent(errorBody, "Bun.YAML indisponível"),
    },
  }),
  (c) => {
    if (config.agent.backend !== "goose") {
      return c.json({ error: "detalhes de recipe só existem com AGENT_BACKEND=goose" }, 404);
    }
    const role = c.req.param("role").replace(/[^a-zA-Z0-9_-]/g, "");
    const file = join(config.goose.recipesDir, `${role}.yaml`);
    if (!role || !existsSync(file)) return c.json({ error: "recipe não encontrado" }, 404);

    const YAML = (Bun as unknown as { YAML?: { parse(s: string): unknown } }).YAML;
    if (!YAML) return c.json({ error: "Bun.YAML indisponível nesta build" }, 500);
    const parsed = YAML.parse(readFileSync(file, "utf8")) as {
      title?: string;
      description?: string;
      settings?: { goose_provider?: string; goose_model?: string };
      extensions?: unknown;
      instructions?: string;
    };
    return c.json({
      title: parsed.title,
      description: parsed.description,
      settings: parsed.settings,
      extensions: parsed.extensions,
      instructions: parsed.instructions,
    });
  }
);
