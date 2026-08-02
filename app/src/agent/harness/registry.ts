// Registry dos 6 harness (D4) — mapa id → adapter + matriz de capabilities
// exposta pra tela Harness (§7.4). Ponto único de import dos 6 módulos.
import { gooseAdapter } from "./goose";
import { hermesAdapter } from "./hermes";
import { claudeCodeAdapter } from "./claudeCode";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { copilotAdapter } from "./copilot";
import type { HarnessAdapter, HarnessId } from "./types";
import { HARNESS_IDS } from "./types";

export const HARNESS_ADAPTERS: Record<HarnessId, HarnessAdapter> = {
  goose: gooseAdapter,
  hermes: hermesAdapter,
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  copilot: copilotAdapter,
};

export function harnessAdapter(id: string): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS[id as HarnessId];
}

export function listHarnessIds(): HarnessId[] {
  return HARNESS_IDS;
}
