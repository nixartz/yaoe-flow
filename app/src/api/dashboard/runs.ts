import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent, sseContent } from "../shared/openapi";
import { errorBody, okBody, idParam, issueParam, looseObject } from "../shared/schemas";
import { runsQuery, stopRunBody, dispatchResponse } from "./runs.schema";
import { heartbeatLoop } from "./sse";
import * as agent from "../../agent";
import * as scheduler from "../../scheduler";
import { bus, type RunEventTopic } from "../../dashboard/bus";
import * as store from "../../dashboard/store";
import { harnessAdapter } from "../../agent/harness/registry";
import {
  resolveActiveContexts,
  resolveContextById,
  getConnection,
  toContext,
  singleTenantContext,
  DEFAULT_CONNECTION_ID,
  type LinearContext,
} from "../../db/linearConnections";
import { linearFor } from "../../linear";

export const runsRoutes = new Hono();

runsRoutes.get(
  "/runs",
  describeRoute({
    tags: ["Runs"],
    summary: "Lista runs com filtros e paginação",
    responses: { 200: jsonContent(looseObject, "Runs") },
  }),
  validator("query", runsQuery),
  (c) => {
    const q = c.req.valid("query");
    return c.json(
      store.listRuns({
        status: q.status,
        role: q.role,
        backend: q.backend,
        issueId: q.issueId,
        page: q.page,
        pageSize: q.pageSize,
      })
    );
  }
);

runsRoutes.get(
  "/runs/active",
  describeRoute({
    tags: ["Runs"],
    summary: "Runs em execução",
    responses: { 200: jsonContent(looseObject, "Runs ativas") },
  }),
  (c) => c.json(store.activeRuns())
);

runsRoutes.get(
  "/runs/stream",
  describeRoute({
    tags: ["Runs"],
    summary: "SSE de eventos de run",
    responses: { 200: sseContent },
  }),
  (c) =>
    streamSSE(c, async (stream) => {
      const onRun = (payload: RunEventTopic) => {
        stream.writeSSE({ event: payload.type, data: JSON.stringify(payload) }).catch(() => {});
      };
      bus.on("run", onRun);
      stream.onAbort(() => { bus.off("run", onRun); });
      await heartbeatLoop(stream);
    })
);

runsRoutes.get(
  "/runs/:id",
  describeRoute({
    tags: ["Runs"],
    summary: "Detalhe de um run",
    responses: {
      200: jsonContent(looseObject, "Run encontrado"),
      404: jsonContent(errorBody, "Não encontrado"),
    },
  }),
  (c) => {
    const run = store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json(run);
  }
);

// Re-executa reconciliação OpenRouter (GET /generation) pra um run já terminado.
runsRoutes.post(
  "/runs/:id/reconcile",
  describeRoute({
    tags: ["Runs"],
    summary: "Reconcilia custo OpenRouter de um run",
    responses: {
      200: jsonContent(looseObject, "Reconciliação"),
      404: jsonContent(errorBody, "Não encontrado"),
    },
  }),
  async (c) => {
    const id = c.req.param("id");
    const found = store.getRun(id);
    if (!found) return c.json({ error: "not found" }, 404);
    const { reconcileRunUsage } = await import("../../openrouter");
    const result = await reconcileRunUsage(id, { force: true, skipDelay: true });
    const refreshed = store.getRun(id);
    return c.json({ ...result, run: refreshed?.run, generations: refreshed?.generations ?? [] });
  }
);

// Dispatch manual (§8.2): antecipa o tick pra uma issue específica —
// respeitando gates/deps/footprint/seats (não é bypass). Aceita id interno OU
// identifier (ex.: ENG-123) — a query `issue()` do Linear resolve os dois.
// Multi-Linear: tenta cada connection ativa até achar a issue (e despacha
// com aquele ctx — não usa o client default cego).
runsRoutes.post(
  "/dispatch/:issue",
  describeRoute({
    tags: ["Runs"],
    summary: "Dispatch manual de issue",
    responses: {
      200: jsonContent(dispatchResponse, "Dispatch OK"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", issueParam),
  async (c) => {
    const raw = c.req.valid("param").issue;
    const contexts = resolveActiveContexts();
    if (contexts.length === 0) {
      return c.json({ error: "nenhuma connection Linear ativa" }, 400);
    }
    let matched: { issueId: string; ctx: LinearContext } | null = null;
    const errors: string[] = [];
    for (const ctx of contexts) {
      try {
        const issue = await linearFor(ctx).getIssue(raw);
        matched = { issueId: issue.id, ctx };
        break;
      } catch (e) {
        errors.push(`${ctx.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!matched) {
      return c.json(
        { error: `issue não encontrada em nenhuma connection ativa (${errors.join("; ") || "sem detalhes"})` },
        400
      );
    }
    try {
      const outcome = await scheduler.dispatchIssueNow(matched.issueId, matched.ctx);
      return c.json(outcome);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "falha no dispatch manual" }, 400);
    }
  }
);

// Encerra manualmente um run em execução (dashboard "pausar/encerrar" — ver
// scheduler.manualStopRun para o porquê de não existir "pausa" de verdade).
// §7.7: vale pra TODO harness com capabilities.kill (processo local matável);
// Hermes roda na própria infra e não tem processo aqui pra encerrar.
runsRoutes.post(
  "/runs/:id/stop",
  describeRoute({
    tags: ["Runs"],
    summary: "Encerra run manualmente",
    responses: {
      200: jsonContent(okBody.extend({ warning: looseObject.optional() }), "Encerrado"),
      400: jsonContent(errorBody, "Harness sem kill"),
      404: jsonContent(errorBody, "Não encontrado"),
      409: jsonContent(errorBody, "Não está em execução"),
    },
  }),
  async (c) => {
    const id = c.req.param("id");
    const found = store.getRun(id);
    if (!found) return c.json({ error: "run não encontrado" }, 404);

    const run = found.run as {
      status: string;
      backend: string;
      issue_id: string | null;
      linear_connection_id: string | null;
    };
    if (run.status !== "running") {
      return c.json({ error: `run não está em execução (status atual: ${run.status})` }, 409);
    }
    const adapter = harnessAdapter(run.backend);
    if (adapter && !adapter.capabilities.kill) {
      return c.json({ error: `o harness "${run.backend}" não suporta encerrar o processo (roda em infra própria)` }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const reason = body.reason?.trim() || "Encerrado manualmente via dashboard (sem motivo informado).";

    // `cancelRun` só acha o processo se ele ainda estiver na Map em memória do
    // MESMO processo do serviço (ex.: sobrevive a um restart do orchestrator, ou
    // a um crash do goose que já morreu sozinho). Antes, isso abortava aqui com
    // 409 e a run ficava presa em "running" pra sempre — sem processo pra matar
    // e sem forma de fechar pela dashboard. Agora tratamos como o caso normal:
    // não há processo pra matar, mas ainda há um run+issue pra fechar.
    const killed = agent.cancelRun(id);
    store.finishRun(id, { status: "cancelled", error: reason });

    const warnings: string[] = [];
    if (!killed) {
      warnings.push("O processo do worker já não estava mais em execução (provavelmente já havia terminado, ou o serviço reiniciou) — a run foi marcada como encerrada manualmente.");
    }
    if (run.issue_id) {
      let ctx: LinearContext | undefined;
      if (run.linear_connection_id === DEFAULT_CONNECTION_ID) {
        ctx = singleTenantContext() ?? undefined;
      } else if (run.linear_connection_id) {
        const row = getConnection(run.linear_connection_id);
        ctx = row ? toContext(row) : (resolveContextById(run.linear_connection_id) ?? undefined);
      }
      ctx ??= resolveActiveContexts()[0];
      try {
        await scheduler.manualStopRun(run.issue_id, reason, ctx);
      } catch (e) {
        warnings.push(`Houve erro ao atualizar o Linear: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return c.json({ ok: true as const, warning: warnings.length > 0 ? warnings.join(" ") : undefined });
  }
);

runsRoutes.get(
  "/runs/:id/stream",
  describeRoute({
    tags: ["Runs"],
    summary: "SSE de eventos de um run específico",
    responses: { 200: sseContent },
  }),
  (c) => {
    const runId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const onRun = (payload: RunEventTopic) => {
        if (payload.runId !== runId) return;
        stream.writeSSE({ event: payload.type, data: JSON.stringify(payload) }).catch(() => {});
      };
      bus.on("run", onRun);
      stream.onAbort(() => { bus.off("run", onRun); });
      await heartbeatLoop(stream);
    });
  }
);
