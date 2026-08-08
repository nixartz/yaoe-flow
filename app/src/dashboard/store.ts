// Persistência da dashboard de observabilidade (runs/eventos/webhooks) + queries
// de leitura usadas pela API. TODA escrita é best-effort: um erro aqui nunca pode
// derrubar um dispatch real (goose/hermes) ou o handler de webhook — só loga.
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { emitRun, emitWebhook } from "./bus";
import { log, errFields } from "../logger";

// Historicamente só "goose"|"hermes" (AGENT_BACKEND); desde a Fase 2 do
// blueprint multi-harness passa a ser qualquer HarnessId (ver agent/harness/types.ts).
export type RunBackend = string;
// "timeout"   — reclaimStale() desistiu da fase (issue devolvida à fila) e nenhum
//               sinal de término chegou antes disso; distingue "sumiu" de "quebrou".
// "cancelled" — encerrado manualmente via dashboard (stop de agente em execução).
export type RunStatus = "running" | "completed" | "failed" | "dispatched" | "timeout" | "cancelled";

export interface StartRunInput {
  backend: RunBackend;
  operation: string;
  role: string;
  issueId?: string;
  issueIdentifier?: string;
  mode?: string;
  provider?: string;
  model?: string;
  // Fase 1 (§6.4): snapshot auditável do que REALMENTE rodou.
  agentId?: string;
  agentVersionId?: string;
  harnessId?: string;
  resolvedConfigJson?: string;
  linearConnectionId?: string;
}

export interface FinishRunInput {
  status: RunStatus;
  stopReason?: string;
  error?: string;
}

export interface UsageInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Custo total do turno (USD). Acumulado no run. */
  costUsd?: number;
  costInputUsd?: number;
  costOutputUsd?: number;
  provider?: string;
  model?: string;
  /** Não sobrescreve se o run já foi reconciliado com OpenRouter. */
  usageSource?: "goose_accumulated" | "prompt_response_fallback";
}

const seqCounters = new Map<string, number>();

function nextSeq(runId: string): number {
  let n = seqCounters.get(runId);
  if (n === undefined) {
    // Counter ausente ≠ run novo: acontece após restart do serviço e após
    // finishRun() (que deleta o counter) quando o processo goose ainda emite
    // eventos póstumos. Recomeçar em 1 colide com os seq já gravados e o
    // ORDER BY seq intercala as duas séries 1-a-1 — a timeline inteira sai
    // com o texto embaralhado palavra por palavra. Retoma do MAX persistido.
    const row = db().query(`SELECT MAX(seq) AS m FROM run_events WHERE run_id = $id`).get({ $id: runId }) as
      | { m: number | null }
      | undefined;
    n = row?.m ?? 0;
  }
  n += 1;
  seqCounters.set(runId, n);
  return n;
}

function safe(operation: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    log.dashboard.warn({ operation, ...errFields(e) }, "dashboard store write failed (best-effort)");
  }
}

export function startRun(input: StartRunInput): string {
  const id = randomUUID();
  const startedAt = Date.now();
  safe("startRun", () => {
    db()
      .query(
        `INSERT INTO runs (id, backend, operation, role, issue_id, issue_identifier, mode, status, provider, model, started_at,
                            agent_id, agent_version_id, harness_id, resolved_config_json, linear_connection_id)
         VALUES ($id, $backend, $operation, $role, $issueId, $issueIdentifier, $mode, 'running', $provider, $model, $startedAt,
                 $agentId, $agentVersionId, $harnessId, $resolvedConfigJson, $linearConnectionId)`
      )
      .run({
        $id: id,
        $backend: input.backend,
        $operation: input.operation,
        $role: input.role,
        $issueId: input.issueId ?? null,
        $issueIdentifier: input.issueIdentifier ?? null,
        $mode: input.mode ?? null,
        $provider: input.provider ?? null,
        $model: input.model ?? null,
        $startedAt: startedAt,
        $agentId: input.agentId ?? null,
        $agentVersionId: input.agentVersionId ?? null,
        $harnessId: input.harnessId ?? input.backend,
        $resolvedConfigJson: input.resolvedConfigJson ?? null,
        $linearConnectionId: input.linearConnectionId ?? null,
      });
    // Mesmo id vai no OpenRouter `session_id` (via OPENROUTER_PARAMETERS no goose)
    // — correlaciona analytics OpenRouter ↔ run na dashboard.
    db()
      .query(`UPDATE runs SET openrouter_session_id = $id WHERE id = $id`)
      .run({ $id: id });
    emitRun({ type: "run_started", runId: id, ...input, startedAt });
  });
  return id;
}

export function recordEvent(
  runId: string,
  kind: string,
  fields: { text?: string; toolName?: string; toolStatus?: string; payload: unknown }
): void {
  safe("recordEvent", () => {
    const seq = nextSeq(runId);
    const ts = Date.now();
    db()
      .query(
        `INSERT INTO run_events (run_id, seq, ts, kind, text, tool_name, tool_status, payload_json)
         VALUES ($runId, $seq, $ts, $kind, $text, $toolName, $toolStatus, $payload)`
      )
      .run({
        $runId: runId,
        $seq: seq,
        $ts: ts,
        $kind: kind,
        $text: fields.text ?? null,
        $toolName: fields.toolName ?? null,
        $toolStatus: fields.toolStatus ?? null,
        $payload: JSON.stringify(fields.payload ?? null),
      });
    // `payload` completo vai junto (não só toolName/toolStatus): é onde o
    // ACP carrega rawOutput/content de um tool_call_update — sem isso, quem
    // acompanha um run AO VIVO nunca vê o retorno da tool, só o input+status
    // (o retorno só aparecia depois de um reload, que refaz o fetch do
    // payload_json completo já salvo no SQLite).
    emitRun({ type: "run_event", runId, seq, ts, kind, text: fields.text, toolName: fields.toolName, toolStatus: fields.toolStatus, payload: fields.payload });
  });
}

function emitUsageUpdated(runId: string, usage: UsageInput): void {
  const row = db()
    .query(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_usd, cost_input_usd, cost_output_usd, provider, model,
              usage_source, usage_reconciled_at
       FROM runs WHERE id = $id`
    )
    .get({ $id: runId }) as
    | {
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cache_write_tokens: number | null;
        cost_usd: number | null;
        cost_input_usd: number | null;
        cost_output_usd: number | null;
        provider: string | null;
        model: string | null;
        usage_source: string | null;
        usage_reconciled_at: number | null;
      }
    | undefined;
  emitRun({
    type: "run_updated",
    runId,
    usage: row ?? {
      input_tokens: usage.inputTokens ?? null,
      output_tokens: usage.outputTokens ?? null,
      cache_read_tokens: usage.cacheReadTokens ?? null,
      cache_write_tokens: usage.cacheWriteTokens ?? null,
      cost_usd: usage.costUsd ?? null,
      cost_input_usd: usage.costInputUsd ?? null,
      cost_output_usd: usage.costOutputUsd ?? null,
      provider: usage.provider ?? null,
      model: usage.model ?? null,
      usage_source: null,
      usage_reconciled_at: null,
    },
  });
}

/**
 * Snapshot absoluto (goose accumulated_* / cost cumulativo da sessão).
 * Usa SET — somar esses valores double-countaria.
 */
export function setUsageSnapshot(runId: string, usage: UsageInput): void {
  safe("setUsageSnapshot", () => {
    // Preview do goose não sobrescreve totais já reconciliados com a API OpenRouter.
    const current = db()
      .query(`SELECT usage_source FROM runs WHERE id = $id`)
      .get({ $id: runId }) as { usage_source: string | null } | undefined;
    if (isOpenRouterUsageSource(current?.usage_source)) return;

    db()
      .query(
        `UPDATE runs SET
           input_tokens = COALESCE($inputTokens, input_tokens),
           output_tokens = COALESCE($outputTokens, output_tokens),
           cache_read_tokens = COALESCE($cacheReadTokens, cache_read_tokens),
           cache_write_tokens = COALESCE($cacheWriteTokens, cache_write_tokens),
           cost_usd = COALESCE($costUsd, cost_usd),
           cost_input_usd = COALESCE($costInputUsd, cost_input_usd),
           cost_output_usd = COALESCE($costOutputUsd, cost_output_usd),
           provider = COALESCE($provider, provider),
           model = COALESCE($model, model),
           usage_source = COALESCE($usageSource, usage_source)
         WHERE id = $runId`
      )
      .run({
        $runId: runId,
        $inputTokens: usage.inputTokens ?? null,
        $outputTokens: usage.outputTokens ?? null,
        $cacheReadTokens: usage.cacheReadTokens ?? null,
        $cacheWriteTokens: usage.cacheWriteTokens ?? null,
        $costUsd: usage.costUsd ?? null,
        $costInputUsd: usage.costInputUsd ?? null,
        $costOutputUsd: usage.costOutputUsd ?? null,
        $provider: usage.provider ?? null,
        $model: usage.model ?? null,
        $usageSource: usage.usageSource ?? null,
      });
    recordEvent(runId, "usage_update", { payload: { ...usage, source: usage.usageSource ?? "snapshot" } });
    emitUsageUpdated(runId, usage);
  });
}

function isOpenRouterUsageSource(source: string | null | undefined): boolean {
  return source === "openrouter_reconciled" || source === "openrouter_partial";
}

/** True se o id existe na tabela runs (p/ associar session_id=runId sem registry). */
export function runExists(id: string): boolean {
  try {
    const row = db().query(`SELECT 1 AS ok FROM runs WHERE id = $id LIMIT 1`).get({ $id: id }) as
      | { ok: number }
      | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Soma deltas (fallback: PromptResponse.usage = último call do turno, não o acumulado). */
export function recordUsage(runId: string, usage: UsageInput): void {
  safe("recordUsage", () => {
    const current = db()
      .query(`SELECT usage_source FROM runs WHERE id = $id`)
      .get({ $id: runId }) as { usage_source: string | null } | undefined;
    if (isOpenRouterUsageSource(current?.usage_source)) return;

    db()
      .query(
        `UPDATE runs SET
           input_tokens = COALESCE(input_tokens, 0) + COALESCE($inputTokens, 0),
           output_tokens = COALESCE(output_tokens, 0) + COALESCE($outputTokens, 0),
           cache_read_tokens = COALESCE(cache_read_tokens, 0) + COALESCE($cacheReadTokens, 0),
           cache_write_tokens = COALESCE(cache_write_tokens, 0) + COALESCE($cacheWriteTokens, 0),
           cost_usd = COALESCE(cost_usd, 0) + COALESCE($costUsd, 0),
           cost_input_usd = COALESCE(cost_input_usd, 0) + COALESCE($costInputUsd, 0),
           cost_output_usd = COALESCE(cost_output_usd, 0) + COALESCE($costOutputUsd, 0),
           provider = COALESCE($provider, provider),
           model = COALESCE($model, model),
           usage_source = COALESCE($usageSource, usage_source)
         WHERE id = $runId`
      )
      .run({
        $runId: runId,
        $inputTokens: usage.inputTokens ?? 0,
        $outputTokens: usage.outputTokens ?? 0,
        $cacheReadTokens: usage.cacheReadTokens ?? 0,
        $cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        $costUsd: usage.costUsd ?? 0,
        $costInputUsd: usage.costInputUsd ?? 0,
        $costOutputUsd: usage.costOutputUsd ?? 0,
        $provider: usage.provider ?? null,
        $model: usage.model ?? null,
        $usageSource: usage.usageSource ?? "prompt_response_fallback",
      });
    recordEvent(runId, "usage_update", { payload: { ...usage, source: usage.usageSource ?? "delta" } });
    emitUsageUpdated(runId, usage);
  });
}

/**
 * Usage/custo/refs externas ao final de um harness run (§7.5): tokens quando
 * reportados, custo USD só quando `costSource=api` (NUNCA estimar custo de
 * assinatura — Overview/UsageBadge mostram "coberto por assinatura").
 */
export function recordHarnessResult(
  runId: string,
  input: {
    costSource?: "api" | "subscription" | "unknown";
    externalSessionId?: string;
    externalRefsJson?: string;
    usage?: UsageInput;
  }
): void {
  safe("recordHarnessResult", () => {
    db()
      .query(
        `UPDATE runs SET
           cost_source = COALESCE($costSource, cost_source),
           external_session_id = COALESCE($externalSessionId, external_session_id),
           external_refs_json = COALESCE($externalRefsJson, external_refs_json)
         WHERE id = $runId`
      )
      .run({
        $runId: runId,
        $costSource: input.costSource ?? null,
        $externalSessionId: input.externalSessionId ?? null,
        $externalRefsJson: input.externalRefsJson ?? null,
      });
    if (input.usage) {
      const usage = input.costSource === "subscription" ? { ...input.usage, costUsd: undefined } : input.usage;
      recordUsage(runId, { ...usage, usageSource: "prompt_response_fallback" });
    }
  });
}

/** Grava o session_id OpenRouter (= runId da dashboard) e o sessionId ACP do goose. */
export function recordSessionIds(
  runId: string,
  ids: { openrouterSessionId?: string; gooseSessionId?: string }
): void {
  safe("recordSessionIds", () => {
    db()
      .query(
        `UPDATE runs SET
           openrouter_session_id = COALESCE($orSid, openrouter_session_id),
           goose_session_id = COALESCE($gooseSid, goose_session_id)
         WHERE id = $runId`
      )
      .run({
        $runId: runId,
        $orSid: ids.openrouterSessionId ?? null,
        $gooseSid: ids.gooseSessionId ?? null,
      });
  });
}

/** Captura um generation id OpenRouter (proxy) — idempotente. */
export function recordGeneration(runId: string, generationId: string): void {
  safe("recordGeneration", () => {
    db()
      .query(
        `INSERT OR IGNORE INTO run_generations (run_id, generation_id, captured_at)
         VALUES ($runId, $generationId, $capturedAt)`
      )
      .run({ $runId: runId, $generationId: generationId, $capturedAt: Date.now() });
  });
}

export function listPendingGenerations(runId: string): string[] {
  try {
    const rows = db()
      .query(
        `SELECT generation_id FROM run_generations
         WHERE run_id = $runId AND reconciled_at IS NULL
         ORDER BY captured_at ASC`
      )
      .all({ $runId: runId }) as { generation_id: string }[];
    return rows.map((r) => r.generation_id);
  } catch (e) {
    log.dashboard.warn({ operation: "listPendingGenerations", ...errFields(e) }, "dashboard store read failed");
    return [];
  }
}

export function listGenerationIds(runId: string): string[] {
  try {
    const rows = db()
      .query(
        `SELECT generation_id FROM run_generations WHERE run_id = $runId ORDER BY captured_at ASC`
      )
      .all({ $runId: runId }) as { generation_id: string }[];
    return rows.map((r) => r.generation_id);
  } catch (e) {
    log.dashboard.warn({ operation: "listGenerationIds", ...errFields(e) }, "dashboard store read failed");
    return [];
  }
}

export function listGenerations(runId: string) {
  try {
    return db()
      .query(`SELECT * FROM run_generations WHERE run_id = $runId ORDER BY captured_at ASC`)
      .all({ $runId: runId });
  } catch (e) {
    log.dashboard.warn({ operation: "listGenerations", ...errFields(e) }, "dashboard store read failed");
    return [];
  }
}

export function updateGeneration(
  runId: string,
  generationId: string,
  data: {
    model?: string;
    providerName?: string;
    tokensPrompt?: number;
    tokensCompletion?: number;
    nativeTokensPrompt?: number;
    nativeTokensCompletion?: number;
    nativeTokensReasoning?: number;
    nativeTokensCached?: number;
    totalCost?: number;
    sessionId?: string;
    externalUser?: string;
    raw?: unknown;
  }
): void {
  safe("updateGeneration", () => {
    db()
      .query(
        `UPDATE run_generations SET
           model = COALESCE($model, model),
           provider_name = COALESCE($providerName, provider_name),
           tokens_prompt = COALESCE($tokensPrompt, tokens_prompt),
           tokens_completion = COALESCE($tokensCompletion, tokens_completion),
           native_tokens_prompt = COALESCE($nativeTokensPrompt, native_tokens_prompt),
           native_tokens_completion = COALESCE($nativeTokensCompletion, native_tokens_completion),
           native_tokens_reasoning = COALESCE($nativeTokensReasoning, native_tokens_reasoning),
           native_tokens_cached = COALESCE($nativeTokensCached, native_tokens_cached),
           total_cost = COALESCE($totalCost, total_cost),
           session_id = COALESCE($sessionId, session_id),
           external_user = COALESCE($externalUser, external_user),
           raw_json = COALESCE($rawJson, raw_json),
           reconciled_at = $reconciledAt
         WHERE run_id = $runId AND generation_id = $generationId`
      )
      .run({
        $runId: runId,
        $generationId: generationId,
        $model: data.model ?? null,
        $providerName: data.providerName ?? null,
        $tokensPrompt: data.tokensPrompt ?? null,
        $tokensCompletion: data.tokensCompletion ?? null,
        $nativeTokensPrompt: data.nativeTokensPrompt ?? null,
        $nativeTokensCompletion: data.nativeTokensCompletion ?? null,
        $nativeTokensReasoning: data.nativeTokensReasoning ?? null,
        $nativeTokensCached: data.nativeTokensCached ?? null,
        $totalCost: data.totalCost ?? null,
        $sessionId: data.sessionId ?? null,
        $externalUser: data.externalUser ?? null,
        $rawJson: data.raw !== undefined ? JSON.stringify(data.raw) : null,
        $reconciledAt: Date.now(),
      });
  });
}

export function sumReconciledGenerations(runId: string): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  provider: string | undefined;
  model: string | undefined;
} {
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    provider: undefined as string | undefined,
    model: undefined as string | undefined,
  };
  try {
    const rows = db()
      .query(
        `SELECT native_tokens_prompt, tokens_prompt, native_tokens_completion, tokens_completion,
                native_tokens_reasoning, native_tokens_cached, total_cost, provider_name, model
         FROM run_generations
         WHERE run_id = $runId AND reconciled_at IS NOT NULL`
      )
      .all({ $runId: runId }) as {
      native_tokens_prompt: number | null;
      tokens_prompt: number | null;
      native_tokens_completion: number | null;
      tokens_completion: number | null;
      native_tokens_reasoning: number | null;
      native_tokens_cached: number | null;
      total_cost: number | null;
      provider_name: string | null;
      model: string | null;
    }[];
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let costUsd = 0;
    let provider: string | undefined;
    let model: string | undefined;
    for (const r of rows) {
      inputTokens += r.native_tokens_prompt ?? r.tokens_prompt ?? 0;
      outputTokens +=
        (r.native_tokens_completion ?? r.tokens_completion ?? 0) + (r.native_tokens_reasoning ?? 0);
      cacheReadTokens += r.native_tokens_cached ?? 0;
      costUsd += r.total_cost ?? 0;
      if (r.provider_name) provider = r.provider_name;
      if (r.model) model = r.model;
    }
    return { inputTokens, outputTokens, cacheReadTokens, costUsd, provider, model };
  } catch (e) {
    log.dashboard.warn({ operation: "sumReconciledGenerations", ...errFields(e) }, "dashboard store read failed");
    return empty;
  }
}

/** Substitui usage do run pelos totais oficiais OpenRouter (fonte reconciliada). */
export function applyReconciledUsage(
  runId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    provider?: string;
    model?: string;
    generationCount: number;
    /** false = ainda há generations pendentes (parcial). */
    complete?: boolean;
  }
): void {
  safe("applyReconciledUsage", () => {
    const reconciledAt = Date.now();
    const source = usage.complete === false ? "openrouter_partial" : "openrouter_reconciled";
    db()
      .query(
        `UPDATE runs SET
           input_tokens = $inputTokens,
           output_tokens = $outputTokens,
           cache_read_tokens = $cacheReadTokens,
           cost_usd = $costUsd,
           cost_input_usd = NULL,
           cost_output_usd = NULL,
           provider = COALESCE($provider, provider),
           model = COALESCE($model, model),
           usage_source = $usageSource,
           usage_reconciled_at = $reconciledAt
         WHERE id = $runId`
      )
      .run({
        $runId: runId,
        $inputTokens: usage.inputTokens,
        $outputTokens: usage.outputTokens,
        $cacheReadTokens: usage.cacheReadTokens,
        $costUsd: usage.costUsd,
        $provider: usage.provider ?? null,
        $model: usage.model ?? null,
        $usageSource: source,
        $reconciledAt: reconciledAt,
      });
    recordEvent(runId, "usage_update", {
      payload: {
        ...usage,
        source,
        reconciledAt,
      },
    });
    emitUsageUpdated(runId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: usage.costUsd,
      provider: usage.provider,
      model: usage.model,
    });
  });
}

export function finishRun(runId: string, input: FinishRunInput): void {
  safe("finishRun", () => {
    const endedAt = Date.now();
    const row = db().query(`SELECT started_at FROM runs WHERE id = $id`).get({ $id: runId }) as
      | { started_at: number }
      | undefined;
    const durationMs = row ? endedAt - row.started_at : null;
    // Primeiro status terminal vence: o WHERE só bate em runs ainda abertas.
    // Sem isso, o encerramento manual ("cancelled" via /runs/:id/stop) era
    // sobrescrito logo em seguida pelo catch de runRecipe() — matar o processo
    // faz o prompt ACP rejeitar, e o "failed" dele apagava o "cancelled" (e o
    // motivo digitado na dashboard) que acabara de ser gravado.
    const res = db()
      .query(
        `UPDATE runs SET status = $status, stop_reason = $stopReason, error_message = $error, ended_at = $endedAt, duration_ms = $durationMs
         WHERE id = $id AND status IN ('running','dispatched')`
      )
      .run({
        $id: runId,
        $status: input.status,
        $stopReason: input.stopReason ?? null,
        $error: input.error ?? null,
        $endedAt: endedAt,
        $durationMs: durationMs,
      });
    seqCounters.delete(runId);
    if (res.changes > 0) emitRun({ type: "run_finished", runId, status: input.status, endedAt, durationMs });
  });
}

export interface WebhookEventInput {
  entityType: string;
  action?: string;
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  projectId?: string;
  projectName?: string;
  milestoneId?: string;
  milestoneName?: string;
  actorName?: string;
  actorType?: string;
  organizationId?: string;
  connectionId?: string;
  summary: string;
  triggeredScheduler: boolean;
  raw: unknown;
}

export function insertWebhookEvent(input: WebhookEventInput): void {
  safe("insertWebhookEvent", () => {
    const receivedAt = Date.now();
    const result = db()
      .query(
        `INSERT INTO webhook_events
           (received_at, entity_type, action, issue_id, issue_identifier, issue_title, team_id, team_key, team_name,
            project_id, project_name, milestone_id, milestone_name, actor_name, actor_type, summary, triggered_scheduler, raw_json,
            organization_id, connection_id)
         VALUES
           ($receivedAt, $entityType, $action, $issueId, $issueIdentifier, $issueTitle, $teamId, $teamKey, $teamName,
            $projectId, $projectName, $milestoneId, $milestoneName, $actorName, $actorType, $summary, $triggeredScheduler, $raw,
            $organizationId, $connectionId)`
      )
      .run({
        $receivedAt: receivedAt,
        $entityType: input.entityType,
        $action: input.action ?? null,
        $issueId: input.issueId ?? null,
        $issueIdentifier: input.issueIdentifier ?? null,
        $issueTitle: input.issueTitle ?? null,
        $teamId: input.teamId ?? null,
        $teamKey: input.teamKey ?? null,
        $teamName: input.teamName ?? null,
        $projectId: input.projectId ?? null,
        $projectName: input.projectName ?? null,
        $milestoneId: input.milestoneId ?? null,
        $milestoneName: input.milestoneName ?? null,
        $actorName: input.actorName ?? null,
        $actorType: input.actorType ?? null,
        $summary: input.summary,
        $triggeredScheduler: input.triggeredScheduler ? 1 : 0,
        $raw: JSON.stringify(input.raw),
        $organizationId: input.organizationId ?? null,
        $connectionId: input.connectionId ?? null,
      });
    emitWebhook({ type: "webhook_received", id: Number(result.lastInsertRowid), summary: input.summary, issueId: input.issueId });
  });
}

// ── Leitura (API) ──────────────────────────────────────────────────────────

export interface RunListFilters {
  status?: string;
  role?: string;
  backend?: string;
  issueId?: string;
  page?: number;
  pageSize?: number;
}

export function listRuns(filters: RunListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filters.status) {
    clauses.push("runs.status = $status");
    params.$status = filters.status;
  }
  if (filters.role) {
    // Aceita CSV ("dev,worker,senior-engineer") — runs antigos + papel canônico
    // "dev"; a UI mostra um único filtro "Dev".
    const roles = filters.role.split(",").map((r) => r.trim()).filter(Boolean);
    if (roles.length > 0) {
      clauses.push(`runs.role IN (${roles.map((_, i) => `$role${i}`).join(",")})`);
      roles.forEach((r, i) => (params[`$role${i}`] = r));
    }
  }
  if (filters.backend) {
    clauses.push("runs.backend = $backend");
    params.$backend = filters.backend;
  }
  if (filters.issueId) {
    clauses.push("(runs.issue_id = $issueId OR runs.issue_identifier = $issueId)");
    params.$issueId = filters.issueId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // LEFT JOIN: nome amigável da connection (se a row foi apagada depois, o id
  // no run permanece e a UI cai pro id / "—").
  const rows = db()
    .query(
      `SELECT runs.*, linear_connections.name AS linear_connection_name,
              linear_connections.organization_key AS linear_organization_key
       FROM runs
       LEFT JOIN linear_connections ON linear_connections.id = runs.linear_connection_id
       ${where}
       ORDER BY runs.started_at DESC LIMIT $limit OFFSET $offset`
    )
    .all({ ...params, $limit: pageSize, $offset: (page - 1) * pageSize });
  const total = (db().query(`SELECT COUNT(*) as c FROM runs ${where}`).get(params) as { c: number }).c;
  return { rows, page, pageSize, total };
}

export function getRun(id: string) {
  const run = db()
    .query(
      `SELECT runs.*, linear_connections.name AS linear_connection_name,
              linear_connections.organization_key AS linear_organization_key
       FROM runs
       LEFT JOIN linear_connections ON linear_connections.id = runs.linear_connection_id
       WHERE runs.id = $id`
    )
    .get({ $id: id });
  if (!run) return null;
  // `id` como desempate: se algum dado antigo ainda tiver seq duplicado (bug
  // do nextSeq resetando — já corrigido na gravação), a ordem de inserção vence.
  const events = db().query(`SELECT * FROM run_events WHERE run_id = $id ORDER BY seq ASC, id ASC`).all({ $id: id });
  const generations = listGenerations(id);
  return { run, events, generations };
}

export interface WebhookListFilters {
  issueId?: string;
  teamId?: string;
  projectId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export function listWebhooks(filters: WebhookListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filters.issueId) {
    clauses.push("(issue_id = $issueId OR issue_identifier = $issueId)");
    params.$issueId = filters.issueId;
  }
  if (filters.teamId) {
    clauses.push("team_id = $teamId");
    params.$teamId = filters.teamId;
  }
  if (filters.projectId) {
    clauses.push("project_id = $projectId");
    params.$projectId = filters.projectId;
  }
  if (filters.q) {
    clauses.push("(summary LIKE $q OR issue_title LIKE $q)");
    params.$q = `%${filters.q}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db()
    .query(`SELECT * FROM webhook_events ${where} ORDER BY received_at DESC LIMIT $limit OFFSET $offset`)
    .all({ ...params, $limit: pageSize, $offset: (page - 1) * pageSize });
  const total = (db().query(`SELECT COUNT(*) as c FROM webhook_events ${where}`).get(params) as { c: number }).c;
  return { rows, page, pageSize, total };
}

export function getWebhook(id: number) {
  return db().query(`SELECT * FROM webhook_events WHERE id = $id`).get({ $id: id });
}

export function overview(days: number) {
  const since = Date.now() - days * 86_400_000;
  const dayExpr = "strftime('%Y-%m-%d', started_at / 1000, 'unixepoch')";

  const tokensPerDay = db()
    .query(
      `SELECT ${dayExpr} as day,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens
       FROM runs WHERE started_at >= $since GROUP BY day ORDER BY day ASC`
    )
    .all({ $since: since });

  const runsPerDay = db()
    .query(
      `SELECT ${dayExpr} as day, role, COUNT(*) as count
       FROM runs WHERE started_at >= $since GROUP BY day, role ORDER BY day ASC`
    )
    .all({ $since: since });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const kpis = db()
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN started_at >= $today THEN input_tokens ELSE 0 END), 0) as tokensInputToday,
         COALESCE(SUM(CASE WHEN started_at >= $today THEN output_tokens ELSE 0 END), 0) as tokensOutputToday,
         COALESCE(SUM(CASE WHEN started_at >= $today THEN 1 ELSE 0 END), 0) as runsToday,
         COALESCE(SUM(CASE WHEN status IN ('running','dispatched') THEN 1 ELSE 0 END), 0) as activeNow,
         COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL AND started_at >= $since THEN duration_ms END), 0) as avgDurationMs,
         COALESCE(SUM(CASE WHEN status = 'completed' AND started_at >= $since THEN 1 ELSE 0 END), 0) as completedInWindow,
         COALESCE(SUM(CASE WHEN status = 'failed' AND started_at >= $since THEN 1 ELSE 0 END), 0) as failedInWindow,
         COALESCE(SUM(CASE WHEN started_at >= $since THEN cost_usd ELSE 0 END), 0) as costUsdInWindow
       FROM runs`
    )
    .get({ $today: todayMs, $since: since });

  // Top issues por nº de despachos na janela — mostra onde o pipeline está
  // gastando esforço (e retrabalho: um failed/timeout alto na mesma issue é o
  // sinal visual do circuit breaker se aproximando).
  const topIssues = db()
    .query(
      `SELECT issue_identifier as issueIdentifier,
              COUNT(*) as runs,
              COALESCE(SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END), 0) as failures,
              COALESCE(SUM(cost_usd), 0) as costUsd
       FROM runs
       WHERE started_at >= $since AND issue_identifier IS NOT NULL
       GROUP BY issue_identifier ORDER BY runs DESC LIMIT 5`
    )
    .all({ $since: since });

  return { tokensPerDay, runsPerDay, kpis, topIssues };
}

export function activeRuns() {
  // Inclui 'dispatched' (Hermes fire-and-report): sem isso, um dispatch Hermes
  // em andamento nunca aparecia como "ativo" — só existia até onStatusChange/
  // reclaimStale fecharem o registro (ver comentário em closeOpenRun acima).
  return db()
    .query(
      `SELECT runs.*, linear_connections.name AS linear_connection_name,
              linear_connections.organization_key AS linear_organization_key
       FROM runs
       LEFT JOIN linear_connections ON linear_connections.id = runs.linear_connection_id
       WHERE runs.status IN ('running','dispatched')
       ORDER BY runs.started_at DESC`
    )
    .all();
}

// ── Reconciliação de runs órfãs ──────────────────────────────────────────────
// O backend Hermes é fire-and-report: marca "dispatched" e nunca chama
// finishRun() de volta (não há callback quando o agente termina de verdade).
// O backend Goose se auto-fecha (completed/failed) via runRecipe(), mas se o
// scheduler detectar — via webhook do Linear ou via reclaimStale() — que a
// issue já saiu da fase que originou o dispatch, o run correspondente pode
// ainda estar pendurado em running/dispatched. Estas funções fecham essa
// lacuna; role opcional porque scheduler.ts nem sempre sabe o nome exato do
// papel usado no dispatch (varia por backend/config) — cai pro run aberto
// mais recente da issue, que é suficiente já que só um dispatch por issue
// fica em voo por vez.
export function findOpenRun(issueId: string, role?: string) {
  const clauses = ["issue_id = $issueId", "status IN ('running','dispatched')"];
  const params: Record<string, string> = { $issueId: issueId };
  if (role) {
    clauses.push("role = $role");
    params.$role = role;
  }
  return db()
    .query(`SELECT id FROM runs WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT 1`)
    .get(params) as { id: string } | undefined;
}

/** All open runs for an issue (duplicate-dispatch detection / stop safety). */
export function listOpenRuns(issueId: string, role?: string): { id: string; role: string }[] {
  const clauses = ["issue_id = $issueId", "status IN ('running','dispatched')"];
  const params: Record<string, string> = { $issueId: issueId };
  if (role) {
    clauses.push("role = $role");
    params.$role = role;
  }
  return db()
    .query(`SELECT id, role FROM runs WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC`)
    .all(params) as { id: string; role: string }[];
}

export function closeOpenRun(issueId: string, role: string | undefined, status: RunStatus, note?: string): void {
  const open = findOpenRun(issueId, role);
  if (!open) return;
  finishRun(open.id, { status, error: note });
}

/**
 * Close every open run for the issue, optionally skipping live process ids
 * (Blocked while a twin dispatch is still executing must not mark it failed).
 */
export function closeOpenRuns(
  issueId: string,
  status: RunStatus,
  note?: string,
  opts?: { role?: string; exceptRunIds?: ReadonlySet<string> | string[] }
): void {
  const except = opts?.exceptRunIds
    ? opts.exceptRunIds instanceof Set
      ? opts.exceptRunIds
      : new Set(opts.exceptRunIds)
    : null;
  for (const row of listOpenRuns(issueId, opts?.role)) {
    if (except?.has(row.id)) continue;
    finishRun(row.id, { status, error: note });
  }
}

/**
 * If a live harness process is still emitting events but the row was closed
 * (typically sibling stop → Linear Blocked → closeOpenRun), restore running.
 * Does **not** revive intentional `cancelled` or successful `completed`.
 */
export function reviveRunIfStillActive(runId: string): void {
  safe("reviveRunIfStillActive", () => {
    const res = db()
      .query(
        `UPDATE runs SET status = 'running', stop_reason = NULL, error_message = NULL,
                ended_at = NULL, duration_ms = NULL
         WHERE id = $id AND status IN ('failed','timeout')`
      )
      .run({ $id: runId });
    if (res.changes > 0) {
      log.dashboard.info({ runId }, "run revived to running (events still arriving after premature close)");
      emitRun({ type: "run_updated", runId, status: "running", revived: true });
    }
  });
}

// Sinal de vida do run aberto da issue, para o reclaimStale distinguir "agent
// vivo trabalhando há muito tempo" (tool calls/chunks recentes — não reclama)
// de "agent morto/travado" (nenhum evento há mais que o timeout — reclama).
// `lastActivityAt` = último run_event, ou o started_at se ainda não houver
// eventos. Só o backend Goose emite trace; p/ Hermes não há run aberto com
// eventos e o reclaim segue caindo no critério antigo (duração total).
export function openRunActivity(issueId: string): { runId: string; lastActivityAt: number } | undefined {
  const row = db()
    .query(
      `SELECT r.id AS runId, COALESCE(MAX(e.ts), r.started_at) AS lastActivityAt
       FROM runs r LEFT JOIN run_events e ON e.run_id = r.id
       WHERE r.issue_id = $issueId AND r.status IN ('running','dispatched')
       GROUP BY r.id ORDER BY r.started_at DESC LIMIT 1`
    )
    .get({ $issueId: issueId }) as { runId: string; lastActivityAt: number } | undefined;
  return row ?? undefined;
}

// ── Logs persistidos (habilita paginação/query server-side na tela de Logs) ──
// Alimentado pelo bus (ver dashboard/server.ts), não pelo logger.ts diretamente
// — evita import circular (logger.ts -> logBuffer.ts -> store.ts -> logger.ts).
export function insertLogLine(raw: string): void {
  safe("insertLogLine", () => {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* linha não-JSON (ex.: stack trace multi-linha) — guarda só o raw */
    }
    const ts = typeof parsed?.time === "number" ? parsed.time : Date.now();
    const level = typeof parsed?.level === "string" ? parsed.level : null;
    const feature = typeof parsed?.feature === "string" ? parsed.feature : null;
    const msg = typeof parsed?.msg === "string" ? parsed.msg : null;
    db()
      .query(
        `INSERT INTO log_lines (ts, level, feature, msg, fields_json, raw)
         VALUES ($ts, $level, $feature, $msg, $fields, $raw)`
      )
      .run({
        $ts: ts,
        $level: level,
        $feature: feature,
        $msg: msg,
        $fields: JSON.stringify(parsed ?? {}),
        $raw: raw,
      });
  });
}
