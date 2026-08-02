// Núcleo de dispatch multi-harness (Fases 1–2): resolve o AGENTE ATIVO do
// papel (banco), monta o recipe/prompt em runtime a partir da SOUL versionada
// + config do harness ativo, chama o HarnessAdapter correspondente e persiste
// snapshot/usage/refs externas. O scheduler continua vendo só as funções
// re-exportadas por agent/index.ts (AgentBackend) — invariante §3.2 preservada.
import { join } from "node:path";
import { config } from "../config";
import { log, agentLog, errFields } from "../logger";
import * as store from "../dashboard/store";
import * as locks from "../locks";
import {
  activeAgentForRole,
  ensureHarnessConfig,
  parseHarnessSettings,
  parseMcpServers,
  decryptSecretFields,
} from "../db/agents";
import { ROLE_METAS, toAgentRole, type SchedulerRole } from "./recipe/defaults";
import { resolvedConfigSnapshot } from "./recipe/builder";
import { harnessAdapter } from "./harness/registry";
import { isHarnessPaused } from "./harness/budget";
import type { HarnessId, HarnessRunInput } from "./harness/types";
import { extractFootprint } from "./backend";
import { withGitCommitterIdentity, withGitHttpsInsteadOf } from "./harness/gitRunEnv";
import type { Footprint, WorkerMode } from "../types";
import { notify } from "../notifications/events";
import type { LinearContext } from "../db/linearConnections";
import { DEFAULT_CONNECTION_ID } from "../db/linearConnections";
import { resolveGithubAuth } from "../githubAuth";
import { ensureHarnessBinOnPath } from "../cli/setup/harnessDeps";

// Registro em memória dos runs em voo (qualquer harness) — permite à
// dashboard encerrar manualmente (cancelRun). Só funciona com uma instância
// do serviço (mesma limitação documentada pro guard `running` do scheduler).
const activeRuns = new Map<string, { kill(): void }>();

export function cancelActiveRun(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (!run) return false;
  try {
    run.kill();
  } catch {
    /* já morto */
  }
  return true;
}

export class HarnessNotReadyError extends Error {}

interface Resolution {
  agentId?: string;
  agentVersionId?: string;
  harnessId: HarnessId;
  soulMarkdown: string;
  model: string | null;
  settings: Record<string, unknown>;
  mcpServers: ReturnType<typeof parseMcpServers>;
}

// Fallback de compatibilidade (§7.3): usado só se, por alguma razão, não
// houver agente ativo pro papel (ex.: seed não rodou por falta da SOUL no
// git no primeiro boot). Sem SOUL nenhuma pra injetar, falha alto e claro em
// vez de despachar um agente sem instruções.
function fallbackResolution(role: SchedulerRole): never {
  const agentRole = toAgentRole(role);
  throw new HarnessNotReadyError(
    `Nenhum agente ativo para o papel "${agentRole}" — crie/ative um agente pela dashboard (Fase 1) ou adicione agents/${ROLE_METAS[agentRole].soulFile} no git para o seed automático no próximo boot.`
  );
}

function resolveForRole(role: SchedulerRole): Resolution {
  const active = activeAgentForRole(role);
  if (!active) return fallbackResolution(role);
  const harnessConfig = active.harnessConfig ?? ensureHarnessConfig(active.agent.id, active.harnessId);
  return {
    agentId: active.agent.id,
    agentVersionId: active.version.id,
    harnessId: active.harnessId as HarnessId,
    soulMarkdown: active.version.soulMarkdown,
    model: harnessConfig.model,
    settings: decryptSecretFields(parseHarnessSettings(harnessConfig)),
    mcpServers: parseMcpServers(harnessConfig),
  };
}

function harnessWorkspaceRoot(): string {
  // Reaproveita o mesmo diretório-base que já existia só para o Goose — vira
  // a raiz de workspace de QUALQUER harness que precise de cwd (§7.1).
  return config.goose.workingDir;
}

export interface DispatchOptions {
  operation: string;
  role: SchedulerRole;
  kind: "planning" | "dispatch";
  issueId?: string;
  mode?: WorkerMode;
  promptText: string;
  /** Credencial Linear do workspace deste run — injetada no env do child. */
  linearCtx?: LinearContext;
}

/**
 * Monta env do child: process.env + Linear/GitHub da connection (fecha bug
 * key-só-no-banco).
 *
 * Async por causa do modo GitHub App: o installation token é mintado (ou lido
 * do cache) ANTES do spawn — é o único ponto onde dá pra falhar alto se a
 * credencial do App estiver quebrada, em vez de o agent descobrir no meio do
 * `git push`.
 */
export async function buildRunEnv(linearCtx?: LinearContext): Promise<Record<string, string>> {
  ensureHarnessBinOnPath();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (linearCtx?.apiKey) {
    env.LINEAR_API_KEY = linearCtx.apiKey;
    env.LINEAR_API_TOKEN = linearCtx.apiKey;
  } else if (config.linear.apiKey) {
    // Fallback single-tenant: config resolve ENV>banco — o child precisa da key
    // mesmo quando ela só existe no SQLite (não em process.env do daemon).
    env.LINEAR_API_KEY = config.linear.apiKey;
    env.LINEAR_API_TOKEN = config.linear.apiKey;
  } else if (!env.LINEAR_API_TOKEN && env.LINEAR_API_KEY) {
    env.LINEAR_API_TOKEN = env.LINEAR_API_KEY;
  }

  // GitHub por connection: PAT da row, installation token do App, ou fallback
  // GITHUB_TOKEN global — quem decide é o resolver (githubAuth), não daqui.
  const auth = await resolveGithubAuth(linearCtx);
  const gh = (auth.token || env.GITHUB_TOKEN || "").trim();
  if (gh) {
    env.GITHUB_TOKEN = gh;
    env.GITHUB_PERSONAL_ACCESS_TOKEN = gh;
  } else if (!env.GITHUB_PERSONAL_ACCESS_TOKEN && env.GITHUB_TOKEN) {
    env.GITHUB_PERSONAL_ACCESS_TOKEN = env.GITHUB_TOKEN;
  }
  // Central, não por adapter: git puro não lê GITHUB_TOKEN, e antes disto só o
  // goose tinha auth HTTPS — os ACP dependiam do credential helper do host
  // (justamente o que o HOME isolado do Cursor tira de cena).
  withGitHttpsInsteadOf(env, gh || undefined);
  withGitCommitterIdentity(env, auth.committer);
  return env;
}

/** Roda um turno via o agente/harness ativo do papel. Devolve o texto (usado no planning). */
export async function runDispatch(opts: DispatchOptions): Promise<string> {
  const resolution = resolveForRole(opts.role);
  const adapter = harnessAdapter(resolution.harnessId);
  if (!adapter) throw new Error(`harness desconhecido: ${resolution.harnessId}`);

  if (isHarnessPaused(resolution.harnessId)) {
    // Budget estourado + ação pausar (§7.4): NÃO despacha, NÃO move a issue —
    // o caller (scheduler) trata a promise rejeitada como "seat continua
    // ocupado, tenta de novo no próximo tick" (mesmo padrão de footprint cheio).
    throw new HarnessNotReadyError(
      `harness "${resolution.harnessId}" com budget estourado (ação: pausar) — dispatch em espera até o próximo período ou aumento do limite`
    );
  }

  const roleMeta = ROLE_METAS[toAgentRole(opts.role)];
  const provider = adapter.capabilities.integration === "acp" ? String(resolution.settings.provider ?? "openrouter") : undefined;
  const connectionId = opts.linearCtx?.connectionId ?? DEFAULT_CONNECTION_ID;

  // ANTES do startRun: no modo GitHub App isto vai à rede e pode falhar
  // (credencial incompleta, PEM inválida, installation revogada). Falhar aqui
  // rejeita a promise sem deixar linha de run pendurada em `running` — o
  // scheduler trata como "seat continua ocupado, tenta no próximo tick",
  // mesmo caminho do HarnessNotReadyError.
  const runEnv = await buildRunEnv(opts.linearCtx);

  const runId = store.startRun({
    backend: resolution.harnessId,
    operation: opts.operation,
    role: opts.role,
    issueId: opts.issueId,
    mode: opts.mode,
    provider,
    model: resolution.model ?? undefined,
    agentId: resolution.agentId,
    agentVersionId: resolution.agentVersionId,
    harnessId: resolution.harnessId,
    linearConnectionId: opts.linearCtx?.connectionId,
    resolvedConfigJson: resolvedConfigSnapshot({
      harnessId: resolution.harnessId,
      model: resolution.model,
      provider,
      settings: resolution.settings,
      mcpServers: resolution.mcpServers,
    }),
  });
  store.recordEvent(runId, "user_message", { text: opts.promptText, payload: { text: opts.promptText } });

  const cwd = join(harnessWorkspaceRoot(), `run-${runId}`);

  // §7.6: session resume — só em modo fix, só se o harness ativo suporta, só
  // DA MESMA issue NO MESMO harness (chave composta). Fallback transparente:
  // se não houver sessão, resumeSessionId fica undefined e o adapter começa
  // do zero — nunca trava o pipeline por causa disso.
  let resumeSessionId: string | undefined;
  if (adapter.capabilities.sessionResume && opts.mode === "fix" && opts.issueId) {
    resumeSessionId =
      (await locks.getSession(connectionId, opts.issueId, resolution.harnessId).catch(() => null)) ?? undefined;
  }

  // Planning (footprint) e merge do Orchestrator precisam ser rápidos pra não
  // segurar o tick / outras seats — preferFast pede variante `fast=true` ao
  // harness ACP (Cursor: grok-4.5 / composer-2.5; outros: qualquer fast).
  const preferFast =
    opts.role === "orchestrator" && (opts.kind === "planning" || opts.operation === "dispatchMerge");

  const input: HarnessRunInput = {
    runId,
    role: opts.role,
    kind: opts.kind,
    systemPrompt: resolution.soulMarkdown,
    roleMeta: { title: roleMeta.title, description: roleMeta.description, prompt: roleMeta.prompt },
    promptText: opts.promptText,
    cwd,
    mcpServers: resolution.mcpServers,
    model: resolution.model ?? undefined,
    preferFast: preferFast || undefined,
    settings: resolution.settings,
    env: runEnv,
    resumeSessionId,
    onEvent(evt) {
      store.recordEvent(runId, evt.kind, { text: evt.text, toolName: evt.toolName, toolStatus: evt.toolStatus, payload: evt.payload });
    },
  };

  const run = adapter.createRun(input);
  activeRuns.set(runId, run);
  const start = Date.now();
  const runLog = agentLog({ harness: resolution.harnessId, runId, role: opts.role });

  try {
    const result = await run.result;
    const costSource = adapter.capabilities.costSource === "api" ? "api" : "subscription";
    store.recordHarnessResult(runId, {
      costSource,
      externalSessionId: result.sessionId,
      externalRefsJson: result.externalRefs ? JSON.stringify(result.externalRefs) : undefined,
      usage: result.usage,
    });
    if (result.sessionId && opts.issueId) {
      await locks
        .recordSession(connectionId, opts.issueId, resolution.harnessId, result.sessionId)
        .catch(() => {});
    }
    runLog.info(
      { operation: opts.operation, durationMs: Date.now() - start, issueId: opts.issueId, stopReason: result.stopReason },
      "harness run completed"
    );
    store.finishRun(runId, { status: result.finalStatus ?? "completed", stopReason: result.stopReason });
    return result.outputText;
  } catch (e) {
    runLog.error(
      { operation: opts.operation, durationMs: Date.now() - start, issueId: opts.issueId, ...errFields(e) },
      "harness run failed"
    );
    store.finishRun(runId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    // dispatch (não planning): planning failures são tratados pelo caller
    // (estimateFootprintViaAgent cai no fallback ["*"], sem barulho de sobra).
    if (opts.kind === "dispatch") {
      notify("run_failed", {
        runId,
        role: opts.role,
        harnessId: resolution.harnessId,
        issueId: opts.issueId,
        error: e instanceof Error ? e.message : String(e),
        linearCtx: opts.linearCtx,
        connectionId: opts.linearCtx?.connectionId,
      });
    }
    throw e;
  } finally {
    activeRuns.delete(runId);
  }
}

export async function estimateFootprintViaAgent(issueId: string, linearCtx?: LinearContext): Promise<Footprint> {
  const out = await runDispatch({
    operation: "estimateFootprint",
    role: "orchestrator",
    kind: "planning",
    issueId,
    promptText: `issueId: ${issueId}\nmode: planning\n\nResponda SOMENTE com o JSON do footprint, sem texto ao redor.`,
    linearCtx,
  });
  try {
    return extractFootprint(out);
  } catch (e) {
    log.agent.warn({ issueId, ...errFields(e) }, "footprint parse failed, using fallback");
    return ["*"];
  }
}
