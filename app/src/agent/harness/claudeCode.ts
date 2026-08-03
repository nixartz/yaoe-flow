// Adapter Claude Code (§7.2): ACP via `claude-code-acp` (adapter Zed, maduro
// — wrapper ACP oficial sobre o CLI `claude`). Auth: CLI logado na máquina
// (conta Max/assinatura, D5) OU ANTHROPIC_API_KEY no settings do agente (nesse
// caso costSource é "api", não "subscription").
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../../config";
import { log, errFields } from "../../logger";
import { createAcpAdapter, detectByVersionFlag, type AcpSpawnContext, type AcpSpawnPrep } from "./acpAdapter";
import { hostHome, mirrorDirExcept, writeClaudeCodeAttribution } from "./attribution";

function buildEnv(input: AcpSpawnContext): Record<string, string> {
  const env = { ...input.env };
  const apiKey = (input.settings.apiKey as string | undefined) || env.ANTHROPIC_API_KEY;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  if (!env.LINEAR_API_TOKEN && env.LINEAR_API_KEY) env.LINEAR_API_TOKEN = env.LINEAR_API_KEY;
  if (!env.GITHUB_PERSONAL_ACCESS_TOKEN && env.GITHUB_TOKEN) env.GITHUB_PERSONAL_ACCESS_TOKEN = env.GITHUB_TOKEN;
  return env;
}

/**
 * `CLAUDE_CONFIG_DIR` por run com atribuição do orquestrador.
 * Espelha `~/.claude` (auth/sessões/plugins) e substitui só `settings.json`
 * — assim o flag `CLAUDE_CODE_ATTRIBUTION` vale sem tocar o config do host e
 * sem perder o login (Keychain no macOS; credentials no dir no Linux).
 * https://code.claude.com/docs/en/settings#attribution-settings
 */
export function prepareClaudeCodeAttribution(input: AcpSpawnContext, env: Record<string, string>): AcpSpawnPrep {
  const configDir = `${input.cwd.replace(/[/\\]+$/, "")}-claude-config`;
  const realClaude = join(hostHome(env), ".claude");
  try {
    mkdirSync(dirname(configDir), { recursive: true });
    rmSync(configDir, { recursive: true, force: true });
    mirrorDirExcept(realClaude, configDir, ["settings.json"]);
    try {
      copyFileSync(join(realClaude, "settings.json"), join(configDir, "settings.json"));
    } catch {
      /* host sem settings — writeClaudeCodeAttribution cria do zero */
    }
    writeClaudeCodeAttribution(configDir, config.claudeCode.attribution);
    return {
      env: { ...env, CLAUDE_CONFIG_DIR: configDir },
      cleanup() {
        rmSync(configDir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    log.agent.warn(
      { harness: "claude-code", runId: input.runId, configDir, ...errFields(e) },
      "could not build CLAUDE_CONFIG_DIR for attribution — continuing with the host's ~/.claude"
    );
    return { env };
  }
}

export const claudeCodeAdapter = createAcpAdapter({
  id: "claude-code",
  label: "Claude Code",
  bin: "claude-code-acp",
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
    detectByVersionFlag("claude-code-acp", {
      authEnvVar: "ANTHROPIC_API_KEY",
      installHint: "npm i -g @zed-industries/claude-code-acp (requer CLI `claude` no PATH)",
    }),
  buildEnv,
  prepareSpawn: prepareClaudeCodeAttribution,
});
