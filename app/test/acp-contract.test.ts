// Contract suite (§9.1): roda o CLIENTE ACP genérico (src/agent/acp/client.ts)
// contra o mock-acp-agent.ts — fala ACP de verdade (mesmo SDK), sem custo de
// LLM nem flakiness de rede. Cobre os roteiros do blueprint: sucesso com N
// tool calls, erro de provider (retry), silêncio prolongado, usage sintético,
// sessão retomável (+ fallback), morte abrupta (kill/reclaim).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAcpTurn, listAcpModels, toAcpMcpServers, resolveAcpModelId, stripLinearApiSecretsFromEnv, isForbiddenLinearShellToolCall, type AcpProcess } from "../src/agent/acp/client";
import { agentLog } from "../src/logger";
import type { McpServerConfig } from "../src/agent/recipe/defaults";
import type { NormalizedEvent } from "../src/agent/harness/types";

const MOCK_AGENT = resolve(import.meta.dir, "mock-acp-agent.ts");
const testLog = agentLog({ harness: "mock" });

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "acp-contract-"));
}

function run(
  scenario: string,
  opts: {
    promptRetries?: number;
    requestTimeoutMs?: number;
    resumeSessionId?: string;
    extraEnv?: Record<string, string>;
    model?: string;
    mcpServers?: McpServerConfig[];
  } = {}
) {
  const events: NormalizedEvent[] = [];
  const usageSnapshots: Array<Record<string, unknown>> = [];
  const cwd = tmpCwd();
  const resultPromise = runAcpTurn({
    spawn: { bin: "bun", args: [MOCK_AGENT], env: { ...process.env, MOCK_ACP_SCENARIO: scenario, ...opts.extraEnv } as Record<string, string>, cwd },
    promptText: "do the task",
    requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
    promptRetries: opts.promptRetries ?? 0,
    resumeSessionId: opts.resumeSessionId,
    model: opts.model,
    mcpServers: opts.mcpServers,
    log: testLog,
    onEvent: (e) => events.push(e),
    onUsageSnapshot: (u) => usageSnapshots.push(u as Record<string, unknown>),
  });
  return { resultPromise, events, usageSnapshots, cwd };
}

describe("ACP contract (mock agent)", () => {
  test("sucesso com N tool calls", async () => {
    const { resultPromise, events, cwd } = run("success", { extraEnv: { MOCK_ACP_TOOL_CALLS: "3" } });
    const { result, process } = await resultPromise;
    process.kill();
    expect(result.outputText).toBe("mock success (3 tools)");
    expect(result.stopReason).toBe("end_turn");
    expect(events.filter((e) => e.kind === "tool_call")).toHaveLength(3);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("tool_call_update sem title herda o nome do tool_call (timeline da dashboard)", async () => {
    const { resultPromise, events, cwd } = run("success", { extraEnv: { MOCK_ACP_TOOL_CALLS: "2" } });
    const { process } = await resultPromise;
    process.kill();
    const updates = events.filter((e) => e.kind === "tool_call_update");
    expect(updates).toHaveLength(2);
    expect(updates.map((e) => e.toolName)).toEqual(["mock_tool_0", "mock_tool_1"]);
    expect(updates.every((e) => e.toolStatus === "completed")).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("erro de provider: retry na mesma sessão e sucede", async () => {
    const { resultPromise, cwd } = run("provider_error", { promptRetries: 1 });
    const { result, process } = await resultPromise;
    process.kill();
    // `outputText` acumula os DOIS turnos (transcript completo, como no goose
    // real) — o que prova o retry é o turno TERMINAR em sucesso, não vazio
    // nem preso no texto de erro.
    expect(result.outputText.endsWith("mock success (2 tools)")).toBe(true);
    expect(result.stopReason).toBe("end_turn");
    rmSync(cwd, { recursive: true, force: true });
  }, 15_000);

  test("sem retries configurados, erro de provider propaga (run vira failed no caller)", async () => {
    const { resultPromise, cwd } = run("provider_error", { promptRetries: 0 });
    expect(resultPromise).rejects.toThrow(/provider error persistiu/);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("usage sintético: onUsageSnapshot recebe os totais acumulados", async () => {
    const { resultPromise, usageSnapshots, cwd } = run("usage");
    const { process } = await resultPromise;
    process.kill();
    expect(usageSnapshots).toHaveLength(1);
    expect(usageSnapshots[0]).toMatchObject({ inputTokens: 1234, outputTokens: 567, costUsd: 0.042 });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("usage padrão do ACP (na resposta do prompt) chega ao resultado do run", async () => {
    // Harness ACP sem o side-channel do goose (cursor/claude-code/codex) só
    // reportam usage aqui — sem isto o run ia pro banco com token zerado.
    const { resultPromise, cwd } = run("usage_response");
    const { result, process } = await resultPromise;
    process.kill();
    expect(result.usage).toMatchObject({ inputTokens: 4321, outputTokens: 765, cacheReadTokens: 100 });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("sessão retomável: loadSession sucede e o evento de resume chega antes do prompt", async () => {
    // 1ª rodada fixa o sessionId (mock devolve sempre o mesmo id nesse cenário).
    const first = run("resumable");
    const { result: r1, process: p1 } = await first.resultPromise;
    p1.kill();

    const second = run("resumable", { resumeSessionId: r1.sessionId });
    const { result: r2, process: p2 } = await second.resultPromise;
    p2.kill();

    expect(r2.sessionId).toBe(r1.sessionId);
    expect(second.events[0]?.text).toBe("[resumed] ");
    rmSync(first.cwd, { recursive: true, force: true });
    rmSync(second.cwd, { recursive: true, force: true });
  });

  test("resume com sessão inexistente cai pro fluxo normal (fallback transparente)", async () => {
    const { resultPromise, cwd } = run("resumable", { resumeSessionId: "sessao-que-nao-existe" });
    const { result, process } = await resultPromise;
    process.kill();
    // loadSession falhou → newSession novo → sessionId NÃO é o que foi pedido,
    // e o turno completa normalmente (nunca lança por causa do resume).
    expect(result.sessionId).not.toBe("sessao-que-nao-existe");
    expect(result.outputText).toContain("mock success");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("morte abrupta: a promise rejeita (não trava) e eventos prévios já chegaram", async () => {
    const { resultPromise, events, cwd } = run("abrupt_death", { requestTimeoutMs: 5_000 });
    await expect(resultPromise).rejects.toBeTruthy();
    expect(events.some((e) => e.text === "working…")).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  }, 10_000);

  test("kill NO MEIO do run: onProcess entrega a referência antes do fim e kill() interrompe", async () => {
    // Regressão: o `process` do retorno só existe quando o turno TERMINOU —
    // matar no meio (Pausar/Encerrar da dashboard, reclaimStale) depende do
    // onProcess. Cenário de silêncio longo garante que o turno estaria longe
    // de acabar quando o kill acontece.
    const events: NormalizedEvent[] = [];
    const cwd = tmpCwd();
    let proc: AcpProcess | null = null;
    const resultPromise = runAcpTurn({
      spawn: {
        bin: "bun",
        args: [MOCK_AGENT],
        env: { ...process.env, MOCK_ACP_SCENARIO: "silence", MOCK_ACP_SILENCE_MS: "30000" } as Record<string, string>,
        cwd,
      },
      promptText: "do the task",
      requestTimeoutMs: 60_000,
      log: testLog,
      onEvent: (e) => events.push(e),
      onProcess: (p) => {
        proc = p;
      },
    });
    // A referência chega síncrona ao spawn — bem antes do turno acabar.
    expect(proc).not.toBeNull();
    await Bun.sleep(300);
    proc!.kill();
    const start = Date.now();
    await expect(resultPromise).rejects.toBeTruthy();
    // Rejeitou porque o processo morreu (stream fechado), não pelos 60s de timeout.
    expect(Date.now() - start).toBeLessThan(5_000);
    rmSync(cwd, { recursive: true, force: true });
  }, 15_000);

  test("silêncio prolongado: completa após o delay sem timeout prematuro", async () => {
    const { resultPromise, cwd } = run("silence", { requestTimeoutMs: 5_000, extraEnv: { MOCK_ACP_SILENCE_MS: "500" } });
    const { result, process } = await resultPromise;
    process.kill();
    expect(result.outputText).toBe("done after silence");
    rmSync(cwd, { recursive: true, force: true });
  }, 10_000);

  // Regressão: `mcpServers` ia SEMPRE vazio no session/new — só o goose recebia
  // MCP (pelas extensions do recipe), então cursor/claude-code/codex rodavam
  // sem Linear nem GitHub.
  test("mcpServers do agente chegam ao session/new (com envKeys resolvidos)", async () => {
    const { resultPromise, cwd } = run("mcp_echo", {
      extraEnv: { MOCK_MCP_TOKEN: "segredo-do-run" },
      mcpServers: [
        { type: "stdio", name: "linear", cmd: "npx", args: ["-y", "@tacticlaunch/mcp-linear"], envKeys: ["MOCK_MCP_TOKEN"] },
        { type: "builtin", name: "developer" },
      ],
    });
    const { result, process } = await resultPromise;
    process.kill();
    const received = JSON.parse(result.outputText) as Array<Record<string, unknown>>;
    // `builtin` não tem equivalente ACP e é descartado; o stdio vai completo.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      name: "linear",
      command: "npx",
      args: ["-y", "@tacticlaunch/mcp-linear"],
      env: [{ name: "MOCK_MCP_TOKEN", value: "segredo-do-run" }],
    });
    rmSync(cwd, { recursive: true, force: true });
  });

  // Regressão: model "auto" era mandado cru no setSessionModel e o Cursor
  // recusava com -32602 "Invalid model value: auto", caindo no default sem aviso.
  test("model 'auto' resolve pro modelId real da lista do agente", async () => {
    const { resultPromise, cwd } = run("models", { model: "auto" });
    const { result, process } = await resultPromise;
    process.kill();
    expect(result.outputText).toBe("model=default[]");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("model pelo nome legível resolve pro id parametrizado", async () => {
    const { resultPromise, cwd } = run("models", { model: "claude-opus-5" });
    const { result, process } = await resultPromise;
    process.kill();
    expect(result.outputText).toBe("model=claude-opus-5[thinking=true,effort=high]");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("model inexistente não é aplicado (segue no default, sem falhar o run)", async () => {
    const { resultPromise, cwd } = run("models", { model: "modelo-que-nao-existe" });
    const { result, process } = await resultPromise;
    process.kill();
    expect(result.outputText).toBe("model=none");
    rmSync(cwd, { recursive: true, force: true });
  });

  // Regressão: o SDK só roteia extensão com prefixo `_`; os `cursor/*` levavam
  // -32601 methodNotFound e as chamadas BLOQUEANTES do Cursor ficavam sem resposta.
  test("request de extensão sem prefixo `_` (cursor/*) é respondido", async () => {
    const { resultPromise, events, cwd } = run("cursor_ext");
    const { result, process } = await resultPromise;
    process.kill();
    expect(result.outputText).toBe("todos=accepted");
    // E aparece na timeline da dashboard como evento de plano.
    expect(events.some((e) => e.kind === "plan" && JSON.stringify(e.payload).includes("cursor/update_todos"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  }, 15_000);

  // Regressão: erro de provider vinha como TEXTO com stopReason "end_turn"; o
  // run era marcado "completed" sem trabalho nenhum e o scheduler re-despachava
  // em loop até estourar maxAttempts.
  test("erro não-retriável de provider falha o run sem gastar retry", async () => {
    const started = Date.now();
    const { resultPromise, events, cwd } = run("provider_fatal", { promptRetries: 2 });
    await expect(resultPromise).rejects.toThrow(/não-retriável do provider[\s\S]*Too many MCP tools/);
    // Sem backoff de retry: falhou de primeira (cada retry dormiria 2s+).
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  }, 15_000);
});

describe("enumeração de modelos (listAcpModels)", () => {
  test("lê availableModels do session/new sem mandar prompt", async () => {
    const cwd = tmpCwd();
    const out = await listAcpModels({
      spawn: {
        bin: "bun",
        args: [MOCK_AGENT],
        env: { ...process.env, MOCK_ACP_SCENARIO: "models" } as Record<string, string>,
        cwd,
      },
      log: testLog,
    });
    expect(out.defaultModelId).toBe("default[]");
    expect(out.models.map((m) => m.id)).toEqual([
      "default[]",
      "composer-2.5[fast=true]",
      "claude-opus-5[thinking=true,effort=high]",
    ]);
    expect(out.models[0]).toMatchObject({ id: "default[]", name: "Auto" });
    // O mock conta quantos prompts recebeu; a sonda não pode disparar nenhum
    // (é o que garante custo zero de token).
    expect(existsSync(join(cwd, "prompted"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  }, 15_000);

  test("agente que não enumera modelos devolve lista vazia (dashboard cai no texto livre)", async () => {
    const cwd = tmpCwd();
    const out = await listAcpModels({
      spawn: {
        bin: "bun",
        args: [MOCK_AGENT],
        env: { ...process.env, MOCK_ACP_SCENARIO: "success" } as Record<string, string>,
        cwd,
      },
      log: testLog,
    });
    expect(out.models).toEqual([]);
    expect(out.defaultModelId).toBeUndefined();
    rmSync(cwd, { recursive: true, force: true });
  }, 15_000);
});

describe("tradução de MCP (banco → ACP)", () => {
  test("streamable_http vira transporte http com ${VAR} expandido", () => {
    const servers: McpServerConfig[] = [
      { type: "streamable_http", name: "hindsight", uri: "http://h:8888/mcp/x/", headers: { Authorization: "Bearer ${HS_KEY}" } },
    ];
    const out = toAcpMcpServers(servers, { HS_KEY: "abc123" }, testLog);
    expect(out).toEqual([
      { type: "http", name: "hindsight", url: "http://h:8888/mcp/x/", headers: [{ name: "Authorization", value: "Bearer abc123" }] },
    ]);
  });

  test("envKey ausente no ambiente não vira string 'undefined'", () => {
    const servers: McpServerConfig[] = [
      { type: "stdio", name: "linear", cmd: "npx", args: [], envKeys: ["FALTANDO"], envs: { GITHUB_TOOLSETS: "repos" } },
    ];
    const out = toAcpMcpServers(servers, {}, testLog);
    expect(out[0]).toMatchObject({ name: "linear", env: [{ name: "GITHUB_TOOLSETS", value: "repos" }] });
  });

  test("toAcpMcpServers embute LINEAR_API_TOKEN e strip remove do env do agent", () => {
    const env = { LINEAR_API_TOKEN: "lin_secret", LINEAR_API_KEY: "lin_secret", PATH: "/usr/bin" };
    const servers: McpServerConfig[] = [
      { type: "stdio", name: "linear", cmd: "npx", args: ["-y", "@tacticlaunch/mcp-linear"], envKeys: ["LINEAR_API_TOKEN"] },
    ];
    const mcp = toAcpMcpServers(servers, env, testLog);
    expect(mcp[0]).toMatchObject({
      name: "linear",
      env: [{ name: "LINEAR_API_TOKEN", value: "lin_secret" }],
    });
    stripLinearApiSecretsFromEnv(env);
    expect(env.LINEAR_API_TOKEN).toBeUndefined();
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("bloqueio de shell GraphQL Linear", () => {
  test("detecta curl api.linear.app + commentCreate", () => {
    expect(
      isForbiddenLinearShellToolCall({
        kind: "execute",
        title: '`curl -s https://api.linear.app/graphql -d \'{"query":"mutation { commentCreate...}\'}`',
      })
    ).toBe(true);
  });

  test("não bloqueia MCP linear_createComment", () => {
    expect(
      isForbiddenLinearShellToolCall({
        kind: "other",
        title: "linear_createComment",
        rawInput: { issueId: "INF-3", body: "▶️ ok" },
      })
    ).toBe(false);
  });

  test("não bloqueia shell sem Linear", () => {
    expect(isForbiddenLinearShellToolCall({ kind: "execute", title: "`pnpm test`" })).toBe(false);
  });
});

describe("resolução de modelo ACP", () => {
  const models = {
    currentModelId: "default[]",
    availableModels: [
      { modelId: "default[]", name: "Auto" },
      { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
    ],
  };

  test("agente que não enumera modelos recebe a string como veio", () => {
    expect(resolveAcpModelId("gpt-5", null, testLog)).toBe("gpt-5");
  });

  test("modelId exato passa direto", () => {
    expect(resolveAcpModelId("composer-2.5[fast=true]", models, testLog)).toBe("composer-2.5[fast=true]");
  });

  test("nome-base sem os parâmetros também casa", () => {
    expect(resolveAcpModelId("composer-2.5", models, testLog)).toBe("composer-2.5[fast=true]");
  });

  test("auto/default caem no modelo 'Auto' do agente", () => {
    expect(resolveAcpModelId("auto", models, testLog)).toBe("default[]");
    expect(resolveAcpModelId("default", models, testLog)).toBe("default[]");
  });

  test("modelo desconhecido devolve null (não chamar setSessionModel)", () => {
    expect(resolveAcpModelId("llama-99", models, testLog)).toBeNull();
  });

  const modelsWithGrok = {
    currentModelId: "default[]",
    availableModels: [
      { modelId: "default[]", name: "Auto" },
      { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
      { modelId: "grok-4-5[effort=high,fast=true]", name: "grok-4.5" },
      { modelId: "grok-4-5[effort=high]", name: "grok-4.5 high" },
      { modelId: "claude-opus-5[thinking=true,effort=high,fast=false]", name: "claude-opus-5" },
    ],
  };

  test("preferFast + default/auto prioriza grok-4.5 effort=high fast", () => {
    expect(resolveAcpModelId("default[]", modelsWithGrok, testLog, { preferFast: true })).toBe(
      "grok-4-5[effort=high,fast=true]"
    );
    expect(resolveAcpModelId("auto", modelsWithGrok, testLog, { preferFast: true })).toBe(
      "grok-4-5[effort=high,fast=true]"
    );
  });

  test("preferFast + default sem grok cai em composer-2.5[fast=true]", () => {
    expect(resolveAcpModelId("default", models, testLog, { preferFast: true })).toBe("composer-2.5[fast=true]");
  });

  test("preferFast + base sem fast escolhe a variante fast da mesma base", () => {
    expect(resolveAcpModelId("grok-4-5[effort=high]", modelsWithGrok, testLog, { preferFast: true })).toBe(
      "grok-4-5[effort=high,fast=true]"
    );
  });

  test("preferFast não muda modelo que já tem fast=true", () => {
    expect(
      resolveAcpModelId("composer-2.5[fast=true]", modelsWithGrok, testLog, { preferFast: true })
    ).toBe("composer-2.5[fast=true]");
  });

  test("preferFast ignora fast=false (só fast=true conta)", () => {
    expect(resolveAcpModelId("default", { ...modelsWithGrok, availableModels: [
      { modelId: "default[]", name: "Auto" },
      { modelId: "claude-opus-5[thinking=true,effort=high,fast=false]", name: "claude-opus-5" },
    ] }, testLog, { preferFast: true })).toBe("default[]");
  });
});
