// §9.3: constraint 1-ativa por papel (à prova de corrida), versionamento
// append-only, preservação de config de harness ao trocar o harness ativo
// (D3), e o snapshot de config por run (§6.4) omite segredos.
import { describe, expect, test } from "bun:test";
import {
  createAgent,
  createVersion,
  activateAgent,
  listVersions,
  setActiveHarness,
  updateHarnessConfig,
  listHarnessConfigs,
  getHarnessConfig,
  activeAgentForRole,
} from "../src/db/agents";
import { resolvedConfigSnapshot } from "../src/agent/recipe/builder";
import { appDb } from "../src/db";

describe("agents (Fase 1)", () => {
  test("criar duas variantes do mesmo papel: nenhuma ativa por padrão", () => {
    const a = createAgent({ role: "reviewer", name: "reviewer-a", soulMarkdown: "# A" });
    const b = createAgent({ role: "reviewer", name: "reviewer-b", soulMarkdown: "# B" });
    expect(a.isActive).toBe(0);
    expect(b.isActive).toBe(0);
  });

  test("ativar troca atomicamente — só uma ativa por papel (unique index parcial)", () => {
    const a = createAgent({ role: "pmo", name: "pmo-a", soulMarkdown: "# A" });
    const b = createAgent({ role: "pmo", name: "pmo-b", soulMarkdown: "# B" });
    activateAgent(a.id);
    expect(appDb().sqlite.query(`SELECT id FROM agents WHERE role='pmo' AND is_active=1`).all()).toHaveLength(1);
    activateAgent(b.id);
    const activeRows = appDb().sqlite.query(`SELECT id FROM agents WHERE role='pmo' AND is_active=1`).all() as { id: string }[];
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe(b.id);
  });

  test("ativação concorrente não deixa duas ativas (constraint à prova de corrida)", async () => {
    const a = createAgent({ role: "orchestrator", name: "orch-a", soulMarkdown: "# A" });
    const b = createAgent({ role: "orchestrator", name: "orch-b", soulMarkdown: "# B" });
    await Promise.all([Promise.resolve(activateAgent(a.id)), Promise.resolve(activateAgent(b.id))]);
    const activeRows = appDb().sqlite.query(`SELECT id FROM agents WHERE role='orchestrator' AND is_active=1`).all();
    expect(activeRows).toHaveLength(1);
  });

  test("versionamento é append-only: nova versão nunca reescreve a antiga", () => {
    const agent = createAgent({ role: "dev", name: "worker-versions", soulMarkdown: "# v1", activate: true });
    const v2 = createVersion(agent.id, "# v2", "segunda versão", null);
    const v3 = createVersion(agent.id, "# v3", "terceira versão", null);
    const versions = listVersions(agent.id);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3]);
    expect(versions.find((v) => v.version === 1)!.soulMarkdown).toBe("# v1");
    expect(v2.soulMarkdown).toBe("# v2");
    expect(v3.soulMarkdown).toBe("# v3");
  });

  test("comment é obrigatório numa nova versão", () => {
    const agent = createAgent({ role: "pmo", name: "pmo-comment-test", soulMarkdown: "# v1" });
    expect(() => createVersion(agent.id, "# v2", "", null)).toThrow(/comment/);
  });

  test("D3: trocar o harness ativo preserva a config do harness anterior intacta", () => {
    const agent = createAgent({ role: "dev", name: "worker-d3", soulMarkdown: "# soul", harnessId: "goose", activate: true });
    updateHarnessConfig(agent.id, "goose", { model: "z-ai/glm-4.7-flash", settingsJson: JSON.stringify({ provider: "openrouter" }) });

    setActiveHarness(agent.id, "claude-code");
    updateHarnessConfig(agent.id, "claude-code", { model: "claude-sonnet-5" });

    setActiveHarness(agent.id, "goose"); // volta pro goose

    const gooseConfig = getHarnessConfig(agent.id, "goose")!;
    expect(gooseConfig.model).toBe("z-ai/glm-4.7-flash"); // preservado — não foi apagado nem sobrescrito
    const claudeConfig = getHarnessConfig(agent.id, "claude-code")!;
    expect(claudeConfig.model).toBe("claude-sonnet-5"); // também continua existindo

    const configs = listHarnessConfigs(agent.id);
    expect(configs.length).toBeGreaterThanOrEqual(2);
  });

  test("selecionar um harness sem config cria a linha com defaults (nunca copia de outro harness)", () => {
    const agent = createAgent({ role: "reviewer", name: "reviewer-defaults", soulMarkdown: "# soul", harnessId: "goose", activate: true });
    updateHarnessConfig(agent.id, "goose", { model: "modelo-do-goose" });
    setActiveHarness(agent.id, "codex");
    const codexConfig = getHarnessConfig(agent.id, "codex")!;
    expect(codexConfig.model).toBeNull(); // default — não herdou o model do goose
  });

  test("activeAgentForRole resolve o agente/versão/harness certos", () => {
    const agent = createAgent({ role: "pmo", name: "pmo-active-lookup", soulMarkdown: "# soul", harnessId: "goose", activate: true });
    const resolved = activeAgentForRole("pmo");
    expect(resolved?.agent.id).toBe(agent.id);
    expect(resolved?.harnessId).toBe("goose");
    expect(resolved?.version.soulMarkdown).toBe("# soul");
  });

  test("snapshot de config por run (§6.4) omite segredos, não mascara", () => {
    const snapshot = JSON.parse(
      resolvedConfigSnapshot({
        harnessId: "goose",
        model: "z-ai/glm-4.7-flash",
        provider: "openrouter",
        settings: { provider: "openrouter", apiKey: "segredo-nunca-deveria-aparecer", keyOverride: "outro-segredo" },
        mcpServers: [{ type: "builtin", name: "developer" }],
      })
    );
    expect(snapshot.settings.apiKey).toBeUndefined();
    expect(snapshot.settings.keyOverride).toBeUndefined();
    expect(snapshot.settings.provider).toBe("openrouter");
    expect(JSON.stringify(snapshot)).not.toContain("segredo-nunca-deveria-aparecer");
    expect(snapshot.model).toBe("z-ai/glm-4.7-flash");
  });
});
