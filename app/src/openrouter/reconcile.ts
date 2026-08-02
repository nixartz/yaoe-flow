// Após o run terminar, busca GET /api/v1/generation?id= pra cada generation
// capturado pelo proxy e grava o snapshot oficial (tokens + total_cost) no run.
import { config } from "../config";
import { log, errFields } from "../logger";
import * as store from "../dashboard/store";
import { waitForPendingCaptures } from "./proxy";

interface GenerationData {
  id?: string;
  model?: string | null;
  provider_name?: string | null;
  tokens_prompt?: number | null;
  tokens_completion?: number | null;
  native_tokens_prompt?: number | null;
  native_tokens_completion?: number | null;
  native_tokens_reasoning?: number | null;
  native_tokens_cached?: number | null;
  total_cost?: number | null;
  session_id?: string | null;
  external_user?: string | null;
}

async function fetchGeneration(generationId: string, attempt: number): Promise<GenerationData | null> {
  const key = config.openrouter.apiKey || process.env.OPENROUTER_API_KEY || "";
  if (!key) {
    log.openrouter.warn("OPENROUTER_API_KEY ausente — não dá pra reconciliar via /generation");
    return null;
  }
  const base = config.openrouter.upstream.replace(/\/$/, "");
  const url = `${base}/api/v1/generation?id=${encodeURIComponent(generationId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://github.com/nixartz/ai-agents",
      "X-Title": "yaoe-flow",
    },
  });
  if (res.status === 404) {
    // Ainda não indexado — retry
    if (attempt < config.openrouter.reconcileRetries) return null;
    log.openrouter.warn({ generationId, status: res.status }, "generation ainda indisponível após retries");
    return null;
  }
  if (res.status === 402) {
    // Créditos/pagamento — não adianta retry
    log.openrouter.warn({ generationId, status: 402 }, "OpenRouter /generation retornou 402 (créditos)");
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter /generation ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: GenerationData };
  return json.data ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reconcilia custo/tokens do run com a API oficial OpenRouter.
 * Best-effort: falha não derruba o dispatch (já terminou).
 */
export async function reconcileRunUsage(
  runId: string,
  opts?: { force?: boolean; skipDelay?: boolean; isRetry?: boolean }
): Promise<{
  ok: boolean;
  generations: number;
  reconciled: number;
  costUsd: number | null;
  complete: boolean;
}> {
  if (!config.openrouter.reconcile) {
    return { ok: false, generations: 0, reconciled: 0, costUsd: null, complete: false };
  }

  // Espera o tee do proxy gravar os gen-ids (senão listamos vazio e nunca
  // reconciliamos — o fire-and-forget no finally do goose corria essa race).
  await waitForPendingCaptures(runId);

  // OpenRouter indexa o /generation com um atraso curto após o stream fechar.
  if (!opts?.skipDelay) {
    await sleep(config.openrouter.reconcileDelayMs);
  }

  let targets = opts?.force ? store.listGenerationIds(runId) : store.listPendingGenerations(runId);
  // Segunda chance curta: último chunk às vezes grava logo após o tee fechar.
  if (targets.length === 0 && !opts?.force) {
    await sleep(500);
    targets = store.listPendingGenerations(runId);
  }
  if (targets.length === 0) {
    log.openrouter.debug({ runId }, "nenhuma generation pendente — skip reconcile");
    return { ok: false, generations: 0, reconciled: 0, costUsd: null, complete: false };
  }

  const pendingSet = new Set(store.listPendingGenerations(runId));
  let fetchedNow = 0;
  for (const genId of targets) {
    // Em force, pula as já reconciliadas (só rebusca pendentes + re-soma).
    if (opts?.force && !pendingSet.has(genId)) continue;
    let data: GenerationData | null = null;
    for (let attempt = 0; attempt <= config.openrouter.reconcileRetries; attempt++) {
      try {
        data = await fetchGeneration(genId, attempt);
        if (data) break;
      } catch (e) {
        if (attempt >= config.openrouter.reconcileRetries) {
          log.openrouter.warn({ runId, generationId: genId, ...errFields(e) }, "falha ao buscar generation");
        }
      }
      if (!data && attempt < config.openrouter.reconcileRetries) {
        await sleep(config.openrouter.reconcileRetryMs * (attempt + 1));
      }
    }
    if (!data) continue;
    store.updateGeneration(runId, genId, {
      model: data.model ?? undefined,
      providerName: data.provider_name ?? undefined,
      tokensPrompt: data.tokens_prompt ?? undefined,
      tokensCompletion: data.tokens_completion ?? undefined,
      nativeTokensPrompt: data.native_tokens_prompt ?? undefined,
      nativeTokensCompletion: data.native_tokens_completion ?? undefined,
      nativeTokensReasoning: data.native_tokens_reasoning ?? undefined,
      nativeTokensCached: data.native_tokens_cached ?? undefined,
      totalCost: data.total_cost ?? undefined,
      sessionId: data.session_id ?? undefined,
      externalUser: data.external_user ?? undefined,
      raw: data,
    });
    fetchedNow++;
  }

  const totals = store.sumReconciledGenerations(runId);
  const stillPending = store.listPendingGenerations(runId).length;
  const reconciledCount = store.listGenerationIds(runId).length - stillPending;
  const complete = stillPending === 0 && reconciledCount > 0;

  if (reconciledCount === 0) {
    return { ok: false, generations: targets.length, reconciled: 0, costUsd: null, complete: false };
  }

  if (!complete) {
    log.openrouter.warn(
      { runId, targets: targets.length, fetchedNow, stillPending },
      "reconciliação parcial — algumas generations ainda indisponíveis no OpenRouter"
    );
  }

  store.applyReconciledUsage(runId, {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    costUsd: totals.costUsd,
    provider: totals.provider,
    model: totals.model,
    generationCount: reconciledCount,
    complete,
  });

  log.openrouter.info(
    {
      runId,
      generations: targets.length,
      reconciled: reconciledCount,
      fetchedNow,
      stillPending,
      complete,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
    },
    complete
      ? "usage reconciliado via OpenRouter /generation"
      : "usage parcialmente reconciliado via OpenRouter /generation"
  );

  // Uma segunda passagem automática se ainda houver pendentes (indexação lenta).
  if (!complete && !opts?.isRetry) {
    const retryDelay =
      config.openrouter.reconcileDelayMs + config.openrouter.reconcileRetryMs * config.openrouter.reconcileRetries;
    void sleep(retryDelay)
      .then(() => reconcileRunUsage(runId, { force: true, skipDelay: true, isRetry: true }))
      .catch((e) => {
        log.openrouter.warn({ runId, ...errFields(e) }, "retry de reconcile OpenRouter falhou");
      });
  }

  return {
    ok: true,
    generations: targets.length,
    reconciled: reconciledCount,
    costUsd: totals.costUsd,
    complete,
  };
}
