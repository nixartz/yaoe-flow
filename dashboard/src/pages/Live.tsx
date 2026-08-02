import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconActivity, IconLoader2 } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RoleBadge } from "@/components/RoleBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { UsageBadge } from "@/components/UsageBadge";
import { RunDetailSheet } from "@/components/RunDetailSheet";
import { ActivityFeed, type ActivityKindFilter } from "@/components/ActivityFeed";
import { IssueIdentity } from "@/components/LinearIssueLink";
import { DispatchManual } from "@/components/DispatchManual";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { runsApi, webhooksApi, type Run } from "@/lib/api";
import { useSse } from "@/lib/useSse";
import { formatElapsed, harnessLabel, operationLabel, roleLabel, runModelBadgeLabel } from "@/lib/format";
import { linearConnectionLabel } from "@/lib/linearConnectionLabel";
import { replaceById, upsertById, removeById } from "@/lib/listSync";
import { cn } from "@/lib/utils";

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const ROLE_FILTERS: { label: string; roles: string[] }[] = [
  { label: "PMO", roles: ["pmo"] },
  { label: "Dev", roles: ["dev", "worker", "senior-engineer"] },
  { label: "Reviewer", roles: ["reviewer"] },
  { label: "Orchestrator", roles: ["orchestrator"] },
];

const KIND_FILTERS: { value: ActivityKindFilter; label: string }[] = [
  { value: "both", label: "Ambos" },
  { value: "runs", label: "Runs" },
  { value: "webhooks", label: "Eventos Linear" },
];

function runFromSse(payload: Record<string, unknown>): Run {
  return {
    id: payload.runId as string,
    backend: payload.backend as Run["backend"],
    operation: payload.operation as string,
    role: payload.role as string,
    issue_id: (payload.issueId as string) ?? null,
    issue_identifier: (payload.issueIdentifier as string) ?? null,
    mode: (payload.mode as string) ?? null,
    status: "running",
    provider: (payload.provider as string) ?? null,
    model: (payload.model as string) ?? null,
    stop_reason: null,
    error_message: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    cost_input_usd: null,
    cost_output_usd: null,
    openrouter_session_id: (payload.runId as string) ?? null,
    goose_session_id: null,
    usage_source: null,
    usage_reconciled_at: null,
    started_at: payload.startedAt as number,
    ended_at: null,
    duration_ms: null,
    agent_id: null,
    agent_version_id: null,
    harness_id: (payload.backend as string) ?? null,
    resolved_config_json: null,
    cost_source: null,
    external_session_id: null,
    external_refs_json: null,
    linear_connection_id: (payload.linearConnectionId as string) ?? null,
    linear_connection_name: null,
    linear_organization_key: null,
  };
}

export function Live() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["runs-active"],
    queryFn: runsApi.active,
    refetchInterval: 10_000,
  });
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

  const [runs, setRuns] = useState<Run[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<ActivityKindFilter>("both");
  const [issueFilter, setIssueFilter] = useState("");
  const now = useNow(1000);

  // Poll = autoridade do conjunto ativo (substitui snapshot).
  useEffect(() => {
    if (data) setRuns(replaceById(data));
  }, [data]);

  useSse<Record<string, unknown>>("/api/runs/stream", (eventName, payload) => {
    const runId = payload.runId as string;
    if (eventName === "run_started") {
      setRuns((prev) => upsertById(prev, runFromSse(payload)));
    } else if (eventName === "run_updated" && payload.usage) {
      const u = payload.usage as Partial<Run>;
      setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, ...u } : r)));
    } else if (eventName === "run_finished") {
      setRuns((prev) => removeById(prev, runId));
    }
  });

  const visible = useMemo(() => {
    const rolesAllowed = roleFilter ? ROLE_FILTERS.find((f) => f.label === roleFilter)?.roles : null;
    const issue = issueFilter.trim().toLowerCase();
    return runs.filter((r) => {
      if (rolesAllowed && !rolesAllowed.includes(r.role)) return false;
      if (issue) {
        const id = (r.issue_identifier ?? r.issue_id ?? "").toLowerCase();
        if (!id.includes(issue)) return false;
      }
      return true;
    });
  }, [runs, roleFilter, issueFilter]);

  const showRuns = kindFilter === "runs" || kindFilter === "both";
  const showFeed = kindFilter === "webhooks" || kindFilter === "both" || kindFilter === "runs";

  if (isLoading && runs.length === 0) return <PageSkeleton rows={4} />;
  if (isError && runs.length === 0) {
    return <PageError message="Falha ao carregar execuções ativas." onRetry={() => refetch()} />;
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex items-center gap-2">
          <IconActivity className="size-5 text-primary" aria-hidden />
          <div>
            <h1 className="text-xl font-semibold">Ao vivo</h1>
            <p className="text-sm text-muted-foreground">
              Execuções em andamento
              {showRuns && (
                <>
                  {" "}
                  ({visible.length}
                  {visible.length !== runs.length && ` de ${runs.length}`})
                </>
              )}
              <span className="ml-2 inline-flex items-center gap-1 text-xs">
                <span className="size-1.5 rounded-full bg-success" aria-hidden />
                tempo real
              </span>
            </p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-md border p-0.5" role="group" aria-label="Tipo de atividade">
            {KIND_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={kindFilter === f.value}
                onClick={() => setKindFilter(f.value)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                  kindFilter === f.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Filtrar por papel">
            {ROLE_FILTERS.map((f) => (
              <button
                key={f.label}
                type="button"
                aria-pressed={roleFilter === f.label}
                onClick={() => setRoleFilter((prev) => (prev === f.label ? null : f.label))}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  roleFilter === f.label
                    ? "border-primary bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="live-issue-filter">
            Filtrar por issue
          </label>
          <Input
            id="live-issue-filter"
            placeholder="Filtrar por issue…"
            className="h-8 w-40"
            value={issueFilter}
            onChange={(e) => setIssueFilter(e.target.value)}
          />
        </div>
      </div>

      <DispatchManual />

      {showRuns && (
        <section aria-label="Execuções ativas">
          {visible.length === 0 ? (
            <EmptyState
              title={runs.length === 0 ? "Nenhum agente em execução" : "Nenhuma execução corresponde aos filtros"}
              description={
                runs.length === 0
                  ? "Use “Iniciar por issue” acima ou aguarde o próximo ciclo do orquestrador."
                  : undefined
              }
              action={
                (roleFilter || issueFilter) && (
                  <button
                    type="button"
                    className="text-sm text-primary underline-offset-2 hover:underline"
                    onClick={() => {
                      setRoleFilter(null);
                      setIssueFilter("");
                    }}
                  >
                    Limpar filtros
                  </button>
                )
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((r) => (
                <Card
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setOpenRunId(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenRunId(r.id);
                    }
                  }}
                >
                  <CardContent className="flex flex-col gap-2.5 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={r.status} />
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <IconLoader2 className="size-3 animate-spin" aria-hidden />
                        {formatElapsed(r.started_at, now)}
                      </span>
                    </div>
                    <IssueIdentity
                      identifier={r.issue_identifier}
                      issueId={r.issue_id}
                      organizationKey={r.linear_organization_key}
                    />
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RoleBadge role={r.role} />
                      <Badge variant="outline" className="font-normal">
                        {operationLabel(r.operation)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {harnessLabel(r.harness_id ?? r.backend)}
                        {r.mode ? ` · ${r.mode}` : ""}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">
                        {roleLabel(r.role)}
                        {(() => {
                          const modelLabel = runModelBadgeLabel(r);
                          return modelLabel ? ` · ${modelLabel}` : "";
                        })()}
                      </span>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {linearConnectionLabel(r) && (
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                            {linearConnectionLabel(r)}
                          </Badge>
                        )}
                        <UsageBadge run={r} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {showFeed && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {kindFilter === "runs"
                ? "Execuções recentes"
                : kindFilter === "webhooks"
                  ? "Eventos do Linear"
                  : "Atividade recente"}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ActivityFeed
              initialRuns={recentRuns?.rows ?? []}
              initialWebhooks={recentWebhooks?.rows ?? []}
              kindFilter={kindFilter}
              onOpenRun={setOpenRunId}
            />
          </CardContent>
        </Card>
      )}

      <RunDetailSheet runId={openRunId} onOpenChange={(open) => !open && setOpenRunId(null)} />
    </div>
  );
}
