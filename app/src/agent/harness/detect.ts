// Serviço de detecção (§7.4): sonda cada harness (instalado/versão/auth) e
// cacheia na tabela `harnesses`. Roda no boot + botão "re-detectar" na UI.
import { eq } from "drizzle-orm";
import { appDb } from "../../db";
import { harnesses } from "../../db/schema";
import { log, errFields } from "../../logger";
import { HARNESS_ADAPTERS } from "./registry";
import type { HarnessDetection, HarnessId } from "./types";

export interface HarnessBudgets {
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  /** USD quando costSource=api; TOKENS como proxy quando subscription. */
  unit: "usd" | "tokens";
  action: "avisar" | "pausar";
}

const DEFAULT_BUDGETS: HarnessBudgets = { unit: "usd", action: "avisar" };

export function getBudgets(harnessId: HarnessId): HarnessBudgets {
  const row = appDb().orm.select().from(harnesses).where(eq(harnesses.id, harnessId)).get();
  if (!row) return DEFAULT_BUDGETS;
  try {
    return { ...DEFAULT_BUDGETS, ...(JSON.parse(row.budgetsJson) as Partial<HarnessBudgets>) };
  } catch {
    return DEFAULT_BUDGETS;
  }
}

export function setBudgets(harnessId: HarnessId, budgets: HarnessBudgets): void {
  const now = Date.now();
  appDb()
    .orm.insert(harnesses)
    .values({ id: harnessId, detectionJson: null, budgetsJson: JSON.stringify(budgets), updatedAt: now })
    .onConflictDoUpdate({ target: harnesses.id, set: { budgetsJson: JSON.stringify(budgets), updatedAt: now } })
    .run();
}

export function getCachedDetection(harnessId: HarnessId): HarnessDetection | null {
  const row = appDb().orm.select().from(harnesses).where(eq(harnesses.id, harnessId)).get();
  if (!row?.detectionJson) return null;
  try {
    return JSON.parse(row.detectionJson) as HarnessDetection;
  } catch {
    return null;
  }
}

/**
 * Sonda os modelos do harness junto da detecção — é o que alimenta o select de
 * modelo no editor de agente (em vez de texto livre, onde `auto` virava um
 * `Invalid model value` só descoberto no meio do run).
 *
 * Custa um spawn do CLI, mas ZERO token (a lista vem do `session/new`, sem
 * prompt). Best-effort: falha aqui nunca invalida a detecção — só deixa a
 * dashboard sem lista, caindo no campo livre.
 */
async function probeModels(id: HarnessId, detection: HarnessDetection): Promise<HarnessDetection> {
  const adapter = HARNESS_ADAPTERS[id];
  if (!adapter.listModels || !detection.installed) return detection;
  // CLI não logado: a sonda falharia no authenticate e só gastaria tempo.
  if (detection.authStatus === "not-logged") return detection;
  try {
    const { models, defaultModelId } = await adapter.listModels();
    if (models.length === 0) return detection;
    log.server.info({ harness: id, models: models.length, defaultModelId }, "harness: modelos enumerados");
    return { ...detection, models, ...(defaultModelId ? { defaultModelId } : {}) };
  } catch (e) {
    log.server.warn(
      { harness: id, ...errFields(e) },
      "não foi possível enumerar os modelos do harness — a dashboard fica no campo de texto livre"
    );
    return detection;
  }
}

async function detectAndStore(id: HarnessId): Promise<HarnessDetection> {
  const adapter = HARNESS_ADAPTERS[id];
  let detection: HarnessDetection;
  try {
    detection = await adapter.detect();
  } catch (e) {
    log.server.warn({ harness: id, ...errFields(e) }, "harness detect() falhou — marcando como não instalado");
    detection = { installed: false, authStatus: "unknown", checkedAt: Date.now() };
  }
  detection = await probeModels(id, detection);
  const now = Date.now();
  appDb()
    .orm.insert(harnesses)
    .values({ id, detectionJson: JSON.stringify(detection), budgetsJson: JSON.stringify(DEFAULT_BUDGETS), updatedAt: now })
    .onConflictDoUpdate({ target: harnesses.id, set: { detectionJson: JSON.stringify(detection), updatedAt: now } })
    .run();
  return detection;
}

export async function detectAllHarnesses(): Promise<Record<HarnessId, HarnessDetection>> {
  const ids = Object.keys(HARNESS_ADAPTERS) as HarnessId[];
  const entries = await Promise.all(ids.map(async (id) => [id, await detectAndStore(id)] as const));
  return Object.fromEntries(entries) as Record<HarnessId, HarnessDetection>;
}

export async function redetectHarness(id: HarnessId): Promise<HarnessDetection> {
  return detectAndStore(id);
}

export function harnessReport(): Array<{
  id: HarnessId;
  label: string;
  capabilities: (typeof HARNESS_ADAPTERS)[HarnessId]["capabilities"];
  detection: HarnessDetection | null;
  budgets: HarnessBudgets;
}> {
  return (Object.keys(HARNESS_ADAPTERS) as HarnessId[]).map((id) => ({
    id,
    label: HARNESS_ADAPTERS[id].label,
    capabilities: HARNESS_ADAPTERS[id].capabilities,
    detection: getCachedDetection(id),
    budgets: getBudgets(id),
  }));
}
