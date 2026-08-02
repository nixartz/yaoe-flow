import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  IconRefresh,
  IconLoader2,
  IconListCheck,
  IconAlertTriangle,
  IconClockHour4,
  IconCircleCheck,
  IconUserPause,
  IconBinaryTree,
  IconLabel,
  IconLock,
  IconGitPullRequest,
  IconChevronDown,
  IconChevronRight,
  IconPlug,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/PageHeader";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { IssueIdentity } from "@/components/LinearIssueLink";
import { CopyableId } from "@/components/CopyableId";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  linearConnectionsApi,
  readinessApi,
  type ReadinessIssue,
  type ReadinessPhase,
  type ReadinessReason,
  type ReadinessSnapshot,
  type ReadinessStatus,
} from "@/lib/api";
import { formatDateTime, formatElapsed } from "@/lib/format";
import { cn } from "@/lib/utils";

const PHASES: { id: ReadinessPhase | "all"; label: string; roleHint?: string }[] = [
  { id: "all", label: "Todas" },
  { id: "refine", label: "Refino", roleHint: "PMO" },
  { id: "implement", label: "Implementação", roleHint: "Dev" },
  { id: "review", label: "Review", roleHint: "Reviewer" },
  { id: "merge", label: "Merge", roleHint: "Orchestrator" },
  { id: "blocked", label: "Blocked" },
];

const STATUS_META: Record<
  ReadinessStatus,
  { label: string; variant: "success" | "warning" | "destructive" | "default" | "secondary"; icon: typeof IconCircleCheck }
> = {
  ready: { label: "Pronta", variant: "success", icon: IconCircleCheck },
  waiting_capacity: { label: "Aguardando capacidade", variant: "warning", icon: IconClockHour4 },
  blocked_by_rule: { label: "Impeditivo", variant: "destructive", icon: IconAlertTriangle },
  estimating: { label: "Estimando footprint", variant: "default", icon: IconBinaryTree },
  waiting_human: { label: "Aguardando humano", variant: "secondary", icon: IconUserPause },
};

function StatusBadge({ status }: { status: ReadinessStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1 text-[11px]">
      <Icon className="size-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

function CapacityStrip({ snap }: { snap: ReadinessSnapshot }) {
  const items = [
    { key: "refine", label: "PMO", ...snap.capacity.refine },
    { key: "implement", label: "Dev", ...snap.capacity.implement },
    { key: "review", label: "Reviewer", ...snap.capacity.review },
  ] as const;

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((c) => (
        <div
          key={c.key}
          className={cn(
            "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
            c.free <= 0 ? "border-warning/30 bg-warning/5" : "bg-muted/40"
          )}
        >
          <span className="font-medium text-muted-foreground">{c.label}</span>
          <span className="font-mono tabular-nums">
            {c.occupied}/{c.max}
          </span>
          <span className="text-muted-foreground">{c.free === 0 ? "cheio" : `${c.free} livre${c.free === 1 ? "" : "s"}`}</span>
        </div>
      ))}
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
          snap.capacity.merge.busy || snap.capacity.merge.max <= 0
            ? "border-warning/30 bg-warning/5"
            : "bg-muted/40"
        )}
      >
        <span className="font-medium text-muted-foreground">Merge</span>
        <span>
          {snap.capacity.merge.max <= 0
            ? "desligado"
            : snap.capacity.merge.busy
              ? "ocupado"
              : "livre"}
        </span>
      </div>
    </div>
  );
}

function ReasonIcon({ code }: { code: string }) {
  if (code === "missing_label") return <IconLabel className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  if (code === "deps_unsatisfied") return <IconBinaryTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  if (code === "merge_mutex_held" || code === "lock_held")
    return <IconLock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  if (code === "missing_pr" || code === "unauthorized_repo")
    return <IconGitPullRequest className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  if (code === "waiting_human") return <IconUserPause className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  if (code === "no_capacity") return <IconClockHour4 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  if (code === "ready") return <IconCircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />;
  return <IconAlertTriangle className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

function CollisionDetails({ reason, organizationKey }: { reason: ReadinessReason; organizationKey: string | null }) {
  if (!reason.collisions?.length) return null;
  return (
    <ul className="mt-2 space-y-3">
      {reason.collisions.map((c) => (
        <li key={c.issueId} className="rounded-md border bg-card p-3 text-xs">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <IssueIdentity
              identifier={c.identifier}
              issueId={c.issueId}
              organizationKey={organizationKey}
              showIssueUuid
            />
            {c.stateName && (
              <Badge variant="outline" className="text-[10px]">
                {c.stateName}
              </Badge>
            )}
            <span className="text-muted-foreground">segura o lock ativo que bloqueia o pick</span>
          </div>
          {c.overlappingEntries.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-muted-foreground">Entradas de footprint que colidem</p>
              <ul className="space-y-1 font-mono text-[11px]">
                {c.overlappingEntries.map((p, i) => (
                  <li key={`${p.ours}-${p.theirs}-${i}`} className="flex flex-wrap gap-x-2 gap-y-0.5">
                    <span className="text-muted-foreground">esta issue:</span>
                    <span>{p.ours}</span>
                    <span className="text-muted-foreground">×</span>
                    <span className="text-muted-foreground">{c.identifier}:</span>
                    <span>{p.theirs}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function IssueRow({
  issue,
  organizationKey,
  defaultOpen,
}: {
  issue: ReadinessIssue;
  organizationKey: string | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const primary = issue.reasons.find((r) => r.code !== "ready") ?? issue.reasons[0];
  const showComment = issue.phase === "blocked" && issue.blockedComment;

  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={open}
      >
        <span className="mt-0.5 text-muted-foreground" aria-hidden>
          {open ? <IconChevronDown className="size-4" /> : <IconChevronRight className="size-4" />}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <IssueIdentity
              identifier={issue.identifier}
              issueId={issue.issueId}
              organizationKey={organizationKey}
              title={issue.title}
            />
            <StatusBadge status={issue.status} />
            <Badge variant="outline" className="text-[10px]">
              {issue.stateName}
            </Badge>
            {issue.tier === "reopened" && (
              <Badge variant="warning" className="text-[10px]">
                Prioridade (Reopened)
              </Badge>
            )}
            {issue.hasLock && (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <IconLock className="size-3" aria-hidden />
                Lock
              </Badge>
            )}
            {issue.attempts > 0 && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {issue.attempts}/{issue.maxAttempts} tentativas
              </Badge>
            )}
          </div>
          {!open && primary && (
            <div className="line-clamp-2 text-xs text-muted-foreground [&_p]:my-0 [&_code]:text-[0.9em]">
              <MarkdownMessage text={primary.detail} className="text-xs text-muted-foreground" />
            </div>
          )}
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t bg-muted/20 px-3 py-3 pl-10">
          <ul className="space-y-2">
            {issue.reasons.map((r, idx) => (
              <li key={`${r.code}-${idx}`} className="flex gap-2 text-sm">
                <ReasonIcon code={r.code} />
                <div className="min-w-0 flex-1 space-y-1">
                  <MarkdownMessage text={r.detail} className="text-sm text-foreground/90 [&_p]:my-1" />
                  {r.deps && r.deps.length > 0 && (
                    <ul className="mt-1 space-y-2">
                      {r.deps.map((d) => (
                        <li key={d.issueId} className="rounded-md border bg-card p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <IssueIdentity
                              identifier={d.identifier}
                              issueId={d.issueId}
                              organizationKey={organizationKey}
                              showIssueUuid
                            />
                            <Badge variant="outline" className="text-[10px]">
                              {d.stateName}
                            </Badge>
                            <span className="text-xs text-muted-foreground">dependência Linear incompleta</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <CollisionDetails reason={r} organizationKey={organizationKey} />
                  {r.code === "merge_mutex_held" && (r.mergingIssueId || r.mergingIssueIdentifier) && (
                    <div className="mt-1 rounded-md border bg-card p-2">
                      <IssueIdentity
                        identifier={r.mergingIssueIdentifier}
                        issueId={r.mergingIssueId}
                        organizationKey={organizationKey}
                        showIssueUuid={Boolean(r.mergingIssueId)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">issue que segura o mutex de merge</p>
                    </div>
                  )}
                  {r.label && (
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {r.label}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {showComment && (
            <div className="rounded-md border bg-card p-3">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Comentário que melhor explica o Blocked
              </p>
              <MarkdownMessage
                text={issue.blockedComment!}
                className="text-xs text-foreground/90 [&_p]:my-1.5"
              />
            </div>
          )}
          <div className="flex flex-col gap-2 border-t pt-2">
            <span className="text-[11px] text-muted-foreground">
              Footprint: {issue.hasFootprint ? "cacheado no Valkey" : "ausente"}
              {issue.hasLock ? " · lock de footprint ativo" : ""}
            </span>
            <CopyableId value={issue.issueId} kind="issue-uuid" />
            <CopyableId value={issue.identifier} kind="issue" label="Identifier (Linear)" />
          </div>
        </div>
      )}
    </li>
  );
}

function PhaseSection({
  phase,
  issues,
  organizationKey,
}: {
  phase: ReadinessPhase;
  issues: ReadinessIssue[];
  organizationKey: string | null;
}) {
  const meta = PHASES.find((p) => p.id === phase);
  const counts = useMemo(() => {
    const c: Partial<Record<ReadinessStatus, number>> = {};
    for (const i of issues) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [issues]);

  if (issues.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">
            {meta?.label ?? phase}
            {meta?.roleHint ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">· {meta.roleHint}</span>
            ) : null}
          </CardTitle>
          <Badge variant="secondary" className="tabular-nums">
            {issues.length}
          </Badge>
          <div className="ml-auto flex flex-wrap gap-1">
            {(Object.keys(counts) as ReadinessStatus[]).map((s) => (
              <Badge key={s} variant={STATUS_META[s].variant} className="text-[10px]">
                {counts[s]} {STATUS_META[s].label.toLowerCase()}
              </Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {issues.map((issue) => (
            <IssueRow
              key={issue.issueId}
              issue={issue}
              organizationKey={organizationKey}
              defaultOpen={issue.status === "waiting_human" || issue.status === "blocked_by_rule"}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function Readiness() {
  const connectionsQ = useQuery({
    queryKey: ["linear-connections"],
    queryFn: linearConnectionsApi.list,
    staleTime: 60_000,
  });

  const enabledConnections = useMemo(
    () => (connectionsQ.data?.connections ?? []).filter((c) => c.enabled),
    [connectionsQ.data]
  );

  const [connectionId, setConnectionId] = useState<string>("");
  const [phaseFilter, setPhaseFilter] = useState<ReadinessPhase | "all">("all");

  useEffect(() => {
    if (!connectionId && enabledConnections.length > 0) {
      setConnectionId(enabledConnections[0].id);
    }
  }, [enabledConnections, connectionId]);

  const readinessQ = useQuery({
    queryKey: ["readiness", connectionId],
    queryFn: () => readinessApi.get(connectionId || undefined),
    enabled: Boolean(connectionId) || enabledConnections.length === 0,
  });

  const snap: ReadinessSnapshot | undefined = readinessQ.data?.snapshots.find(
    (s) => s.connectionId === connectionId
  ) ?? readinessQ.data?.snapshots[0];

  const missing =
    connectionId && readinessQ.data?.missingConnectionIds.includes(connectionId);

  const filteredIssues = useMemo(() => {
    if (!snap) return [];
    if (phaseFilter === "all") return snap.issues;
    return snap.issues.filter((i) => i.phase === phaseFilter);
  }, [snap, phaseFilter]);

  const byPhase = useMemo(() => {
    const map: Record<ReadinessPhase, ReadinessIssue[]> = {
      refine: [],
      implement: [],
      review: [],
      merge: [],
      blocked: [],
    };
    for (const i of filteredIssues) map[i.phase].push(i);
    return map;
  }, [filteredIssues]);

  const summary = useMemo(() => {
    const issues = snap?.issues ?? [];
    return {
      total: issues.length,
      ready: issues.filter((i) => i.status === "ready").length,
      blocked: issues.filter((i) => i.status === "blocked_by_rule" || i.status === "waiting_human").length,
      waiting: issues.filter((i) => i.status === "waiting_capacity" || i.status === "estimating").length,
    };
  }, [snap]);

  if (connectionsQ.isLoading) return <PageSkeleton rows={5} />;
  if (connectionsQ.isError) {
    return <PageError message="Falha ao carregar conexões Linear." onRetry={() => connectionsQ.refetch()} />;
  }

  if (enabledConnections.length === 0) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <PageHeader
          icon={IconListCheck}
          title="Prontidão"
          description="Candidatas do orquestrador e o que impede cada uma de ser puxada."
        />
        <EmptyState
          title="Nenhuma conexão Linear ativa"
          description="Cadastre e habilite uma connection para o tick gerar o snapshot de prontidão."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/linear-connections">
                <IconPlug className="size-4" />
                Conexões Linear
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        icon={IconListCheck}
        title="Prontidão"
        description="Visão das issues candidatas a serem puxadas pelo orquestrador — e o motivo quando algo trava. Atualizado a cada tick; a fonte da verdade continua sendo o Linear."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger aria-label="Conexão Linear" className="min-w-[12rem]">
                <SelectValue placeholder="Conexão" />
              </SelectTrigger>
              <SelectContent>
                {enabledConnections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.organizationKey ? ` · ${c.organizationKey}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => readinessQ.refetch()}
              disabled={readinessQ.isFetching}
            >
              {readinessQ.isFetching ? (
                <IconLoader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <IconRefresh className="size-4" aria-hidden />
              )}
              Atualizar
            </Button>
          </div>
        }
      />

      {readinessQ.isLoading && <PageSkeleton rows={4} className="p-0" />}
      {readinessQ.isError && (
        <PageError message="Falha ao carregar o snapshot de prontidão." onRetry={() => readinessQ.refetch()} />
      )}

      {!readinessQ.isLoading && !readinessQ.isError && (missing || !snap) && (
        <EmptyState
          title="Snapshot ainda não disponível"
          description="O orquestrador grava este resumo no fim de cada tick. Aguarde o próximo ciclo (cerca de 15s) ou confira se ORCHESTRATOR_ENABLED está ligado."
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => readinessQ.refetch()}>
              <IconRefresh className="size-4" />
              Tentar de novo
            </Button>
          }
        />
      )}

      {snap && (
        <>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                Atualizado {formatDateTime(snap.updatedAt)}
                <span className="text-muted-foreground/80"> · há {formatElapsed(snap.updatedAt)}</span>
              </span>
              {!snap.flags.orchestratorEnabled && (
                <Badge variant="destructive" className="text-[10px]">
                  Orquestrador desligado
                </Badge>
              )}
              <span>
                Auto-dispatch: {snap.flags.autoDispatchIssues ? "ligado" : "off (labels)"}
              </span>
              <span>Auto-merge: {snap.flags.autoMergeIssues ? "ligado" : "off (labels)"}</span>
            </div>
            <CapacityStrip snap={snap} />
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline" className="tabular-nums">
                {summary.total} candidata{summary.total === 1 ? "" : "s"}
              </Badge>
              <Badge variant="success" className="tabular-nums">
                {summary.ready} pronta{summary.ready === 1 ? "" : "s"}
              </Badge>
              <Badge variant="warning" className="tabular-nums">
                {summary.waiting} aguardando
              </Badge>
              <Badge variant="destructive" className="tabular-nums">
                {summary.blocked} com impeditivo / humano
              </Badge>
            </div>
          </div>

          <Tabs value={phaseFilter} onValueChange={(v) => setPhaseFilter(v as ReadinessPhase | "all")}>
            <TabsList className="h-auto flex-wrap">
              {PHASES.map((p) => {
                const count =
                  p.id === "all" ? snap.issues.length : snap.issues.filter((i) => i.phase === p.id).length;
                return (
                  <TabsTrigger key={p.id} value={p.id} className="gap-1.5">
                    {p.label}
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <TabsContent value={phaseFilter} className="mt-4 space-y-4">
              {filteredIssues.length === 0 ? (
                <EmptyState
                  title="Nenhuma issue nesta visão"
                  description="Não há candidatas neste filtro no último snapshot do tick."
                />
              ) : phaseFilter === "all" ? (
                (["refine", "implement", "review", "merge", "blocked"] as ReadinessPhase[]).map((ph) => (
                  <PhaseSection
                    key={ph}
                    phase={ph}
                    issues={byPhase[ph]}
                    organizationKey={snap.organizationKey}
                  />
                ))
              ) : (
                <PhaseSection
                  phase={phaseFilter}
                  issues={byPhase[phaseFilter]}
                  organizationKey={snap.organizationKey}
                />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
