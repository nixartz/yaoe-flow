import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconHistory, IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RoleBadge } from "@/components/RoleBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { UsageBadge } from "@/components/UsageBadge";
import { RunDetailSheet } from "@/components/RunDetailSheet";
import { IssueIdentity } from "@/components/LinearIssueLink";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { runsApi } from "@/lib/api";
import { formatDateTime, formatDuration, HARNESS_OPTIONS, operationLabel } from "@/lib/format";
import { linearConnectionLabel } from "@/lib/linearConnectionLabel";

export function History() {
  const [status, setStatus] = useState<string>("");
  const [role, setRole] = useState<string>("");
  const [backend, setBackend] = useState<string>("");
  const [issueId, setIssueId] = useState("");
  const [page, setPage] = useState(1);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const { data, isFetching, isLoading, isError, refetch } = useQuery({
    queryKey: ["runs", { status, role, backend, issueId, page }],
    queryFn: () =>
      runsApi.list({
        status: status || undefined,
        role: role || undefined,
        backend: backend || undefined,
        issueId: issueId || undefined,
        page,
        pageSize: 25,
      }),
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const hasFilters = !!(status || role || backend || issueId);

  const clearFilters = () => {
    setStatus("");
    setRole("");
    setBackend("");
    setIssueId("");
    setPage(1);
  };

  if (isLoading && !data) return <PageSkeleton rows={8} />;
  if (isError && !data) {
    return <PageError message="Falha ao carregar o histórico." onRetry={() => refetch()} />;
  }

  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <div className="flex items-center gap-2">
          <IconHistory className="size-5 text-primary" aria-hidden />
          <h1 className="text-xl font-semibold">Histórico</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Execuções encerradas e recentes</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="hist-status" className="text-xs font-medium text-muted-foreground">
            Status
          </label>
          <Select
            value={status || "all"}
            onValueChange={(v) => {
              setStatus(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger id="hist-status" className="w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="completed">Concluído</SelectItem>
              <SelectItem value="failed">Falhou</SelectItem>
              <SelectItem value="timeout">Timeout</SelectItem>
              <SelectItem value="cancelled">Encerrado</SelectItem>
              <SelectItem value="running">Executando</SelectItem>
              <SelectItem value="dispatched">Despachado</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="hist-role" className="text-xs font-medium text-muted-foreground">
            Papel
          </label>
          <Select
            value={role || "all"}
            onValueChange={(v) => {
              setRole(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger id="hist-role" className="w-40">
              <SelectValue placeholder="Papel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="pmo">PMO</SelectItem>
              <SelectItem value="dev,worker,senior-engineer">Dev</SelectItem>
              <SelectItem value="reviewer">Reviewer</SelectItem>
              <SelectItem value="orchestrator">Orchestrator</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="hist-harness" className="text-xs font-medium text-muted-foreground">
            Harness
          </label>
          <Select
            value={backend || "all"}
            onValueChange={(v) => {
              setBackend(v === "all" ? "" : v);
              setPage(1);
            }}
          >
            <SelectTrigger id="hist-harness" className="w-40">
              <SelectValue placeholder="Harness" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {HARNESS_OPTIONS.map((h) => (
                <SelectItem key={h.value} value={h.value}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="hist-issue" className="text-xs font-medium text-muted-foreground">
            Issue
          </label>
          <Input
            id="hist-issue"
            placeholder="Ex.: ENG-123"
            className="w-48"
            value={issueId}
            onChange={(e) => {
              setIssueId(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9 gap-1" onClick={clearFilters}>
            <IconX className="size-3.5" />
            Limpar filtros
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Issue</TableHead>
              <TableHead>Conexão</TableHead>
              <TableHead>Papel</TableHead>
              <TableHead>Operação</TableHead>
              <TableHead>Duração</TableHead>
              <TableHead>Uso</TableHead>
              <TableHead>Quando</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows ?? []).map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                tabIndex={0}
                onClick={() => setOpenRunId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenRunId(r.id);
                  }
                }}
              >
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell>
                  <IssueIdentity
                    identifier={r.issue_identifier}
                    issueId={r.issue_id}
                    organizationKey={r.linear_organization_key}
                  />
                </TableCell>
                <TableCell>
                  {(() => {
                    const label = linearConnectionLabel(r);
                    return label ? (
                      <Badge variant="outline" className="font-normal">
                        {label}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    );
                  })()}
                </TableCell>
                <TableCell>
                  <RoleBadge role={r.role} />
                </TableCell>
                <TableCell className="text-muted-foreground">{operationLabel(r.operation)}</TableCell>
                <TableCell>{formatDuration(r.duration_ms)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <UsageBadge run={r} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(r.started_at)}</TableCell>
              </TableRow>
            ))}
            {data?.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    title="Nenhuma execução encontrada"
                    description={hasFilters ? "Tente limpar os filtros." : undefined}
                    action={
                      hasFilters && (
                        <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={clearFilters}>
                          Limpar filtros
                        </button>
                      )
                    }
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {data && data.total > 0 ? `Mostrando ${from}–${to} de ${data.total}` : "0 execuções"}
          {isFetching && " · atualizando…"}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Página anterior">
            <IconChevronLeft className="size-4" />
          </Button>
          <span>
            {page} / {totalPages}
          </span>
          <Button variant="outline" size="icon" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Próxima página">
            <IconChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <RunDetailSheet runId={openRunId} onOpenChange={(open) => !open && setOpenRunId(null)} />
    </div>
  );
}
