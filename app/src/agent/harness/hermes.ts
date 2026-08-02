// Adapter Hermes (§7.2) — HTTP, intocado ("igual já é hoje"): fire-and-report
// via /v1/runs (dispatch) e /v1/chat/completions (planning síncrono). Sem
// trace/kill/resume — degradação conhecida e aceita (D4); não se gasta
// esforço melhorando o Hermes nesta iniciativa.
import { config } from "../../config";
import { toAgentRole } from "../recipe/defaults";
import { log } from "../../logger";
import type { HarnessAdapter, HarnessDetection, HarnessRun, HarnessRunInput } from "./types";

interface HermesSettings {
  profileModel?: string;
  urlOverride?: string;
  keyOverride?: string;
}

function resolveProfile(input: HarnessRunInput): { url: string; apiKey: string; model: string } {
  const s = input.settings as HermesSettings;
  // Fallback POR PAPEL (comportamento pré-multi-harness): sem override no
  // agente, vale o perfil HERMES_<PAPEL>_* / HERMES_BASE_URL da config — nunca
  // o perfil de outro papel.
  const base = config.hermes.profiles[toAgentRole(input.role)];
  return {
    url: s.urlOverride || base.url,
    apiKey: s.keyOverride || base.apiKey,
    model: input.model || s.profileModel || base.model,
  };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

function createRun(input: HarnessRunInput): HarnessRun {
  const profile = resolveProfile(input);

  const result = (async () => {
    if (input.kind === "planning") {
      const res = await fetch(`${profile.url}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(profile.apiKey),
        body: JSON.stringify({ model: profile.model, messages: [{ role: "user", content: input.promptText }] }),
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
      if (!res.ok) throw new Error(`Hermes /v1/chat/completions (${profile.model}) ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const outputText = json.choices?.[0]?.message?.content ?? "";
      input.onEvent({ kind: "agent_message_chunk", text: outputText, payload: json });
      return {
        outputText,
        usage: json.usage
          ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
          : undefined,
        finalStatus: "completed" as const,
      };
    }

    const res = await fetch(`${profile.url}/v1/runs`, {
      method: "POST",
      headers: authHeaders(profile.apiKey),
      body: JSON.stringify({ model: profile.model, input: input.promptText }),
      signal: AbortSignal.timeout(config.httpTimeoutMs),
    });
    if (!res.ok) throw new Error(`Hermes /v1/runs (${profile.model}) ${res.status}: ${await res.text()}`);
    log.hermes.info({ role: input.role, model: profile.model }, "Hermes run dispatched (fire-and-report)");
    return { outputText: "", finalStatus: "dispatched" as const };
  })();

  return {
    result,
    kill() {
      // Hermes roda na infra do gateway — não há processo local para matar.
    },
  };
}

async function detect(): Promise<HarnessDetection> {
  try {
    const res = await fetch(`${config.hermes.profiles.pmo.url}/v1/models`, {
      signal: AbortSignal.timeout(3_000),
      headers: authHeaders(config.hermes.profiles.pmo.apiKey),
    });
    return { installed: true, authStatus: res.ok ? "ok" : "not-logged", checkedAt: Date.now() };
  } catch {
    return {
      installed: false,
      authStatus: "unknown",
      installHint:
        "Hermes é gateway HTTP (não ACP). Suba o Hermes Agent e configure HERMES_*_URL — ver docs/hermes-setup.md",
      checkedAt: Date.now(),
    };
  }
}

export const hermesAdapter: HarnessAdapter = {
  id: "hermes",
  label: "Hermes",
  capabilities: {
    integration: "http",
    modelSelection: "flag",
    usageReporting: "tokens",
    costSource: "api",
    sessionResume: false,
    mcp: false,
    kill: false,
  },
  detect,
  createRun,
};
