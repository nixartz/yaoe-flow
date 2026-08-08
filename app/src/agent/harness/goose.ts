// Adapter Goose (§7.2) — ACP via `goose acp`, agora sobre o cliente genérico
// (app/src/agent/acp/client.ts). Comportamento idêntico ao goose.ts original
// (mesmo truque GIT_CONFIG_COUNT, mesmo proxy OpenRouter, mesmo auto-router),
// só que o recipe vem do BUILDER EM RUNTIME (§6.3) em vez de um .yaml em disco.
import { existsSync, readFileSync } from "node:fs";
import { config } from "../../config";
import { resolveHarnessBin, withHarnessSpawnEnv } from "../../cli/setup/harnessDeps";
import { agentLog, errFields } from "../../logger";
import {
  proxyBaseUrl,
  registerOpenRouterRun,
  resolveAutoRouterForRecipe,
  autoRouterPluginPayload,
  isOpenRouterAutoRouterEnabled,
} from "../../openrouter";
import {
  runAcpTurn,
  stripLinearApiSecretsFromEnv,
  type AcpProcess,
} from "../acp/client";
import { cleanupAfterRun } from "../workspace";
import { buildGooseRecipe, gooseRecipeWithModel, cachedGooseRecipe, type BuiltGooseRecipe } from "../recipe/builder";
import { withGitHttpsInsteadOf } from "./gitRunEnv";
import type { HarnessAdapter, HarnessDetection, HarnessRun, HarnessRunInput } from "./types";

/**
 * Copia `env_keys` → `envs` com valores do ambiente do run e remove `env_keys`.
 * O processo goose pode então perder `LINEAR_API_*` sem quebrar o MCP Linear.
 */
function injectMcpSecretsIntoGooseRecipe(recipe: BuiltGooseRecipe, env: Record<string, string>): BuiltGooseRecipe {
  const raw = structuredClone(recipe.raw);
  const extensions = Array.isArray(raw.extensions) ? (raw.extensions as Record<string, unknown>[]) : [];
  for (const ext of extensions) {
    if (ext.type !== "stdio") continue;
    const keys = ext.env_keys as string[] | undefined;
    if (!keys?.length) continue;
    const envs = { ...((ext.envs as Record<string, string> | undefined) ?? {}) };
    for (const k of keys) {
      if (env[k]) envs[k] = env[k];
    }
    ext.envs = envs;
    delete ext.env_keys;
  }
  raw.extensions = extensions;
  return {
    ...recipe,
    raw,
    deeplink: Buffer.from(JSON.stringify(raw), "utf8").toString("base64"),
  };
}

let extraEnv: Record<string, string> | null = null;
function loadExtraEnv(): Record<string, string> {
  if (extraEnv === null) {
    extraEnv = {};
    const f = config.goose.envFile;
    if (f && existsSync(f)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) extraEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
  return extraEnv;
}

function spawnEnv(
  input: HarnessRunInput,
  runId: string,
  recipeRole: string,
  settings: Record<string, unknown>
): Record<string, string> {
  // Base = input.env (já traz Linear + GitHub da connection, inclusive o
  // `insteadOf` de git — hoje montado central no buildRunEnv, ver gitRunEnv.ts).
  const merged = { ...input.env, ...loadExtraEnv() };
  if (!merged.LINEAR_API_TOKEN && merged.LINEAR_API_KEY) merged.LINEAR_API_TOKEN = merged.LINEAR_API_KEY;
  if (!merged.GITHUB_PERSONAL_ACCESS_TOKEN && merged.GITHUB_TOKEN) merged.GITHUB_PERSONAL_ACCESS_TOKEN = merged.GITHUB_TOKEN;
  // O env file do goose pode trazer GIT_CONFIG_* próprio e sobrescrever o do
  // run no spread acima — só nesse caso reaplica, pra credencial do run vencer.
  if (merged.GIT_CONFIG_COUNT !== input.env.GIT_CONFIG_COUNT) {
    withGitHttpsInsteadOf(merged, merged.GITHUB_TOKEN || merged.GITHUB_PERSONAL_ACCESS_TOKEN);
  }

  // D10: provider openai-compatible — baseUrl+key do settings do agente
  // (nunca ENV global; cada agente pode ter um gateway diferente).
  if (settings.provider === "openai-compatible") {
    if (typeof settings.baseUrl === "string") merged.OPENAI_HOST = settings.baseUrl;
    if (typeof settings.apiKey === "string" && settings.apiKey) merged.OPENAI_API_KEY = settings.apiKey;
  }

  let params: Record<string, unknown> = {};
  const raw = merged.OPENROUTER_PARAMETERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as Record<string, unknown>;
    } catch {
      /* recria abaixo */
    }
  }
  params.session_id = runId;
  const usageParam = params.usage;
  if (!usageParam || typeof usageParam !== "object" || Array.isArray(usageParam)) {
    params.usage = { include: true };
  }

  const auto = resolveAutoRouterForRecipe(recipeRole);
  if (auto.enabled) {
    const plugin = autoRouterPluginPayload(auto);
    if (plugin) {
      params.plugins = [plugin];
      merged.GOOSE_MODEL = auto.model;
    }
  } else if (isOpenRouterAutoRouterEnabled()) {
    if (auto.model) merged.GOOSE_MODEL = auto.model;
  }
  merged.OPENROUTER_PARAMETERS = JSON.stringify(params);

  if (config.openrouter.reconcile && settings.provider !== "openai-compatible") {
    merged.OPENROUTER_HOST = proxyBaseUrl();
  }
  return merged;
}

async function detect(): Promise<HarnessDetection> {
  try {
    const resolved = resolveHarnessBin(config.goose.bin);
    const proc = Bun.spawn([resolved, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: withHarnessSpawnEnv(process.env as Record<string, string>),
    });
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    await proc.exited;
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return {
      installed: true,
      binPath: resolved,
      version: m?.[1],
      // Goose por si não expõe "logado como X" — auth é resolvida por provider
      // (chave de API no ambiente); reportamos "ok" quando há credencial.
      authStatus: config.openrouter.apiKey || process.env.OPENAI_API_KEY ? "ok" : "unknown",
      checkedAt: Date.now(),
    };
  } catch {
    return {
      installed: false,
      authStatus: "unknown",
      installHint: "https://block.github.io/goose/docs/getting-started/installation",
      checkedAt: Date.now(),
    };
  }
}

function createRun(input: HarnessRunInput): HarnessRun {
  const model = (input.model || undefined) ?? (input.settings.model as string | undefined);
  const cacheKey = `${input.role}:${input.model ?? ""}:${JSON.stringify(input.settings)}:${JSON.stringify(input.mcpServers)}`;
  const baseRecipe = cachedGooseRecipe(cacheKey, () =>
    buildGooseRecipe({
      roleMeta: input.roleMeta,
      soulMarkdown: input.systemPrompt,
      model,
      settings: input.settings,
      mcpServers: input.mcpServers,
    })
  );

  const auto = resolveAutoRouterForRecipe(input.role);
  const effectiveModel = isOpenRouterAutoRouterEnabled() ? auto.model : (baseRecipe.model ?? auto.model);
  const recipe = isOpenRouterAutoRouterEnabled() && effectiveModel ? gooseRecipeWithModel(baseRecipe, effectiveModel) : baseRecipe;

  const workDir = input.cwd;
  registerOpenRouterRun(input.runId, { openrouterSessionId: input.runId });
  const runLog = agentLog({ harness: "goose", runId: input.runId, role: input.role });

  let processRef: AcpProcess | null = null;
  let killed = false;

  const result = (async () => {
    try {
      // Materializa env_keys no recipe e remove LINEAR_API_* do processo goose —
      // senão o shell herda a key e posta commentCreate via curl (duplicatas).
      const env = withHarnessSpawnEnv(spawnEnv(input, input.runId, input.role, input.settings));
      const recipeReady = injectMcpSecretsIntoGooseRecipe(recipe, env);
      stripLinearApiSecretsFromEnv(env);
      const { result } = await runAcpTurn({
        spawn: {
          bin: resolveHarnessBin(config.goose.bin),
          args: ["acp"],
          env,
          cwd: workDir,
        },
        newSessionMeta: { recipeDeeplink: recipeReady.deeplink, gooseCustomNotifications: true },
        // MCP do goose vive nas `extensions` do recipe (deeplink) — passar a
        // lista aqui TAMBÉM plugaria cada servidor duas vezes na sessão.
        promptText: input.promptText,
        requestTimeoutMs: config.goose.requestTimeoutMs,
        promptRetries: config.goose.promptRetries,
        resumeSessionId: input.resumeSessionId,
        log: runLog,
        onEvent: input.onEvent,
        // Referência do processo chega ANTES de qualquer await — kill() no
        // meio do run (Pausar/Encerrar, reclaimStale) mata de verdade.
        onProcess(p) {
          processRef = p;
          if (killed) p.kill();
        },
      });
      registerOpenRouterRun(input.runId, { openrouterSessionId: input.runId, gooseSessionId: result.sessionId });
      return {
        outputText: result.outputText,
        stopReason: result.stopReason,
        usage: result.usage,
        sessionId: result.sessionId,
        finalStatus: "completed" as const,
      };
    } catch (e) {
      runLog.error({ ...errFields(e) }, "goose adapter run failed");
      throw e;
    } finally {
      cleanupAfterRun(workDir, config.goose.keepWorkspaces);
    }
  })();

  return {
    result,
    kill() {
      killed = true;
      processRef?.kill();
    },
  };
}

export const gooseAdapter: HarnessAdapter = {
  id: "goose",
  label: "Goose",
  capabilities: {
    integration: "acp",
    modelSelection: "flag",
    usageReporting: "tokens+cost",
    costSource: "api",
    sessionResume: true,
    mcp: true,
    kill: true,
  },
  detect,
  createRun,
};
