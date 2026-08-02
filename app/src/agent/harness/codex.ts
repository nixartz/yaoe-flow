// Adapter Codex (§7.2): ACP via `codex-acp` (adapter Zed sobre o CLI `codex`).
// Auth: CLI logado (plano ChatGPT, D5) OU OPENAI_API_KEY no settings do agente.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../../config";
import { log, errFields } from "../../logger";
import { createAcpAdapter, detectByVersionFlag, type AcpSpawnContext, type AcpSpawnPrep } from "./acpAdapter";
import { hostHome, mirrorDirExcept, writeCodexCommitAttribution } from "./attribution";

function buildEnv(input: AcpSpawnContext): Record<string, string> {
  const env = { ...input.env };
  const apiKey = (input.settings.apiKey as string | undefined) || env.OPENAI_API_KEY;
  if (apiKey) env.OPENAI_API_KEY = apiKey;
  if (!env.LINEAR_API_TOKEN && env.LINEAR_API_KEY) env.LINEAR_API_TOKEN = env.LINEAR_API_KEY;
  if (!env.GITHUB_PERSONAL_ACCESS_TOKEN && env.GITHUB_TOKEN) env.GITHUB_PERSONAL_ACCESS_TOKEN = env.GITHUB_TOKEN;
  return env;
}

/**
 * `CODEX_HOME` por run com `commit_attribution` do orquestrador.
 * Espelha `~/.codex` (auth/histórico) e reescreve só a chave no `config.toml`.
 * `commit_attribution = ""` desliga o trailer (docs Codex).
 */
export function prepareCodexAttribution(input: AcpSpawnContext, env: Record<string, string>): AcpSpawnPrep {
  const codexHome = `${input.cwd.replace(/[/\\]+$/, "")}-codex-home`;
  const realCodex = join(hostHome(env), ".codex");
  try {
    mkdirSync(dirname(codexHome), { recursive: true });
    rmSync(codexHome, { recursive: true, force: true });
    mirrorDirExcept(realCodex, codexHome, ["config.toml"]);
    try {
      copyFileSync(join(realCodex, "config.toml"), join(codexHome, "config.toml"));
    } catch {
      /* host sem config — writeCodexCommitAttribution cria o mínimo */
    }
    writeCodexCommitAttribution(codexHome, config.codex.attribution);
    return {
      env: { ...env, CODEX_HOME: codexHome },
      cleanup() {
        rmSync(codexHome, { recursive: true, force: true });
      },
    };
  } catch (e) {
    log.agent.warn(
      { harness: "codex", runId: input.runId, codexHome, ...errFields(e) },
      "não foi possível montar CODEX_HOME pra atribuição — seguindo com ~/.codex do host"
    );
    return { env };
  }
}

export const codexAdapter = createAcpAdapter({
  id: "codex",
  label: "Codex",
  bin: "codex-acp",
  capabilities: {
    integration: "acp",
    modelSelection: "list",
    usageReporting: "tokens+cost",
    costSource: "api",
    sessionResume: true,
    mcp: true,
    kill: true,
  },
  detect: () =>
    detectByVersionFlag("codex-acp", {
      authEnvVar: "OPENAI_API_KEY",
      installHint: "npm i -g @zed-industries/codex-acp (requer CLI `codex` no PATH)",
    }),
  buildEnv,
  prepareSpawn: prepareCodexAttribution,
});
