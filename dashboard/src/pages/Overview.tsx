import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  IconCoins,
  IconRobot,
  IconClock,
  IconCircleCheck,
  IconCurrencyDollar,
  IconTargetArrow,
  IconActivity,
  IconArrowRight,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardValue } from "@/components/ui/card";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { PageHeader } from "@/components/PageHeader";
import { IssueIdentity } from "@/components/LinearIssueLink";
import { ActivityFeed } from "@/components/ActivityFeed";
import { overviewApi, runsApi, webhooksApi } from "@/lib/api";
import { formatCost, formatDuration, formatNumber, roleLabel, roleColorVar } from "@/lib/format";
import { cn } from "@/lib/utils";

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon: typeof IconCoins;
  label: string;
  value: string;
  hint?: string;
  href?: string;
}) {
  const inner = (
    <>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle>{label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="pt-2">
        <CardValue>{value}</CardValue>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </>
  );

  if (href) {
    return (
      <Link to={href} className="block transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
        <Card className="h-full">{inner}</Card>
      </Link>
    );
  }
  return <Card>{inner}</Card>;
}

const ROLES = ["pmo", "dev", "reviewer", "orchestrator"];
const PERIODS = [
  { value: 7, label: "7 dias" },
  { value: 14, label: "14 dias" },
  { value: 30, label: "30 dias" },
] as const;

export function Overview() {
  const [days, setDays] = useState(14);
  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery({ queryKey: ["overview", days], queryFn: () => overviewApi.get(days), refetchInterval: 30_000 });
  const { data: recentRuns } = useQuery({
    queryKey: ["runs-recent"],
    queryFn: () => runsApi.list({ pageSize: 15 }),
    refetchInterval: 15_000,
  });
  const { data: recentWebhooks } = useQuery({
    queryKey: ["webhooks-recent"],
    queryFn: () => webhooksApi.list({ pageSize: 15 }),
    refetchInterval: 15_000,
  });

  const tokensChart = useMemo(
    () => (data?.tokensPerDay ?? []).map((d) => ({ day: d.day.slice(5), Input: d.inputTokens, Output: d.outputTokens })),
    [data]
  );

  const runsByDay = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>();
    for (const r of data?.runsPerDay ?? []) {
      const row = map.get(r.day) ?? { day: r.day.slice(5) };
      row[roleLabel(r.role)] = r.count;
      map.set(r.day, row);
    }
    return [...map.values()];
  }, [data]);

  const k = data?.kpis;
  const successRate =
    k && k.completedInWindow + k.failedInWindow > 0
      ? `${Math.round((k.completedInWindow / (k.completedInWindow + k.failedInWindow)) * 100)}%`
      : "–";

  if (isLoading && !data) return <PageSkeleton rows={8} />;
  if (isError && !data) {
    return <PageError message="Falha ao carregar a visão geral." onRetry={() => refetch()} />;
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Visão geral"
        description="Resumo do que os agentes fizeram hoje e no período selecionado."
        actions={
          <div className="flex items-center gap-2" role="group" aria-label="Período">
            <span className="text-xs text-muted-foreground">Período</span>
            <div className="flex rounded-md border p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setDays(p.value)}
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    days === p.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  aria-pressed={days === p.value}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {/* Faixa "agora" */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi icon={IconRobot} label="Agents ativos agora" value={formatNumber(k?.activeNow)} href="/live" hint="Abrir Ao vivo" />
        <Kpi icon={IconCircleCheck} label="Taxa de sucesso" value={successRate} hint={`Janela de ${days} dias`} href="/history" />
        <Kpi icon={IconCurrencyDollar} label="Custo estimado" value={formatCost(k?.costUsdInWindow)} hint={`Janela de ${days} dias`} />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Hoje</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Kpi
            icon={IconCoins}
            label="Tokens (entrada / saída)"
            value={`${formatNumber(k?.tokensInputToday)} / ${formatNumber(k?.tokensOutputToday)}`}
          />
          <Kpi icon={IconRobot} label="Execuções hoje" value={formatNumber(k?.runsToday)} href="/history" />
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">No período ({days} dias)</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Kpi icon={IconClock} label="Duração média" value={formatDuration(k?.avgDurationMs)} />
          <Kpi icon={IconCircleCheck} label="Concluídas / falhas" value={`${formatNumber(k?.completedInWindow)} / ${formatNumber(k?.failedInWindow)}`} />
          <Kpi icon={IconCurrencyDollar} label="Custo" value={formatCost(k?.costUsdInWindow)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tokens por dia</CardTitle>
          </CardHeader>
          <CardContent className="overflow-hidden pt-2">
            {tokensChart.length === 0 ? (
              <EmptyState title="Sem dados neste período" description="Quando houver execuções, o consumo de tokens aparece aqui." />
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height={256}>
                  <BarChart data={tokensChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                    <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                    <RTooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Input" stackId="t" fill="var(--chart-1)" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="Output" stackId="t" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Execuções por dia (por papel)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-hidden pt-2">
            {runsByDay.length === 0 ? (
              <EmptyState title="Sem dados neste período" description="Quando houver execuções, o gráfico por papel aparece aqui." />
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height={256}>
                  <BarChart data={runsByDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                    <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" allowDecimals={false} />
                    <RTooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {ROLES.map((r, i) => (
                      <Bar
                        key={r}
                        dataKey={roleLabel(r)}
                        stackId="r"
                        fill={roleColorVar(r)}
                        radius={i === ROLES.length - 1 ? [4, 4, 0, 0] : undefined}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Atividade recente</CardTitle>
            <Button asChild size="sm" variant="ghost" className="h-8 gap-1 text-xs">
              <Link to="/live">
                <IconActivity className="size-3.5" aria-hidden />
                Ver ao vivo
                <IconArrowRight className="size-3.5" aria-hidden />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="pt-2">
            <ActivityFeed initialRuns={recentRuns?.rows ?? []} initialWebhooks={recentWebhooks?.rows ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Issues com mais despachos</CardTitle>
            <IconTargetArrow className="size-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent className="pt-2">
            {(data?.topIssues ?? []).length === 0 ? (
              <EmptyState title="Sem despachos na janela" description="Issues com mais atividade aparecerão aqui." />
            ) : (
              <ul className="flex flex-col divide-y">
                {(data?.topIssues ?? []).map((t) => (
                  <li key={t.issueIdentifier} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <IssueIdentity identifier={t.issueIdentifier} className="min-w-0" />
                    <span className="flex shrink-0 items-center gap-1.5">
                      {t.failures > 0 && (
                        <Badge variant="destructive" title="Execuções com falha ou timeout">
                          {t.failures} {t.failures === 1 ? "falha" : "falhas"}
                        </Badge>
                      )}
                      {t.costUsd > 0 && <span className="text-xs text-muted-foreground">{formatCost(t.costUsd)}</span>}
                      <Badge variant="secondary">{t.runs} runs</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
