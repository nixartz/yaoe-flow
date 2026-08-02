// Auto Router por recipe: quando OPENROUTER_AUTO_ROUTER=true, o goose manda
// model=openrouter/auto-beta + plugins.auto-router (allowed_models / tradeoff)
// via OPENROUTER_PARAMETERS. Config por recipe em OPENROUTER_AUTO_CONFIG (JSON).
import { log } from "../logger";

export const OPENROUTER_AUTO_BETA_MODEL = "openrouter/auto-beta";

export interface OpenRouterAutoRecipeConfig {
  recipeName: string;
  allowedModels: string[];
  costQualityTradeoff: number;
}

export interface ResolvedAutoRouter {
  /** true = usar auto-beta + plugins neste recipe */
  enabled: boolean;
  model: string;
  allowedModels?: string[];
  costQualityTradeoff?: number;
}

function normalizeRecipeName(name: string): string {
  return name.replace(/\.ya?ml$/i, "").trim();
}

function parseAutoConfig(raw: string): OpenRouterAutoRecipeConfig[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.openrouter.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "OPENROUTER_AUTO_CONFIG JSON inválido — auto-router por recipe desligado"
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.openrouter.warn("OPENROUTER_AUTO_CONFIG deve ser um array JSON — ignorando");
    return [];
  }

  const out: OpenRouterAutoRecipeConfig[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const recipeName = typeof row.recipeName === "string" ? normalizeRecipeName(row.recipeName) : "";
    if (!recipeName) continue;

    const rawModels = row.allowed_models ?? row.allowedModels;
    const allowedModels = Array.isArray(rawModels)
      ? rawModels.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim())
      : [];

    const tradeoffRaw = row.cost_quality_tradeoff ?? row.costQualityTradeoff;
    let costQualityTradeoff = 7;
    if (typeof tradeoffRaw === "number" && Number.isFinite(tradeoffRaw)) {
      costQualityTradeoff = Math.max(0, Math.min(10, Math.round(tradeoffRaw)));
    } else if (typeof tradeoffRaw === "string" && tradeoffRaw.trim() !== "") {
      const n = Number(tradeoffRaw);
      if (Number.isFinite(n)) costQualityTradeoff = Math.max(0, Math.min(10, Math.round(n)));
    }

    out.push({ recipeName, allowedModels, costQualityTradeoff });
  }
  return out;
}

let cachedRaw: string | undefined;
let cachedParsed: OpenRouterAutoRecipeConfig[] = [];

function autoConfigEntries(): OpenRouterAutoRecipeConfig[] {
  const raw = process.env.OPENROUTER_AUTO_CONFIG ?? "";
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedParsed = parseAutoConfig(raw);
  }
  return cachedParsed;
}

export function isOpenRouterAutoRouterEnabled(): boolean {
  return (process.env.OPENROUTER_AUTO_ROUTER ?? "false") === "true";
}

/**
 * Resolve model + plugins auto-router para um recipe.
 * - AUTO_ROUTER=false → enabled=false (caller mantém model do recipe)
 * - match com allowed_models → auto-beta + plugins
 * - sem match / lista vazia → model = GOOSE_MODEL (fallback)
 */
export function resolveAutoRouterForRecipe(recipeName: string): ResolvedAutoRouter {
  const fallbackModel = (process.env.GOOSE_MODEL ?? "").trim() || OPENROUTER_AUTO_BETA_MODEL;

  if (!isOpenRouterAutoRouterEnabled()) {
    return { enabled: false, model: fallbackModel };
  }

  const key = normalizeRecipeName(recipeName);
  const entry = autoConfigEntries().find((e) => e.recipeName === key);
  if (!entry || entry.allowedModels.length === 0) {
    return { enabled: false, model: fallbackModel };
  }

  return {
    enabled: true,
    model: OPENROUTER_AUTO_BETA_MODEL,
    allowedModels: entry.allowedModels,
    costQualityTradeoff: entry.costQualityTradeoff,
  };
}

/** Plugin object para o body OpenRouter (docs auto-router / auto-beta). */
export function autoRouterPluginPayload(resolved: ResolvedAutoRouter): Record<string, unknown> | null {
  if (!resolved.enabled || !resolved.allowedModels?.length) return null;
  return {
    id: "auto-router",
    allowed_models: resolved.allowedModels,
    cost_quality_tradeoff: resolved.costQualityTradeoff ?? 7,
  };
}
