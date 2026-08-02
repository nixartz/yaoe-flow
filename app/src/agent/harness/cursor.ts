// Adapter Cursor (§7.2): ACP via `cursor-agent acp` — mesmo cliente genérico
// do Goose/Claude/Codex. Fluxo oficial (https://cursor.com/docs/cli/acp):
// initialize → authenticate(cursor_login) → session/new → session/prompt,
// com session/update (step-by-step) e session/request_permission.
// Auth: CLI logado (`agent login`) ou CURSOR_API_KEY (D5/D6).
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../../config";
import { log, errFields } from "../../logger";
import { createAcpAdapter, detectByVersionFlag, type AcpSpawnContext, type AcpSpawnPrep } from "./acpAdapter";
import { hostHome, mirrorDirExcept, writeCursorCliAttribution } from "./attribution";
import { applyGhIsolation, HOST_GIT_ENTRIES_TO_ISOLATE } from "./gitRunEnv";

function buildEnv(input: AcpSpawnContext): Record<string, string> {
  const env = { ...input.env };
  const apiKey = (input.settings.apiKey as string | undefined) || env.CURSOR_API_KEY;
  if (apiKey) env.CURSOR_API_KEY = apiKey;
  if (!env.LINEAR_API_TOKEN && env.LINEAR_API_KEY) env.LINEAR_API_TOKEN = env.LINEAR_API_KEY;
  if (!env.GITHUB_PERSONAL_ACCESS_TOKEN && env.GITHUB_TOKEN) env.GITHUB_PERSONAL_ACCESS_TOKEN = env.GITHUB_TOKEN;
  return env;
}

/**
 * HOME isolado do run — o motivo pelo qual o Cursor não funcionava como harness.
 *
 * `cursor-agent` resolve MCP como `homedir()/.cursor/mcp.json` MERGEADO com
 * `<cwd>/.cursor/mcp.json`, e não existe flag pra desligar o nível de usuário
 * (CURSOR_CONFIG_DIR não cobre o mcp.json). Como o daemon roda com o HOME da
 * pessoa, todo run herdava os MCPs da máquina: no caso que motivou este fix,
 * 13 servidores — dois deles `@tacticlaunch/mcp-linear`, 198 tools CADA — e o
 * provider recusava o turno inteiro com "Too many MCP tools are enabled for
 * this model", sem nem chamar o modelo.
 *
 * Solução: um HOME por run que é um espelho de symlinks do HOME real, trocando
 * SÓ o `~/.cursor/mcp.json` por um vazio. Espelhar (em vez de HOME limpo)
 * preserva keychain (`~/Library` — a auth do Cursor sai daí; com HOME limpo o
 * `authenticate` morre em "Security process exited with code: 154"), npm/bun e
 * o resto do estado do `~/.cursor` (inclusive as sessões ACP).
 * Os MCPs de verdade entram pelo `session/new`, em memória — segredo nenhum
 * toca disco (invariante do repo).
 *
 * git/gh são a exceção ao espelho (D6): symlink faria `gh auth login` e
 * `git config --global` do agent reescreverem os arquivos DA PESSOA que roda o
 * daemon. Então:
 *   - `.gitconfig` é COPIADO (arquivo real) — preserva user.name/user.email
 *     pro commit funcionar, e o que o agent escrever morre com o run;
 *   - `.config` vira dir espelhado com `gh` como dir real vazio + GH_CONFIG_DIR;
 *   - `.git-credentials` fica de fora — a credencial do run vem do
 *     `insteadOf` no env (gitRunEnv.ts), não do disco.
 *
 * `cli-config.json` também fica de fora do espelho: o orquestrador escreve a
 * atribuição/co-autoria (`CURSOR_ATTRIBUTION`) no arquivo do run — senão o
 * symlink herdaria a preferência do host e o flag da dashboard não valeria.
 */
export function isolatedCursorHome(input: AcpSpawnContext, env: Record<string, string>): AcpSpawnPrep {
  if (!config.cursor.isolateMcpConfig) {
    // Sem HOME isolado ainda dá pra forçar atribuição via CURSOR_CONFIG_DIR
    // (docs: custom directory com cli-config.json).
    const configDir = `${input.cwd.replace(/[/\\]+$/, "")}-cursor-config`;
    try {
      mkdirSync(configDir, { recursive: true });
      writeCursorCliAttribution(configDir, config.cursor.attribution);
      return {
        env: { ...env, CURSOR_CONFIG_DIR: configDir },
        cleanup() {
          rmSync(configDir, { recursive: true, force: true });
        },
      };
    } catch (e) {
      log.agent.warn(
        { harness: "cursor", runId: input.runId, ...errFields(e) },
        "não foi possível montar CURSOR_CONFIG_DIR pra atribuição — seguindo sem override"
      );
      return { env };
    }
  }

  // Irmão do workspace do run (não DENTRO dele: o agente lista o próprio cwd).
  const homeDir = `${input.cwd.replace(/[/\\]+$/, "")}-home`;
  const realHome = hostHome(env);
  try {
    mkdirSync(dirname(homeDir), { recursive: true });
    rmSync(homeDir, { recursive: true, force: true });
    mirrorDirExcept(realHome, homeDir, [".cursor", ...HOST_GIT_ENTRIES_TO_ISOLATE]);

    // mcp.json vazio + cli-config.json com atribuição do orquestrador.
    mirrorDirExcept(join(realHome, ".cursor"), join(homeDir, ".cursor"), ["mcp.json", "cli-config.json"]);
    writeFileSync(join(homeDir, ".cursor", "mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    const hostCliConfig = join(realHome, ".cursor", "cli-config.json");
    try {
      copyFileSync(hostCliConfig, join(homeDir, ".cursor", "cli-config.json"));
    } catch {
      /* host sem cli-config — writeCursorCliAttribution cria o mínimo */
    }
    writeCursorCliAttribution(join(homeDir, ".cursor"), config.cursor.attribution);

    // `~/.config` pode nem existir (macOS) — o espelho falha soft e o que
    // importa (o dir `gh` vazio) é criado logo abaixo de qualquer forma.
    try {
      mirrorDirExcept(join(realHome, ".config"), join(homeDir, ".config"), ["gh"]);
    } catch {
      mkdirSync(join(homeDir, ".config"), { recursive: true });
    }
    mkdirSync(join(homeDir, ".config", "gh"), { recursive: true });

    // Cópia, não link: o agent pode rodar `git config --global` à vontade.
    try {
      copyFileSync(join(realHome, ".gitconfig"), join(homeDir, ".gitconfig"));
    } catch {
      // Host sem .gitconfig: a identidade vem do env (GIT_AUTHOR_NAME etc.).
    }
  } catch (e) {
    // Sem isolamento o run provavelmente falha no provider, mas falhar AQUI
    // esconderia a causa — segue com o HOME real e deixa o erro aparecer.
    log.agent.warn(
      { harness: "cursor", runId: input.runId, homeDir, ...errFields(e) },
      "não foi possível montar o HOME isolado do run — seguindo com o HOME real (MCPs da máquina podem estourar o limite de tools)"
    );
    return { env };
  }

  const isolatedEnv = { ...env, HOME: homeDir };
  applyGhIsolation(isolatedEnv, homeDir);
  return {
    env: isolatedEnv,
    cleanup() {
      // Symlinks + mcp.json + a cópia do .gitconfig: `rmSync` não segue link,
      // então isto NUNCA apaga nada do HOME real.
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

export const cursorAdapter = createAcpAdapter({
  id: "cursor",
  label: "Cursor",
  bin: "cursor-agent",
  args: ["acp"],
  authenticateMethodId: "cursor_login",
  capabilities: {
    integration: "acp",
    // O Cursor enumera os modelos no `session/new` (`models.availableModels`),
    // com id parametrizado (`default[]`, `composer-2.5[fast=true]`) — quem
    // resolve o que está configurado contra essa lista é resolveAcpModelId.
    modelSelection: "list",
    // Verificado contra cursor-agent 2026.07.23: nenhum token/custo chega, nem
    // na resposta do `session/prompt` nem via `usage_update` — a conta é da
    // assinatura, então declarar "tokens" só produziria zero na dashboard.
    usageReporting: "none",
    costSource: "subscription",
    // session/load existe no docs, mas o suporte real ainda é incompleto —
    // mantemos false até smoke confirmar resume estável.
    sessionResume: false,
    mcp: true,
    kill: true,
  },
  detect: () =>
    detectByVersionFlag("cursor-agent", {
      authEnvVar: "CURSOR_API_KEY",
      installHint: "curl -fsS https://cursor.com/install | bash  (cria cursor-agent em ~/.local/bin)",
    }),
  buildEnv,
  prepareSpawn: isolatedCursorHome,
});
