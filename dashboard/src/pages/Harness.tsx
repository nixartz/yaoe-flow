import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconServer2,
  IconRefresh,
  IconCheck,
  IconX,
  IconLoader2,
  IconAlertTriangle,
  IconInfoCircle,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { PageHeader } from "@/components/PageHeader";
import { SettingsField } from "@/components/settings/SettingsField";
import { StickySaveBar } from "@/components/StickySaveBar";
import {
  HarnessBudgetForm,
  budgetsToDraft,
  budgetsDirty,
  draftToBudgets,
  type BudgetDraft,
} from "@/components/HarnessBudgetForm";
import { useBeforeUnload } from "@/hooks/useBeforeUnload";
import {
  harnessApi,
  settingsApi,
  ApiError,
  type HarnessReportEntry,
  type SettingEntry,
  type SettingGroup,
} from "@/lib/api";
import { formatDateTime, harnessLabel } from "@/lib/format";
import { capabilityChips, harnessAttentionScore } from "@/lib/harnessUi";
import { settingLabel } from "@/lib/settingsUi";
import { cn } from "@/lib/utils";

function StatusBadges({ h }: { h: HarnessReportEntry }) {
  const d = h.detection;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {d?.installed ? (
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <IconCheck className="size-3" aria-hidden />
          Instalado{d.version ? ` · v${d.version}` : ""}
        </Badge>
      ) : (
        <Badge variant="destructive" className="gap-1 text-[10px]">
          <IconX className="size-3" aria-hidden />
          Não instalado
        </Badge>
      )}
      {d?.authStatus === "ok" && (
        <Badge variant="secondary" className="text-[10px]">
          Conectado{d.authAccount ? ` · ${d.authAccount}` : ""}
        </Badge>
      )}
      {d?.authStatus === "not-logged" && (
        <Badge variant="destructive" className="text-[10px]">
          Precisa login
        </Badge>
      )}
      {d?.authStatus === "unknown" && d?.installed && (
        <Badge variant="outline" className="text-[10px]">
          Auth desconhecido
        </Badge>
      )}
    </div>
  );
}

function CapabilityBadges({ h }: { h: HarnessReportEntry }) {
  const chips = capabilityChips(h.capabilities);
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <Tooltip key={c.key}>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-default">
                <Badge variant="outline" className="text-[10px]">
                  {c.label}
                </Badge>
              </span>
            </TooltipTrigger>
            {c.tip && (
              <TooltipContent side="top" className="max-w-xs text-xs">
                {c.tip}
              </TooltipContent>
            )}
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

function HarnessCard({
  h,
  settingDrafts,
  onSettingChange,
  onSettingReset,
  resetPendingKey,
  budgetDraft,
  onBudgetChange,
  expanded,
  onToggle,
}: {
  h: HarnessReportEntry;
  settingDrafts: Record<string, string>;
  onSettingChange: (key: string, value: string) => void;
  onSettingReset: (key: string) => void;
  resetPendingKey: string | null;
  budgetDraft: BudgetDraft;
  onBudgetChange: (draft: BudgetDraft) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const redetect = useMutation({
    mutationFn: () => harnessApi.redetect(h.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["harness"] }),
  });

  const needsAttention = !h.detection?.installed || h.detection?.authStatus === "not-logged";
  const unit = h.capabilities.costSource === "api" ? "usd" : "tokens";
  const panelId = `harness-panel-${h.id}`;

  return (
    <Card className={cn(needsAttention && "border-warning/40")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={panelId}
          >
            {expanded ? (
              <IconChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <IconChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="font-semibold">{h.label}</span>
            <StatusBadges h={h} />
          </button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1 px-2 text-xs"
            disabled={redetect.isPending}
            onClick={(e) => {
              e.stopPropagation();
              redetect.mutate();
            }}
          >
            {redetect.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconRefresh className="size-3.5" />}
            Re-detectar
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <CapabilityBadges h={h} />

        {!h.detection?.installed && h.detection?.installHint && (
          <p className="flex items-start gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <IconInfoCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Instalação: {h.detection.installHint}</span>
          </p>
        )}
        {h.detection?.authStatus === "not-logged" && h.detection?.loginHint && (
          <p className="flex items-start gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <IconInfoCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Login: {h.detection.loginHint}</span>
          </p>
        )}
        {h.detection?.checkedAt && (
          <p className="text-xs text-muted-foreground">Verificado em {formatDateTime(h.detection.checkedAt)}</p>
        )}

        {expanded && (
          <div id={panelId} className="flex flex-col gap-4 border-t pt-3">
            {h.settings.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium">Credenciais e parâmetros</p>
                <p className="mb-2 text-xs text-muted-foreground">
                  Mesma fonte da tela Configuração — alterações ficam na barra de salvar abaixo.
                </p>
                <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
                  {h.settings.map((s) => (
                    <SettingsField
                      key={s.key}
                      entry={s}
                      draft={settingDrafts[s.key]}
                      onChange={(v) => onSettingChange(s.key, v)}
                      compact
                      showTechnicalKey={false}
                      onReset={s.editable && s.source === "db" ? () => onSettingReset(s.key) : undefined}
                      resetPending={resetPendingKey === s.key}
                    />
                  ))}
                </form>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Sem credenciais específicas neste harness. Parâmetros globais (atribuição, etc.) ficam em{" "}
                <Link to="/config" className="text-primary underline-offset-2 hover:underline">
                  Configuração
                </Link>
                .
              </p>
            )}

            <div>
              <p className="mb-2 text-xs font-medium">Limites de uso</p>
              <HarnessBudgetForm
                idPrefix={`budget-${h.id}`}
                draft={budgetDraft}
                onChange={onBudgetChange}
                unit={unit}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Harness() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["harness"],
    queryFn: harnessApi.get,
  });

  const [settingDrafts, setSettingDrafts] = useState<Record<string, string>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, BudgetDraft>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [resetPendingKey, setResetPendingKey] = useState<string | null>(null);
  /** null = ainda não inicializado a partir dos dados (abre os que precisam atenção). */
  const [expandedIds, setExpandedIds] = useState<Set<string> | null>(null);

  const entryByKey = useMemo(() => {
    const m = new Map<string, SettingEntry>();
    for (const h of data?.harnesses ?? []) {
      for (const s of h.settings) m.set(s.key, s);
    }
    return m;
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setBudgetDrafts((prev) => {
      const next = { ...prev };
      for (const h of data.harnesses) {
        if (!next[h.id] || !budgetsDirty(next[h.id], h.budgets)) {
          next[h.id] = budgetsToDraft(h.budgets);
        }
      }
      return next;
    });
    setExpandedIds((prev) => {
      if (prev) return prev;
      return new Set();
    });
  }, [data]);

  useEffect(() => {
    setSettingDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        const e = entryByKey.get(k);
        if (!e) {
          delete next[k];
          changed = true;
          continue;
        }
        if (!e.secret && v === e.value) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entryByKey]);

  const dirtyBudgetIds = useMemo(() => {
    if (!data) return [] as string[];
    return data.harnesses
      .filter((h) => {
        const d = budgetDrafts[h.id];
        return d && budgetsDirty(d, h.budgets);
      })
      .map((h) => h.id);
  }, [data, budgetDrafts]);

  const dirtySettingKeys = useMemo(() => Object.keys(settingDrafts), [settingDrafts]);
  const dirtyCount = dirtySettingKeys.length + dirtyBudgetIds.length;
  useBeforeUnload(dirtyCount > 0);

  const setSettingDraft = useCallback(
    (key: string, value: string) => {
      setSaveOk(false);
      setSaveError(null);
      const entry = entryByKey.get(key);
      setSettingDrafts((prev) => {
        const next = { ...prev };
        if (entry && !entry.secret && value === entry.value) delete next[key];
        else if (entry?.secret && value === "") delete next[key];
        else next[key] = value;
        return next;
      });
    },
    [entryByKey]
  );

  const discard = () => {
    setSettingDrafts({});
    if (data) {
      const budgets: Record<string, BudgetDraft> = {};
      for (const h of data.harnesses) budgets[h.id] = budgetsToDraft(h.budgets);
      setBudgetDrafts(budgets);
    }
    setSaveError(null);
    setSaveOk(false);
  };

  const applySettingsGroups = (groups: SettingGroup[]) => {
    qc.setQueryData(["harness"], (old: typeof data) => {
      if (!old) return old;
      const byKey = new Map<string, SettingEntry>();
      for (const g of groups) for (const e of g.entries) byKey.set(e.key, e);
      return {
        ...old,
        harnesses: old.harnesses.map((h) => ({
          ...h,
          settings: h.settings.map((s) => byKey.get(s.key) ?? s),
        })),
      };
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const errors: string[] = [];
      for (const key of Object.keys(settingDrafts)) {
        try {
          const res = await settingsApi.update(key, settingDrafts[key]);
          applySettingsGroups(res.groups);
          setSettingDrafts((prev) => {
            const n = { ...prev };
            delete n[key];
            return n;
          });
        } catch (e) {
          errors.push(`${settingLabel(key)}: ${e instanceof ApiError ? e.message : "falha"}`);
        }
      }
      for (const id of dirtyBudgetIds) {
        const h = data?.harnesses.find((x) => x.id === id);
        const draft = budgetDrafts[id];
        if (!h || !draft) continue;
        const unit = h.capabilities.costSource === "api" ? "usd" : "tokens";
        const body = draftToBudgets(draft, unit);
        if (!body) {
          errors.push(`${h.label}: limites inválidos (use números ≥ 0 ou vazio)`);
          continue;
        }
        try {
          const res = await harnessApi.setBudgets(id, body);
          qc.setQueryData(["harness"], (old: typeof data) => {
            if (!old) return old;
            return {
              ...old,
              harnesses: old.harnesses.map((x) => (x.id === id ? { ...x, budgets: res.budgets } : x)),
            };
          });
        } catch (e) {
          errors.push(`${h.label} (limites): ${e instanceof ApiError ? e.message : "falha"}`);
        }
      }
      await qc.invalidateQueries({ queryKey: ["harness"] });
      return { errors };
    },
    onSuccess: (res) => {
      if (res.errors.length) {
        setSaveError(res.errors.join(" · "));
        setSaveOk(false);
      } else {
        setSaveError(null);
        setSaveOk(true);
      }
    },
    onError: (e) => {
      setSaveError(e instanceof ApiError ? e.message : "Falha ao salvar");
      setSaveOk(false);
    },
  });

  const resetOne = useMutation({
    mutationFn: (key: string) => settingsApi.reset(key),
    onMutate: (key) => setResetPendingKey(key),
    onSuccess: (res, key) => {
      applySettingsGroups(res.groups);
      setSettingDrafts((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });
    },
    onSettled: () => setResetPendingKey(null),
  });

  const detectAll = useMutation({
    mutationFn: harnessApi.detectAll,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["harness"] }),
  });

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.harnesses].sort(
      (a, b) => harnessAttentionScore(a.detection) - harnessAttentionScore(b.detection)
    );
  }, [data]);

  if (isLoading) return <PageSkeleton rows={6} />;
  if (isError || !data) {
    return <PageError message="Falha ao carregar harness." onRetry={() => refetch()} />;
  }

  return (
    <div className={cn("flex min-h-full flex-col gap-4 p-6", dirtyCount > 0 && "pb-24")}>
      <PageHeader
        icon={IconServer2}
        title="Harness"
        description="Ferramentas que executam os agentes: status de instalação, credenciais e limites de uso."
        actions={
          <Button size="sm" variant="outline" className="gap-1" disabled={detectAll.isPending} onClick={() => detectAll.mutate()}>
            {detectAll.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconRefresh className="size-4" />}
            Re-detectar todos
          </Button>
        }
      />

      {data.banners.length > 0 && (
        <div className="flex flex-col gap-2" role="status">
          {data.banners.map((b) => (
            <div
              key={b.harnessId}
              className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
            >
              <IconAlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
              <span>
                <strong>{harnessLabel(b.harnessId)}</strong>: limite {b.window} estourado ({b.spend}/{b.limit}{" "}
                {b.unit === "usd" ? "USD" : "tokens"}) — ação: {b.action === "pausar" ? "pausar despachos" : "avisar"}
                {b.action === "pausar" && " (novos despachos deste harness em espera)"}
              </span>
            </div>
          ))}
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyState title="Nenhum harness registrado" description="O serviço ainda não reportou adapters de execução." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sorted.map((h) => {
            const expanded = expandedIds?.has(h.id) ?? false;
            return (
              <HarnessCard
                key={h.id}
                h={h}
                settingDrafts={settingDrafts}
                onSettingChange={setSettingDraft}
                onSettingReset={(key) => resetOne.mutate(key)}
                resetPendingKey={resetPendingKey}
                budgetDraft={budgetDrafts[h.id] ?? budgetsToDraft(h.budgets)}
                onBudgetChange={(draft) => {
                  setSaveOk(false);
                  setSaveError(null);
                  setBudgetDrafts((prev) => ({ ...prev, [h.id]: draft }));
                }}
                expanded={expanded}
                onToggle={() => {
                  setExpandedIds((prev) => {
                    const next = new Set(prev ?? []);
                    if (next.has(h.id)) next.delete(h.id);
                    else next.add(h.id);
                    return next;
                  });
                }}
              />
            );
          })}
        </div>
      )}

      <StickySaveBar
        dirtyCount={dirtyCount}
        onDiscard={discard}
        onSave={() => save.mutate()}
        saving={save.isPending}
        error={saveError}
        success={saveOk}
      />
    </div>
  );
}
