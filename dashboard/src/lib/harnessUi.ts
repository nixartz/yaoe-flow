import type { HarnessCapabilities } from "@/lib/api";

const INTEGRATION: Record<HarnessCapabilities["integration"], string> = {
  acp: "Integração ACP",
  native: "Integração nativa",
  http: "Integração HTTP",
};

const MODEL_SELECTION: Record<HarnessCapabilities["modelSelection"], string> = {
  list: "Lista de modelos",
  flag: "Modelo por flag",
  none: "Sem escolha de modelo",
};

const USAGE: Record<HarnessCapabilities["usageReporting"], string> = {
  "tokens+cost": "Relata tokens e custo",
  tokens: "Relata tokens",
  none: "Sem relatório de uso",
};

const COST: Record<HarnessCapabilities["costSource"], string> = {
  api: "Custo via API",
  subscription: "Assinatura (sem USD)",
};

export function capabilityChips(caps: HarnessCapabilities): Array<{ key: string; label: string; tip?: string }> {
  const chips: Array<{ key: string; label: string; tip?: string }> = [
    { key: "integration", label: INTEGRATION[caps.integration] ?? caps.integration },
    { key: "model", label: MODEL_SELECTION[caps.modelSelection] ?? caps.modelSelection },
    { key: "usage", label: USAGE[caps.usageReporting] ?? caps.usageReporting },
    { key: "cost", label: COST[caps.costSource] ?? caps.costSource },
  ];
  if (caps.sessionResume) chips.push({ key: "resume", label: "Retoma sessão", tip: "Pode continuar uma sessão anterior" });
  if (caps.mcp) chips.push({ key: "mcp", label: "Suporta MCP", tip: "Aceita servidores MCP configurados no agente" });
  if (caps.kill) chips.push({ key: "kill", label: "Pode interromper", tip: "O orquestrador consegue encerrar o processo" });
  return chips;
}

/** Prioridade para ordenar cards: atenção primeiro. */
export function harnessAttentionScore(detection: {
  installed?: boolean;
  authStatus?: string;
} | null): number {
  if (!detection?.installed) return 0;
  if (detection.authStatus === "not-logged") return 1;
  if (detection.authStatus === "unknown") return 2;
  return 3;
}
