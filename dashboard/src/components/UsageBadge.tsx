// Badge de uso/custo do run. Trigger mostra tokens (quando há) ou o harness
// (quando não há) — nunca "sem dados" genérico. O popover adapta copy ao
// harness: assinatura (Cursor/Copilot), Goose/OpenRouter, Hermes, etc.
import { IconCoins, IconCpu } from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { formatCost, formatNumber, harnessLabel, isSubscriptionBilling, runHarnessId } from "@/lib/format";
import type { Run } from "@/lib/api";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  );
}

type UsageFields = Pick<
  Run,
  | "provider"
  | "model"
  | "input_tokens"
  | "output_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens"
  | "cost_usd"
  | "cost_input_usd"
  | "cost_output_usd"
  | "openrouter_session_id"
  | "goose_session_id"
  | "usage_source"
  | "usage_reconciled_at"
  | "backend"
  | "harness_id"
  | "cost_source"
>;

function usageSourceLabel(source: string | null | undefined): string | null {
  if (source === "openrouter_reconciled") return "OpenRouter (reconciliado)";
  if (source === "openrouter_partial") return "OpenRouter (parcial)";
  if (source === "goose_accumulated") return "Goose (preview)";
  if (source === "prompt_response_fallback") return "Goose (fallback do turno)";
  return null;
}

function emptyUsageHint(run: UsageFields, harnessId: string | null): string {
  if (harnessId === "hermes") {
    return "O Hermes não reporta tokens ao orquestrador (dispara e só avisa o resultado). Custo, se houver, fica na conta do provedor do Hermes.";
  }
  if (harnessId === "goose") {
    return "Sem tokens ainda — o Goose envia accumulated_* após o turno; ao fim o serviço pode reconciliar custo via OpenRouter /generation.";
  }
  if (isSubscriptionBilling(run)) {
    const name = harnessLabel(harnessId);
    return `Custo coberto pela assinatura do ${name} (conta pessoal do CLI). Tokens e breakdown só aparecem se este harness reportá-los.`;
  }
  if (harnessId === "claude-code" || harnessId === "codex") {
    return `Sem tokens reportados ainda — quando o ${harnessLabel(harnessId)} enviar usage, eles aparecem aqui (cobrança via API).`;
  }
  return "Sem dados de consumo reportados para este run.";
}

export function UsageBadge({ run }: { run: UsageFields }) {
  const harnessId = runHarnessId(run);
  const harness = harnessLabel(harnessId);
  const hasUsage = (run.input_tokens ?? 0) > 0 || (run.output_tokens ?? 0) > 0 || (run.cost_usd ?? 0) > 0;
  const total = (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
  const sourceLabel = usageSourceLabel(run.usage_source);
  const reconciled = run.usage_source === "openrouter_reconciled";
  const partial = run.usage_source === "openrouter_partial";
  const subscription = isSubscriptionBilling(run);
  // OpenRouter só é relevante de verdade no Goose (ou quando a fonte do usage é OR)
  const showOpenRouterMeta =
    harnessId === "goose" ||
    run.usage_source?.startsWith("openrouter_") === true ||
    (!!run.openrouter_session_id && harnessId === "goose");

  const triggerLabel = hasUsage ? formatNumber(total) : harness;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-input bg-background px-2 py-0.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label={hasUsage ? `Uso: ${formatNumber(total)} tokens` : `Uso: ${harness} (sem tokens reportados)`}
        >
          <IconCoins className="size-3.5 text-muted-foreground" />
          {triggerLabel}
          {showOpenRouterMeta && reconciled && (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">OR</span>
          )}
          {showOpenRouterMeta && partial && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">OR~</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="mb-2 flex items-center gap-2">
          <IconCpu className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">{harness}</div>
            {run.model && <div className="truncate text-xs text-muted-foreground">{run.model}</div>}
          </div>
        </div>

        {!subscription && run.provider && (
          <div className="mb-2 text-xs text-muted-foreground">Provider: {run.provider}</div>
        )}
        {subscription && (
          <div className="mb-2 text-xs text-muted-foreground">Cobrança: assinatura do CLI</div>
        )}
        {sourceLabel && showOpenRouterMeta && (
          <div className="mb-2 text-xs text-muted-foreground">
            Fonte: <span className="font-medium text-foreground">{sourceLabel}</span>
          </div>
        )}
        {showOpenRouterMeta && (run.openrouter_session_id || run.goose_session_id) && (
          <div className="mb-2 flex flex-col gap-1 text-[10px] text-muted-foreground">
            {run.openrouter_session_id && (
              <div className="break-all font-mono">OpenRouter session: {run.openrouter_session_id}</div>
            )}
            {run.goose_session_id && (
              <div className="break-all font-mono">Goose session: {run.goose_session_id}</div>
            )}
          </div>
        )}

        <Separator className="mb-2" />

        {hasUsage ? (
          <div className="flex flex-col gap-1.5">
            <Row label="Tokens de entrada" value={formatNumber(run.input_tokens)} />
            <Row label="Tokens de saída" value={formatNumber(run.output_tokens)} />
            {run.cache_read_tokens != null && run.cache_read_tokens > 0 && (
              <Row label="Cache (leitura)" value={formatNumber(run.cache_read_tokens)} />
            )}
            {run.cache_write_tokens != null && run.cache_write_tokens > 0 && (
              <Row label="Cache (escrita)" value={formatNumber(run.cache_write_tokens)} />
            )}
            <Separator className="my-1" />
            <Row label="Total de tokens" value={formatNumber(total)} />
            {run.cost_input_usd != null && run.cost_input_usd > 0 && (
              <Row label="Custo entrada" value={formatCost(run.cost_input_usd)} />
            )}
            {run.cost_output_usd != null && run.cost_output_usd > 0 && (
              <Row label="Custo saída" value={formatCost(run.cost_output_usd)} />
            )}
            {run.cost_usd != null && <Row label="Custo total" value={formatCost(run.cost_usd)} />}
            {subscription && run.cost_usd == null && <Row label="Custo" value="coberto por assinatura" />}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{emptyUsageHint(run, harnessId)}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
