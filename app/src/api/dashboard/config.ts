import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { configResponse } from "./config.schema";
import { config } from "../../config";
import { settingsReport } from "../../config/service";

export const configRoutes = new Hono();

configRoutes.get(
  "/config",
  describeRoute({
    tags: ["Config"],
    summary: "Effective configuration + active Goose recipes",
    responses: { 200: jsonContent(configResponse, "Config") },
  }),
  (c) => {
    const recipes: Array<{
      role: string;
      file: string;
      provider?: string;
      model?: string;
      extensions: Array<{ name: string; type: string; uri?: string }>;
    }> = [];

    if (config.agent.backend === "goose") {
      const YAML = (Bun as unknown as { YAML?: { parse(s: string): unknown } }).YAML;
      for (const [role, name] of Object.entries(config.goose.recipes)) {
        const file = `${name}.yaml`;
        const path = join(config.goose.recipesDir, file);
        if (!YAML || !existsSync(path)) continue;
        try {
          const parsed = YAML.parse(readFileSync(path, "utf8")) as {
            settings?: { goose_provider?: string; goose_model?: string };
            extensions?: Array<{ name?: string; type?: string; uri?: string }>;
          };
          recipes.push({
            role,
            file,
            provider: parsed.settings?.goose_provider,
            model: parsed.settings?.goose_model,
            extensions: (parsed.extensions ?? []).map((e) => ({
              name: e.name ?? "?",
              type: e.type ?? "?",
              uri: e.uri,
            })),
          });
        } catch {
          /* yaml inválido — omite este recipe do relatório, sem quebrar a tela */
        }
      }
    }

    return c.json({ backend: config.agent.backend, groups: settingsReport(), recipes });
  }
);
