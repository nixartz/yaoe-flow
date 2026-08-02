import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconWebhook, IconChevronLeft, IconChevronRight, IconChevronDown } from "@tabler/icons-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { IssueIdentity } from "@/components/LinearIssueLink";
import { WebhookChangeChips } from "@/components/WebhookChangeChips";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { webhooksApi, type WebhookEventRow } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { parseWebhookChange, entityTypeLabel, actionLabel } from "@/lib/webhookChange";
import { cn } from "@/lib/utils";

function WebhookDetailSheet({
  row,
  onOpenChange,
}: {
  row: WebhookEventRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [techOpen, setTechOpen] = useState(false);
  const change = useMemo(() => (row ? parseWebhookChange(row.raw_json, row.summary) : null), [row]);

  let prettyJson = row?.raw_json ?? "";
  try {
    prettyJson = JSON.stringify(JSON.parse(row?.raw_json ?? "{}"), null, 2);
  } catch {
    /* raw inválido — mostra como veio */
  }

  return (
    <Sheet open={!!row} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-xl">
        {row && change && (
          <>
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{entityTypeLabel(row.entity_type)}</Badge>
                {row.action && <Badge variant="secondary">{actionLabel(row.action)}</Badge>}
                {row.triggered_scheduler ? (
                  <Badge variant="success">Disparou o ciclo</Badge>
                ) : (
                  <Badge variant="secondary">Sem disparo</Badge>
                )}
              </div>
              <SheetTitle>
                <IssueIdentity identifier={row.issue_identifier} issueId={row.issue_id} title={row.issue_title} />
              </SheetTitle>
              <SheetDescription>{formatDateTime(row.received_at)}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 overflow-y-auto p-4">
              <section>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">O que mudou</h3>
                <WebhookChangeChips change={change} summaryFallback={row.summary} />
                {!change.hasStructuredDiff && row.summary && (
                  <p className="mt-2 text-sm text-muted-foreground">{row.summary}</p>
                )}
              </section>
              <section className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">Time</p>
                  <p>{row.team_key ?? row.team_name ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Projeto</p>
                  <p>{row.project_name ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Quem</p>
                  <p>{row.actor_name ?? "sistema"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Milestone</p>
                  <p>{row.milestone_name ?? "—"}</p>
                </div>
              </section>
              <section>
                <button
                  type="button"
                  aria-expanded={techOpen}
                  onClick={() => setTechOpen((o) => !o)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <IconChevronDown className={cn("size-3.5 transition-transform", techOpen && "rotate-180")} />
                  Dados técnicos (JSON)
                </button>
                {techOpen && (
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{prettyJson}</pre>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function Webhooks() {
  const [issueId, setIssueId] = useState("");
  const [q, setQ] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [page, setPage] = useState(1);
  const [openRow, setOpenRow] = useState<WebhookEventRow | null>(null);

  const { data, isFetching, isLoading, isError, refetch } = useQuery({
    queryKey: ["webhooks", { issueId, q, teamFilter, page }],
    queryFn: () =>
      webhooksApi.list({
        issueId: issueId || undefined,
        q: q || undefined,
        teamId: teamFilter || undefined,
        page,
        pageSize: 25,
      }),
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const teamOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of data?.rows ?? []) {
      if (w.team_id) map.set(w.team_id, w.team_key ?? w.team_name ?? w.team_id);
    }
    return [...map.entries()];
  }, [data?.rows]);

  if (isLoading && !data) return <PageSkeleton rows={8} />;
  if (isError && !data) {
    return <PageError message="Falha ao carregar eventos do Linear." onRetry={() => refetch()} />;
  }

  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <div className="flex items-center gap-2">
          <IconWebhook className="size-5 text-primary" aria-hidden />
          <h1 className="text-xl font-semibold">Eventos do Linear</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Auditoria do que o Linear enviou ao orquestrador</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="wh-issue" className="text-xs font-medium text-muted-foreground">
            Issue
          </label>
          <Input
            id="wh-issue"
            placeholder="Ex.: ENG-123"
            className="w-48"
            value={issueId}
            onChange={(e) => {
              setIssueId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="wh-q" className="text-xs font-medium text-muted-foreground">
            Busca
          </label>
          <Input
            id="wh-q"
            placeholder="Resumo ou título…"
            className="w-64"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {teamOptions.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="wh-team" className="text-xs font-medium text-muted-foreground">
              Time
            </label>
            <select
              id="wh-team"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={teamFilter}
              onChange={(e) => {
                setTeamFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Todos</option>
              {teamOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quando</TableHead>
              <TableHead>Issue</TableHead>
              <TableHead>Mudança</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Projeto</TableHead>
              <TableHead>Quem</TableHead>
              <TableHead>Ciclo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows ?? []).map((w) => {
              const change = parseWebhookChange(w.raw_json, w.summary);
              return (
                <TableRow
                  key={w.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => setOpenRow(w)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenRow(w);
                    }
                  }}
                >
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(w.received_at)}</TableCell>
                  <TableCell>
                    <IssueIdentity identifier={w.issue_identifier} issueId={w.issue_id} title={w.issue_title} />
                  </TableCell>
                  <TableCell>
                    <WebhookChangeChips change={change} summaryFallback={w.summary} />
                  </TableCell>
                  <TableCell>{w.team_key ?? w.team_name ?? "—"}</TableCell>
                  <TableCell>{w.project_name ?? "—"}</TableCell>
                  <TableCell>{w.actor_name ?? "sistema"}</TableCell>
                  <TableCell>
                    {w.triggered_scheduler ? (
                      <Badge variant="success" className="font-normal">
                        Sim
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">Não</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {data?.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState title="Nenhum evento encontrado" description="Quando o Linear enviar webhooks, eles aparecem aqui." />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {data && data.total > 0 ? `Mostrando ${from}–${to} de ${data.total}` : "0 eventos"}
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

      <WebhookDetailSheet row={openRow} onOpenChange={(open) => !open && setOpenRow(null)} />
    </div>
  );
}
