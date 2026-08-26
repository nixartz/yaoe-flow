// Builder de recipe/prompt em RUNTIME (§6.3) — aposenta recipes/build.ts como
// passo manual: a montagem que era `build.ts` → .yaml em disco → deeplink
// passa a acontecer por dispatch, a partir do BANCO (SOUL da versão ativa +
// mcpServersJson + model + settings do harness ativo).
//
// Um módulo por target:
//   • goose  → objeto recipe (mesmo shape do YAML antigo) → deeplink base64
//     instructions = SOUL + protocol + overlay (when IGNORE_* flags are on)
//   • demais → adapters concatenate SOUL + overlay + role brief + user message
//     (protocol is a pre-existing gap on ACP — knowledge/product/pipeline-policy-overlay.md)
import { communicationProtocol, type McpServerConfig, type RoleMeta, type AgentRole } from "./defaults";
import { appendPipelinePolicy } from "./pipeline-policy";

export interface GooseRecipeInput {
  /** Canonical role — selects overlay bullets (Reviewer vs Dev vs PMO). */
  role: AgentRole;
  roleMeta: Pick<RoleMeta, "title" | "description" | "prompt">;
  soulMarkdown: string;
  model?: string | null;
  /** settingsJson do harness goose: {provider, baseUrl?, hindsight?: {enabled, baseUrl, bankId}} */
  settings: Record<string, unknown>;
  mcpServers: McpServerConfig[];
}

export interface BuiltGooseRecipe {
  deeplink: string;
  provider: string;
  model?: string;
  raw: Record<string, unknown>;
}

interface HindsightSettings {
  enabled?: boolean;
  baseUrl?: string;
  bankId?: string;
}

function gooseExtension(mcp: McpServerConfig): Record<string, unknown> {
  switch (mcp.type) {
    case "builtin":
      return { type: "builtin", name: mcp.name };
    case "stdio":
      return {
        type: "stdio",
        name: mcp.name,
        cmd: mcp.cmd,
        args: mcp.args,
        timeout: mcp.timeout ?? 300,
        ...(mcp.envKeys?.length ? { env_keys: mcp.envKeys } : {}),
        ...(mcp.envs && Object.keys(mcp.envs).length ? { envs: mcp.envs } : {}),
      };
    case "streamable_http":
      return {
        type: "streamable_http",
        name: mcp.name,
        uri: mcp.uri,
        ...(mcp.headers ? { headers: mcp.headers } : {}),
        timeout: mcp.timeout ?? 60,
      };
  }
}

/**
 * Monta o objeto recipe em memória (mesmo shape do YAML gerado pelo antigo
 * recipes/build.ts) e devolve o deeplink base64 pro `_meta.recipeDeeplink` do
 * newSession ACP. O Hindsight deixou de ser build-time: vira toggle nos
 * settings do harness goose do agente — se ligado, a extension entra aqui.
 */
export function buildGooseRecipe(input: GooseRecipeInput): BuiltGooseRecipe {
  const provider = String(input.settings.provider ?? "openrouter");
  // D10: openai-compatible = provider "openai" do goose apontado pra base URL
  // custom (gateways próprios, LiteLLM, vLLM…). O adapter injeta OPENAI_HOST/
  // OPENAI_API_KEY no env do processo.
  const gooseProvider = provider === "openai-compatible" ? "openai" : provider;

  const extensions = input.mcpServers.map(gooseExtension);

  const hindsight = (input.settings.hindsight ?? {}) as HindsightSettings;
  if (hindsight.enabled) {
    const baseUrl = hindsight.baseUrl ?? "http://hindsight:8888";
    const bankId = hindsight.bankId ?? "orchestrator";
    extensions.push({
      type: "streamable_http",
      name: "hindsight",
      uri: `${baseUrl}/mcp/${bankId}/`,
      // Credencial resolvida pelo goose em runtime do próprio ambiente — nunca
      // fica gravada na config (mesmo padrão do antigo build.ts).
      headers: { Authorization: "Bearer ${HINDSIGHT_API_KEY}" },
      timeout: 60,
    });
  }

  const instructions = appendPipelinePolicy(
    `${input.soulMarkdown.trimEnd()}\n\n---\n\n${communicationProtocol()}`,
    input.role
  );
  const raw: Record<string, unknown> = {
    version: "1.0.0",
    title: input.roleMeta.title,
    description: input.roleMeta.description,
    prompt: input.roleMeta.prompt,
    settings: {
      goose_provider: gooseProvider,
      ...(input.model ? { goose_model: input.model } : {}),
    },
    extensions,
    instructions,
  };
  return {
    deeplink: Buffer.from(JSON.stringify(raw), "utf8").toString("base64"),
    provider,
    model: input.model ?? undefined,
    raw,
  };
}

/** Reemite o deeplink com `settings.goose_model` substituído (auto-router). */
export function gooseRecipeWithModel(base: BuiltGooseRecipe, model: string): BuiltGooseRecipe {
  if (base.model === model) return base;
  const raw = structuredClone(base.raw);
  const settings =
    raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
      ? { ...(raw.settings as Record<string, unknown>) }
      : {};
  settings.goose_model = model;
  raw.settings = settings;
  return {
    deeplink: Buffer.from(JSON.stringify(raw), "utf8").toString("base64"),
    provider: base.provider,
    model,
    raw,
  };
}

/** Non-Goose system prompt: SOUL + protocol + overlay (if any) + role brief. ACP adapters do not call this yet — see knowledge/product/pipeline-policy-overlay.md. */
export function buildSystemPrompt(
  soulMarkdown: string,
  roleMeta: Pick<RoleMeta, "prompt">,
  role: AgentRole
): string {
  const instructions = appendPipelinePolicy(
    `${soulMarkdown.trimEnd()}\n\n---\n\n${communicationProtocol()}`,
    role
  );
  return `${instructions}\n\n---\n\n${roleMeta.prompt}`;
}

// Cache por (agentVersionId, harnessId, model, configUpdatedAt) — invalidado
// naturalmente porque a chave muda quando qualquer componente muda (§6.3).
const recipeCache = new Map<string, BuiltGooseRecipe>();

export function cachedGooseRecipe(cacheKey: string, build: () => BuiltGooseRecipe): BuiltGooseRecipe {
  const hit = recipeCache.get(cacheKey);
  if (hit) return hit;
  const built = build();
  recipeCache.set(cacheKey, built);
  // Guarda-chuva simples contra crescimento sem fim (versões antigas somem do uso).
  if (recipeCache.size > 64) {
    const first = recipeCache.keys().next().value;
    if (first) recipeCache.delete(first);
  }
  return built;
}

/** Snapshot efetivo do run (§6.4) — segredos OMITIDOS por construção. */
export function resolvedConfigSnapshot(input: {
  harnessId: string;
  model?: string | null;
  provider?: string;
  settings: Record<string, unknown>;
  mcpServers: McpServerConfig[];
}): string {
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.settings)) {
    // Omitidos, não mascarados: snapshot não guarda credencial (§6.4).
    if (k === "keyOverride" || k === "apiKey") continue;
    settings[k] = v;
  }
  return JSON.stringify({
    harnessId: input.harnessId,
    model: input.model ?? null,
    provider: input.provider,
    settings,
    mcpServers: input.mcpServers.map((m) => ({
      name: m.name,
      type: m.type,
      ...(m.type === "stdio" ? { cmd: m.cmd, args: m.args, envKeys: m.envKeys } : {}),
      ...(m.type === "streamable_http" ? { uri: m.uri } : {}),
    })),
  });
}
