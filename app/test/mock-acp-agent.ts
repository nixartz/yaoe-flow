#!/usr/bin/env bun
// Mock ACP agent (§9.1): subprocess que fala ACP DE VERDADE (mesmo SDK do
// cliente) — spawnado pelos contract tests em vez de `goose acp`. Roteiro
// controlado por MOCK_ACP_SCENARIO:
//
//   success            — turno normal com N tool calls (MOCK_ACP_TOOL_CALLS, default 2)
//   provider_error     — 1º prompt termina com o texto canônico de erro transitório
//                         do goose (testa o retry do cliente ACP); 2º prompt sucede
//   silence            — não emite NENHUM evento por MOCK_ACP_SILENCE_MS (testa liveness)
//   usage              — emite usage_update sintético (testa contabilização)
//   usage_response     — devolve usage na RESPOSTA do prompt (forma padrão do ACP,
//                         sem side-channel do goose)
//   resumable          — aceita loadSession pro id fixo "mock-resumable-session"
//                         (testa resume §7.6); loadSession com outro id falha
//   abrupt_death       — emite 1 evento e derruba o processo (process.exit) no
//                         meio do prompt (testa reclaim/kill)
//   mcp_echo           — devolve como texto o JSON dos mcpServers recebidos no
//                         newSession (prova que a config do banco chega à sessão)
//   models             — anuncia availableModels no estilo Cursor (modelId
//                         parametrizado) e devolve o modelId aplicado via
//                         setSessionModel; rejeita id fora da lista, como o Cursor
//   cursor_ext         — manda um request de extensão `cursor/update_todos` CRU
//                         (sem o prefixo `_` que o SDK exige) e reporta se veio
//                         resposta válida — cobre o bug dos métodos cursor/*
//   provider_fatal     — cospe o erro de provider do Cursor como TEXTO do agente
//                         com stopReason "end_turn" (não-retriável)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Agent } from "@zed-industries/agent-client-protocol";

const SCENARIO = process.env.MOCK_ACP_SCENARIO ?? "success";
const TOOL_CALLS = Number(process.env.MOCK_ACP_TOOL_CALLS ?? 2);
const SILENCE_MS = Number(process.env.MOCK_ACP_SILENCE_MS ?? 5_000);
const RESUMABLE_SESSION_ID = "mock-resumable-session";

// Modelos no formato do Cursor: id parametrizado, nome legível separado.
const MOCK_MODELS = {
  currentModelId: "default[]",
  availableModels: [
    { modelId: "default[]", name: "Auto" },
    { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
    { modelId: "claude-opus-5[thinking=true,effort=high]", name: "claude-opus-5" },
  ],
};

let promptCount = 0;
let lastMcpServers: unknown = null;
let appliedModelId: string | null = null;

// Canal JSON-RPC CRU (fora do SDK): o SDK prefixa `_` em toda extensão, e o que
// precisamos reproduzir é justamente o Cursor mandando `cursor/...` SEM prefixo.
let rawId = 90_000;
const pendingRaw = new Map<number, (result: unknown) => void>();
function rawRequest(method: string, params: unknown): Promise<unknown> {
  const id = rawId++;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => {
    pendingRaw.set(id, resolve);
    setTimeout(() => {
      if (pendingRaw.delete(id)) resolve({ __timeout: true });
    }, 3_000);
  });
}

function makeAgent(conn: AgentSideConnection): Agent {
  return {
    async initialize() {
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
    },
    async newSession(params) {
      lastMcpServers = params.mcpServers;
      const sessionId = SCENARIO === "resumable" ? RESUMABLE_SESSION_ID : `mock-session-${Date.now()}`;
      return { sessionId, ...(SCENARIO === "models" ? { models: MOCK_MODELS } : {}) };
    },
    async setSessionModel(params) {
      if (!MOCK_MODELS.availableModels.some((m) => m.modelId === params.modelId)) {
        // Mesma recusa do Cursor: -32602 "Invalid model value".
        throw new Error(`Invalid model value: ${params.modelId}`);
      }
      appliedModelId = params.modelId;
      return {};
    },
    async loadSession(params) {
      if (SCENARIO === "resumable" && params.sessionId === RESUMABLE_SESSION_ID) {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[resumed] " } },
        });
        return {};
      }
      throw new Error("session not found");
    },
    async authenticate() {
      return {};
    },
    async prompt(params) {
      promptCount++;
      // Marcador em disco pro teste da sonda de modelos provar que ela NÃO
      // manda prompt (é o que garante custo zero de token).
      writeFileSync(join(process.cwd(), "prompted"), String(promptCount));
      const sessionId = params.sessionId;

      if (SCENARIO === "silence") {
        await new Promise((r) => setTimeout(r, SILENCE_MS));
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done after silence" } },
        });
        return { stopReason: "end_turn" };
      }

      if (SCENARIO === "abrupt_death") {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working…" } },
        });
        await new Promise((r) => setTimeout(r, 200));
        process.exit(1);
      }

      if (SCENARIO === "provider_error" && promptCount === 1) {
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Ran into this error: empty response from provider. Please retry if you think this is a transient or recoverable error.",
            },
          },
        });
        return { stopReason: "end_turn" };
      }

      if (SCENARIO === "mcp_echo") {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(lastMcpServers) } },
        });
        return { stopReason: "end_turn" };
      }

      if (SCENARIO === "models") {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `model=${appliedModelId ?? "none"}` } },
        });
        return { stopReason: "end_turn" };
      }

      if (SCENARIO === "cursor_ext") {
        const reply = (await rawRequest("cursor/update_todos", {
          toolCallId: "call-1",
          todos: [{ id: "1", content: "fazer algo", status: "in_progress" }],
          merge: false,
        })) as { outcome?: { outcome?: string }; __timeout?: boolean };
        const outcome = reply?.__timeout ? "timeout" : (reply?.outcome?.outcome ?? "invalid");
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `todos=${outcome}` } },
        });
        return { stopReason: "end_turn" };
      }

      if (SCENARIO === "provider_fatal") {
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                "\n\nError: NonRetriableError: Provider Error Too many MCP tools are enabled for this model. " +
                "Please disable some MCP servers and try again.",
            },
          },
        });
        // Exatamente o que o Cursor faz: stopReason NORMAL apesar do erro.
        return { stopReason: "end_turn" };
      }

      if (SCENARIO === "usage_response") {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "usage na resposta" } },
        });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 4321, outputTokens: 765, cachedReadTokens: 100 },
        } as unknown as { stopReason: "end_turn" };
      }

      if (SCENARIO === "usage") {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "usage test done" } },
        });
        // notificação goose custom (accumulated_*) — mesmo formato do goose real.
        // extNotification prefixa "_" por conta própria (vira "_goose/unstable/…").
        await conn.extNotification("goose/unstable/session/update", {
          update: {
            sessionUpdate: "usage_update",
            accumulatedInputTokens: 1234,
            accumulatedOutputTokens: 567,
            accumulatedCost: 0.042,
          },
        });
        return { stopReason: "end_turn" };
      }

      // success (default) e provider_error após o retry: N tool calls + texto final.
      for (let i = 0; i < TOOL_CALLS; i++) {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: `tool-${i}`, title: `mock_tool_${i}`, status: "pending" },
        });
        // Update SEM title, como manda a spec do ACP (só campos que mudaram) e
        // como o cursor-agent faz de verdade — o título tem que ser herdado.
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: `tool-${i}`, status: "completed" },
        });
      }
      const suffix = SCENARIO === "resumable" && params.prompt[0]?.type === "text" ? "" : "";
      await conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mock success (${TOOL_CALLS} tools)${suffix}` } },
      });
      return { stopReason: "end_turn" };
    },
    async cancel() {
      /* no-op — mock não sustenta prompts cancelável de verdade */
    },
  };
}

const stream = ndJsonStream(
  new WritableStream({
    write(chunk) {
      process.stdout.write(chunk);
    },
  }),
  new ReadableStream<Uint8Array>({
    start(controller) {
      // Respostas aos requests CRUS (rawRequest) são consumidas aqui e NÃO
      // repassadas ao SDK — pra ele aquele id nunca existiu.
      const enc = new TextEncoder();
      let buf = "";
      process.stdin.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i + 1);
          buf = buf.slice(i + 1);
          let handled = false;
          try {
            const msg = JSON.parse(line) as { id?: number; result?: unknown };
            if (typeof msg.id === "number" && pendingRaw.has(msg.id)) {
              pendingRaw.get(msg.id)?.(msg.result);
              pendingRaw.delete(msg.id);
              handled = true;
            }
          } catch {
            /* não-JSON: repassa */
          }
          if (!handled) controller.enqueue(enc.encode(line));
        }
      });
      process.stdin.on("end", () => controller.close());
    },
  })
);
new AgentSideConnection((conn) => makeAgent(conn), stream);
