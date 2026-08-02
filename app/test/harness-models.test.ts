// Modelos por harness (§7.4): a lista que a dashboard usa pra oferecer select
// em vez de texto livre. Aqui cobrimos o CACHE e o endpoint — a sonda de
// verdade (spawn do CLI) é coberta pela contract suite contra o mock ACP.
import { describe, expect, test } from "bun:test";
import { appDb } from "../src/db";
import { harnesses } from "../src/db/schema";
import { getCachedDetection } from "../src/agent/harness/detect";
import { HARNESS_ADAPTERS } from "../src/agent/harness/registry";
import { harnessRoutes } from "../src/api/dashboard/harness";
import type { HarnessDetection, HarnessId } from "../src/agent/harness/types";

function seedDetection(id: HarnessId, detection: HarnessDetection): void {
  const now = Date.now();
  appDb()
    .orm.insert(harnesses)
    .values({ id, detectionJson: JSON.stringify(detection), budgetsJson: "{}", updatedAt: now })
    .onConflictDoUpdate({ target: harnesses.id, set: { detectionJson: JSON.stringify(detection), updatedAt: now } })
    .run();
}

describe("sonda de modelos por harness", () => {
  test("só quem enumera modelos expõe listModels()", () => {
    // O select da dashboard depende deste par: `list` tem sonda, o resto cai no
    // campo livre (goose/hermes resolvem modelo por env/recipe).
    for (const id of Object.keys(HARNESS_ADAPTERS) as HarnessId[]) {
      const adapter = HARNESS_ADAPTERS[id];
      const enumerates = adapter.capabilities.modelSelection === "list";
      expect(typeof adapter.listModels === "function").toBe(enumerates);
    }
  });

  test("modelos sobrevivem no cache da detecção", () => {
    seedDetection("cursor", {
      installed: true,
      authStatus: "ok",
      checkedAt: Date.now(),
      defaultModelId: "default[]",
      models: [
        { id: "default[]", name: "Auto" },
        { id: "composer-2.5[fast=true]", name: "composer-2.5" },
      ],
    });
    const cached = getCachedDetection("cursor");
    expect(cached?.models?.map((m) => m.id)).toEqual(["default[]", "composer-2.5[fast=true]"]);
    expect(cached?.defaultModelId).toBe("default[]");
  });
});

describe("GET /harness/:id/models", () => {
  test("devolve a lista cacheada com o default do harness", async () => {
    seedDetection("cursor", {
      installed: true,
      authStatus: "ok",
      checkedAt: 1_700_000_000_000,
      defaultModelId: "default[]",
      models: [{ id: "default[]", name: "Auto" }],
    });
    const res = await harnessRoutes.request("/cursor/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      harnessId: "cursor",
      modelSelection: "list",
      models: [{ id: "default[]", name: "Auto" }],
      defaultModelId: "default[]",
      checkedAt: 1_700_000_000_000,
    });
  });

  test("harness que não enumera devolve lista vazia (UI cai no texto livre, não trava)", async () => {
    const res = await harnessRoutes.request("/goose/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[]; modelSelection: string };
    expect(body.models).toEqual([]);
    expect(body.modelSelection).toBe("flag");
  });

  test("harness desconhecido é 404", async () => {
    const res = await harnessRoutes.request("/inexistente/models");
    expect(res.status).toBe(404);
  });
});
