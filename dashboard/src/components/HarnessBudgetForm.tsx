import type { HarnessBudgets } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type BudgetDraft = {
  dailyLimit: string;
  weeklyLimit: string;
  monthlyLimit: string;
  action: HarnessBudgets["action"];
};

export function budgetsToDraft(budgets: HarnessBudgets): BudgetDraft {
  return {
    dailyLimit: budgets.dailyLimit?.toString() ?? "",
    weeklyLimit: budgets.weeklyLimit?.toString() ?? "",
    monthlyLimit: budgets.monthlyLimit?.toString() ?? "",
    action: budgets.action,
  };
}

export function draftToBudgets(draft: BudgetDraft, unit: HarnessBudgets["unit"]): HarnessBudgets | null {
  const parse = (s: string): number | undefined => {
    if (!s.trim()) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return NaN;
    return n;
  };
  const daily = parse(draft.dailyLimit);
  const weekly = parse(draft.weeklyLimit);
  const monthly = parse(draft.monthlyLimit);
  if (Number.isNaN(daily) || Number.isNaN(weekly) || Number.isNaN(monthly)) return null;
  return {
    dailyLimit: daily,
    weeklyLimit: weekly,
    monthlyLimit: monthly,
    unit,
    action: draft.action,
  };
}

export function budgetsDirty(draft: BudgetDraft, budgets: HarnessBudgets): boolean {
  const base = budgetsToDraft(budgets);
  return (
    draft.dailyLimit !== base.dailyLimit ||
    draft.weeklyLimit !== base.weeklyLimit ||
    draft.monthlyLimit !== base.monthlyLimit ||
    draft.action !== base.action
  );
}

function LimitField({
  id,
  label,
  unitLabel,
  value,
  onChange,
}: {
  id: string;
  label: string;
  unitLabel: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          step="any"
          className="h-9 w-32"
          value={value}
          placeholder="Sem limite"
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">{unitLabel}</span>
      </div>
    </div>
  );
}

export function HarnessBudgetForm({
  idPrefix,
  draft,
  onChange,
  unit,
  className,
}: {
  idPrefix: string;
  draft: BudgetDraft;
  onChange: (next: BudgetDraft) => void;
  unit: HarnessBudgets["unit"];
  className?: string;
}) {
  const unitLabel = unit === "usd" ? "USD" : "tokens";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap gap-4">
        <LimitField
          id={`${idPrefix}-daily`}
          label="Limite diário"
          unitLabel={unitLabel}
          value={draft.dailyLimit}
          onChange={(dailyLimit) => onChange({ ...draft, dailyLimit })}
        />
        <LimitField
          id={`${idPrefix}-weekly`}
          label="Limite semanal"
          unitLabel={unitLabel}
          value={draft.weeklyLimit}
          onChange={(weeklyLimit) => onChange({ ...draft, weeklyLimit })}
        />
        <LimitField
          id={`${idPrefix}-monthly`}
          label="Limite mensal"
          unitLabel={unitLabel}
          value={draft.monthlyLimit}
          onChange={(monthlyLimit) => onChange({ ...draft, monthlyLimit })}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted-foreground">Ao estourar o limite</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${idPrefix}-action`}
            className="mt-1"
            checked={draft.action === "avisar"}
            onChange={() => onChange({ ...draft, action: "avisar" })}
          />
          <span>
            <span className="font-medium">Avisar</span>
            <span className="block text-xs text-muted-foreground">Envia notificação e continua despachando.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${idPrefix}-action`}
            className="mt-1"
            checked={draft.action === "pausar"}
            onChange={() => onChange({ ...draft, action: "pausar" })}
          />
          <span>
            <span className="font-medium">Pausar despachos</span>
            <span className="block text-xs text-muted-foreground">
              Novos despachos deste harness ficam em espera (a issue não muda de status).
            </span>
          </span>
        </label>
      </fieldset>

      <p className="text-xs text-muted-foreground">
        Unidade fixa: {unit === "usd" ? "dólares (harness com custo via API)" : "tokens (proxy — assinatura não expõe USD)"}.
        Deixe vazio para sem limite naquela janela.
      </p>
    </div>
  );
}
