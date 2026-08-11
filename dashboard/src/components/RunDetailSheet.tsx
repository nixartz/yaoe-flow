import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconSend,
  IconMessage,
  IconBrain,
  IconTool,
  IconListCheck,
  IconChevronDown,
  IconGitBranch,
  IconPlug,
  IconPlayerStopFilled,
  IconLoader2,
  IconCheck,
  IconFileText,
  IconSearch,
  IconTerminal2,
  IconPencil,
} from "@tabler/icons-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RoleBadge } from "@/components/RoleBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { UsageBadge } from "@/components/UsageBadge";
import { IssueIdentity } from "@/components/LinearIssueLink";
import { CopyableId } from "@/components/CopyableId";
import { runsApi, recipesApi, ApiError, type Run, type RunEvent } from "@/lib/api";
import { useSse } from "@/lib/useSse";
import { formatDateTime, formatDuration, harnessLabel, operationLabel, runModelBadgeLabel } from "@/lib/format";
import { linearConnectionLabel } from "@/lib/linearConnectionLabel";
import { groupEvents, type TimelineSegment, type ToolItem } from "@/lib/groupEvents";
import type { ToolKind } from "@/lib/toolPresent";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "@/components/MarkdownMessage";

function toolIcon(kind: ToolKind) {
  switch (kind) {
    case "read":
      return IconFileText;
    case "edit":
    case "write":
      return IconPencil;
    case "search":
      return IconSearch;
    case "execute":
      return IconTerminal2;
    case "think":
      return IconBrain;
    case "mcp":
      return IconPlug;
    default:
      return IconTool;
  }
}

function toolStatusLabel(status: string | null | undefined, live: boolean): string {
  if (live) return "em andamento";
  if (!status) return "concluído";
  const s = status.toLowerCase();
  if (s === "failed" || s === "error") return "falhou";
  if (s.includes("reject") || s.includes("cancel") || s.includes("blocked")) return "negado";
  if (s.startsWith("permission:")) return "autorizado";
  if (s === "completed" || s === "success" || s === "done" || s === "cancelled") return "concluído";
  // Status residual de "pending" em run já finalizado → concluído
  return "concluído";
}

function BodyCard({ label, text, isCode }: { label?: string; text: string; isCode?: boolean }) {
  return (
    <div className="mt-1.5 overflow-hidden rounded-md border bg-muted/40">
      {label && (
        <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
          {label}
        </div>
      )}
      <pre
        className={cn(
          "max-h-56 overflow-auto px-2.5 py-2 text-xs leading-relaxed",
          isCode ? "font-mono whitespace-pre" : "whitespace-pre-wrap font-sans"
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tool.presentation.kind);
  const failed =
    (tool.toolStatus ?? "").toLowerCase() === "failed" ||
    (tool.toolStatus ?? "").toLowerCase() === "error" ||
    (tool.toolStatus ?? "").toLowerCase().includes("reject") ||
    (tool.toolStatus ?? "").toLowerCase().includes("blocked");
  const sections = tool.presentation.sections?.length
    ? tool.presentation.sections
    : tool.presentation.bodyText
      ? [{ label: tool.presentation.bodyLabel ?? "Detalhe", text: tool.presentation.bodyText, isCode: tool.presentation.bodyIsCode }]
      : [];
  const hasBody = sections.length > 0;

  return (
    <div className="pl-1">
      <button
        type="button"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => hasBody && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !hasBody && "cursor-default"
        )}
      >
        {hasBody ? (
          <IconChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        {tool.live ? (
          <IconLoader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
        ) : failed ? (
          <Icon className="size-3.5 shrink-0 text-destructive" aria-hidden />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{tool.presentation.summary}</span>
        <Badge
          variant={failed ? "destructive" : tool.live ? "default" : "secondary"}
          className="shrink-0 font-normal"
        >
          {toolStatusLabel(tool.toolStatus, tool.live)}
        </Badge>
      </button>
      {open && hasBody && (
        <div className="ml-6 mb-1 flex flex-col gap-1">
          {sections.map((s) => (
            <BodyCard key={`${s.label}-${s.text.slice(0, 24)}`} label={s.label} text={s.text} isCode={s.isCode} />
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineSegmentView({ segment }: { segment: TimelineSegment }) {
  if (segment.type === "user_message" || segment.type === "agent_message") {
    const isUser = segment.type === "user_message";
    return (
      <div className="flex gap-3 py-1">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full border">
          {isUser ? <IconSend className="size-3 text-muted-foreground" /> : <IconMessage className="size-3 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{isUser ? "Enviado" : "Resposta"}</p>
          {segment.text &&
            (isUser ? (
              <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">{segment.text}</p>
            ) : (
              <MarkdownMessage className="mt-0.5" text={segment.text} />
            ))}
        </div>
      </div>
    );
  }

  if (segment.type === "thinking") {
    return <ThinkingBlock segment={segment} />;
  }

  if (segment.type === "tool_group") {
    return <ToolGroupBlock segment={segment} />;
  }

  // plan / other
  return <MiscBlock segment={segment as Extract<TimelineSegment, { type: "plan" | "other" }>} />;
}

function ThinkingBlock({ segment }: { segment: Extract<TimelineSegment, { type: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <IconChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        <IconBrain className="size-3.5" aria-hidden />
        <span>
          {segment.durationLabel === "brevemente"
            ? "Pensou brevemente"
            : <>Pensou por <span className="text-muted-foreground/80">{segment.durationLabel}</span></>}
        </span>
      </button>
      {open && segment.text && (
        <p className="mt-1 ml-6 whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground">{segment.text}</p>
      )}
    </div>
  );
}

function ToolGroupBlock({ segment }: { segment: Extract<TimelineSegment, { type: "tool_group" }> }) {
  // Grupos (e tools únicos) começam colapsados pra não poluir a timeline
  const [open, setOpen] = useState(false);
  const single = segment.tools.length === 1;
  const only = single ? segment.tools[0] : null;
  const failed =
    only != null &&
    ((only.toolStatus ?? "").toLowerCase() === "failed" ||
      (only.toolStatus ?? "").toLowerCase() === "error" ||
      (only.toolStatus ?? "").toLowerCase().includes("reject") ||
      (only.toolStatus ?? "").toLowerCase().includes("blocked"));

  return (
    <div className={cn("py-0.5", segment.anyLive && "rounded-md border border-primary/25 bg-primary/5 px-2 py-1")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-left text-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <IconChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        {segment.anyLive ? (
          <IconLoader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
        ) : (
          <IconCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">
          {single && only ? only.presentation.summary : segment.summary}
        </span>
        {!single && (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">({segment.tools.length})</span>
        )}
        {single && only && (
          <Badge
            variant={failed ? "destructive" : segment.anyLive ? "default" : "secondary"}
            className="shrink-0 font-normal"
          >
            {toolStatusLabel(only.toolStatus, only.live)}
          </Badge>
        )}
      </button>
      {open && (
        <div className={cn("mt-1 flex flex-col", !single && "ml-2 border-l border-border/60 pl-2")}>
          {single && only ? (
            <ToolSections tool={only} />
          ) : (
            segment.tools.map((t) => <ToolRow key={t.key} tool={t} />)
          )}
        </div>
      )}
    </div>
  );
}

function ToolSections({ tool }: { tool: ToolItem }) {
  const sections = tool.presentation.sections?.length
    ? tool.presentation.sections
    : tool.presentation.bodyText
      ? [{ label: tool.presentation.bodyLabel ?? "Detalhe", text: tool.presentation.bodyText, isCode: tool.presentation.bodyIsCode }]
      : [];
  if (sections.length === 0) {
    return <p className="ml-6 text-xs text-muted-foreground">Sem detalhes adicionais.</p>;
  }
  return (
    <div className="ml-6 mb-1 flex flex-col gap-1">
      {sections.map((s) => (
        <BodyCard key={`${s.label}-${s.text.slice(0, 24)}`} label={s.label} text={s.text} isCode={s.isCode} />
      ))}
    </div>
  );
}

function MiscBlock({ segment }: { segment: Extract<TimelineSegment, { type: "plan" | "other" }> }) {
  const [open, setOpen] = useState(false);
  const text =
    segment.text ||
    (segment.payload != null
      ? typeof segment.payload === "string"
        ? segment.payload
        : JSON.stringify(segment.payload, null, 2)
      : undefined);
  return (
    <div className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <IconChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {segment.type === "plan" ? <IconListCheck className="size-3.5" /> : <IconGitBranch className="size-3.5" />}
        <span className="font-medium text-foreground">{segment.label}</span>
      </button>
      {open && text && <BodyCard text={text} isCode={text.trimStart().startsWith("{") || text.includes("\n")} />}
    </div>
  );
}

// §6.4: a aba Recipe lê DO SNAPSHOT do run (resolved_config_json) — um run
// antigo sempre mostra o que REALMENTE rodou, mesmo que a SOUL/config do
// agente tenha mudado depois. Runs anteriores à Fase 1 (sem snapshot) caem no
// fallback legado que lê o .yaml atual em disco (RecipeTab abaixo).
interface ResolvedSnapshot {
  harnessId?: string;
  model?: string | null;
  provider?: string;
  settings?: Record<string, unknown>;
  mcpServers?: Array<{ name?: string; type?: string; uri?: string }>;
}

function WorkspacePathRow({ workspacePath }: { workspacePath: string | null | undefined }) {
  if (!workspacePath) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        Workspace no disco do daemon (só informativo — a dashboard pode estar em outra máquina)
      </p>
      <CopyableId value={workspacePath} kind="path" truncate />
    </div>
  );
}

function SnapshotTab({ run, workspacePath }: { run: Run; workspacePath: string | null | undefined }) {
  let snapshot: ResolvedSnapshot | null = null;
  try {
    snapshot = run.resolved_config_json ? (JSON.parse(run.resolved_config_json) as ResolvedSnapshot) : null;
  } catch {
    snapshot = null;
  }
  let externalRefs: Record<string, unknown> | null = null;
  try {
    externalRefs = run.external_refs_json ? (JSON.parse(run.external_refs_json) as Record<string, unknown>) : null;
  } catch {
    externalRefs = null;
  }

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <WorkspacePathRow workspacePath={workspacePath} />
        <RecipeTab role={run.role} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      <WorkspacePathRow workspacePath={workspacePath} />
      <div>
        <p className="text-xs font-medium text-muted-foreground">Harness / Provider / Model (snapshot do dispatch)</p>
        <p>
          {snapshot.harnessId ?? run.harness_id ?? "—"} · {snapshot.provider ?? "—"} · {snapshot.model ?? "—"}
        </p>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">MCP servers (deste run)</p>
        <div className="flex flex-wrap gap-1.5">
          {(snapshot.mcpServers ?? []).map((m, i) => (
            <Badge key={`${m.name}-${i}`} variant="outline" className="gap-1">
              <IconPlug className="size-3" />
              {m.name ?? "?"} <span className="text-muted-foreground">({m.type ?? "?"})</span>
            </Badge>
          ))}
          {(!snapshot.mcpServers || snapshot.mcpServers.length === 0) && (
            <span className="text-xs text-muted-foreground">nenhum</span>
          )}
        </div>
      </div>
      {snapshot.settings && Object.keys(snapshot.settings).length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Settings do harness (segredos omitidos)</p>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(snapshot.settings, null, 2)}</pre>
        </div>
      )}
      {(run.external_session_id || externalRefs) && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Referências externas (§7.5 — achar a conversa na ferramenta)</p>
          {run.external_session_id && (
            <p className="font-mono text-xs">session: {run.external_session_id}</p>
          )}
          {externalRefs && (
            <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(externalRefs, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// Fallback legado (runs sem snapshot, anteriores à Fase 1): lê o .yaml ATUAL
// em disco — pode divergir do que o run realmente usou.
function RecipeTab({ role }: { role: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["recipe", role],
    queryFn: () => recipesApi.get(role),
    staleTime: 60_000,
  });
  const [showInstructions, setShowInstructions] = useState(false);

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando recipe…</p>;
  if (isError) {
    return (
      <p className="text-sm text-muted-foreground">
        {(error as Error)?.message?.includes("goose")
          ? "Detalhes de recipe só existem com o backend Goose (AGENT_BACKEND=goose)."
          : "Recipe não encontrado para este papel."}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <p className="text-xs font-medium text-muted-foreground">Título</p>
        <p>{data.title ?? "—"}</p>
      </div>
      {data.description && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Descrição</p>
          <p className="text-muted-foreground">{data.description}</p>
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-muted-foreground">Provider / Model</p>
        <p>{data.settings?.goose_provider ?? "—"} · {data.settings?.goose_model ?? "—"}</p>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Extensions (MCPs / tools ativos)</p>
        <div className="flex flex-wrap gap-1.5">
          {(data.extensions ?? []).map((ext, i) => (
            <Badge key={`${ext.name}-${i}`} variant="outline" className="gap-1">
              <IconPlug className="size-3" />
              {ext.name} <span className="text-muted-foreground">({ext.type})</span>
            </Badge>
          ))}
          {(!data.extensions || data.extensions.length === 0) && (
            <span className="text-xs text-muted-foreground">nenhuma</span>
          )}
        </div>
      </div>
      <div>
        <button
          onClick={() => setShowInstructions((o) => !o)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <IconChevronDown className={cn("size-3 transition-transform", showInstructions && "rotate-180")} />
          {showInstructions ? "ocultar" : "ver"} instructions completas (SOUL + protocolo)
        </button>
        {showInstructions && (
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed">
            {data.instructions ?? "—"}
          </pre>
        )}
      </div>
    </div>
  );
}

// Não existe "pausa" real pra um processo de agente em stream (não dá pra
// congelar e retomar a geração no meio) — "pausar" e "encerrar" são a MESMA
// ação técnica no backend (mata o processo agora, move a issue pra Blocked).
// A diferença é só o motivo registrado no comentário. Retomar reusa o fluxo
// que já existe: revisar o comentário e mover a issue pra Reopened.
function StopRunControl({ runId, onStopped }: { runId: string; onStopped: (warning?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (r: string) => runsApi.stop(runId, r),
    onSuccess: (data) => {
      setOpen(false);
      setReason("");
      qc.invalidateQueries({ queryKey: ["run", runId] });
      onStopped(data.warning);
    },
  });

  if (!open) {
    return (
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <IconPlayerStopFilled className="size-3.5" />
        Pausar / Encerrar
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-xs text-muted-foreground">
        Encerra o agente agora e move a issue para <strong>Blocked</strong> com um comentário explicando o motivo.
        Não existe "pausa" — pra retomar, revise o comentário na issue e mova de volta para <strong>Reopened</strong>.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo (ex.: agente fugindo do escopo — revisão humana solicitada)"
        rows={2}
        className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      {mutation.isError && (
        <p className="text-xs text-destructive">
          {mutation.error instanceof ApiError ? mutation.error.message : "Falha ao encerrar o run."}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(reason)}>
          {mutation.isPending ? "Encerrando…" : "Confirmar encerramento"}
        </Button>
        <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

const NEAR_BOTTOM_PX = 80;
/** Eventos que atualizam o badge/header mas não aparecem na timeline. */
const SILENT_TIMELINE_KINDS = new Set(["usage_update", "session_info_update"]);

export function RunDetailSheet({ runId, onOpenChange }: { runId: string | null; onOpenChange: (open: boolean) => void }) {
  const { data } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => runsApi.get(runId as string),
    enabled: !!runId,
  });

  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const seq = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [pendingNew, setPendingNew] = useState(0);

  // Reset COMPLETO ao trocar de run — senão o estado local (run/events/seq) da
  // sessão anterior vazava pro sheet da próxima (mesmo modal lateral aberto).
  useEffect(() => {
    setStopNotice(null);
    stickToBottom.current = true;
    setPendingNew(0);
    setRun(null);
    setEvents([]);
    seq.current = 0;
  }, [runId]);

  useEffect(() => {
    if (!data || !runId) return;
    // Resposta stale de outro run (race ao clicar rápido entre cards).
    if (data.run.id !== runId) return;
    setRun(data.run);
    // Não resetar stick/pending em todo refetch do react-query (ex.: foco da
    // janela). Seq só avança; se o fetch trouxe eventos mais novos que o SSE
    // ainda não entregou, mescla pelo seq — só dentro do MESMO run.
    setEvents((prev) => {
      const sameRun = prev.length === 0 || prev.every((e) => e.run_id === runId);
      if (!sameRun) return data.events;
      const serverMax = data.events.at(-1)?.seq ?? 0;
      const localMax = prev.at(-1)?.seq ?? 0;
      if (localMax > serverMax) return prev;
      return data.events;
    });
    seq.current = Math.max(seq.current, data.events.at(-1)?.seq ?? 0);
  }, [data, runId]);

  const isLive = run?.status === "running" || run?.status === "dispatched";
  useSse<Record<string, unknown>>(isLive ? "/api/runs/stream" : null, (eventName, payload) => {
    if (payload.runId !== runId) return;
    if (eventName === "run_event") {
      const seqNum = payload.seq as number;
      if (seqNum <= seq.current) return;
      seq.current = seqNum;
      setEvents((prev) => [
        ...prev,
        {
          id: seqNum,
          run_id: runId as string,
          seq: seqNum,
          ts: payload.ts as number,
          kind: payload.kind as string,
          text: (payload.text as string) ?? null,
          tool_name: (payload.toolName as string) ?? null,
          tool_status: (payload.toolStatus as string) ?? null,
          // `payload.payload` é o objeto ACP completo (rawOutput/content
          // inclusos quando a tool termina) — `payload` sozinho é só o
          // envelope do broadcast (kind/toolName/toolStatus).
          payload_json: JSON.stringify(payload.payload ?? payload),
        },
      ]);
      const kind = payload.kind as string;
      if (!stickToBottom.current && !SILENT_TIMELINE_KINDS.has(kind)) {
        setPendingNew((n) => n + 1);
      }
    } else if (eventName === "run_finished") {
      setRun((r) =>
        r && r.id === runId
          ? { ...r, status: payload.status as Run["status"], ended_at: payload.endedAt as number, duration_ms: payload.durationMs as number }
          : r
      );
    } else if (eventName === "run_updated" && payload.usage) {
      const u = payload.usage as Partial<Run>;
      setRun((r) => (r && r.id === runId ? { ...r, ...u } : r));
    }
  });

  const runFinished = run?.status !== "running" && run?.status !== "dispatched";
  const blocks = useMemo(() => groupEvents(events, !!runFinished), [events, runFinished]);

  // Stick-to-bottom: se o usuário está no fim, acompanha novos eventos.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const onTimelineScroll = () => {
    const el = timelineRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= NEAR_BOTTOM_PX;
    stickToBottom.current = atBottom;
    if (atBottom) setPendingNew(0);
  };

  const jumpToLatest = () => {
    const el = timelineRef.current;
    stickToBottom.current = true;
    setPendingNew(0);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const showLoading = !run;

  return (
    <Sheet open={!!runId} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-2xl" key={runId ?? "closed"}>
        {showLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Carregando…</div>
        ) : (
          <>
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={run.status} />
                <RoleBadge role={run.role} />
                <Badge variant="outline">{harnessLabel(run.harness_id ?? run.backend)}</Badge>
                {(() => {
                  const modelLabel = runModelBadgeLabel(run);
                  return modelLabel ? (
                    <Badge variant="secondary" className="font-normal">
                      {modelLabel}
                    </Badge>
                  ) : null;
                })()}
                {(() => {
                  const label = linearConnectionLabel(run);
                  return label ? (
                    <Badge variant="secondary" className="gap-1 font-normal">
                      <IconPlug className="size-3" />
                      {label}
                    </Badge>
                  ) : null;
                })()}
              </div>
              <SheetTitle>
                <IssueIdentity
                  identifier={run.issue_identifier}
                  issueId={run.issue_id}
                  organizationKey={run.linear_organization_key}
                  showIssueUuid={Boolean(run.issue_id)}
                />
              </SheetTitle>
              <SheetDescription>
                {operationLabel(run.operation)}
                {run.mode ? ` · ${run.mode}` : ""} · {formatDateTime(run.started_at)} ·{" "}
                {formatDuration(run.duration_ms ?? (run.status === "running" ? Date.now() - run.started_at : null))}
                {run.error_message && <span className="ml-2 text-destructive">· {run.error_message}</span>}
              </SheetDescription>
              <div className="mt-1">
                <UsageBadge run={run} />
              </div>
              <div className="mt-2 flex flex-col gap-1">
                <CopyableId value={run.id} kind="run" />
                {run.linear_connection_id && (
                  <CopyableId value={run.linear_connection_id} kind="connection" />
                )}
                {run.external_session_id && (
                  <CopyableId value={run.external_session_id} kind="session" />
                )}
              </div>
              {/* §7.7: Pausar/Encerrar vale pra todo harness com processo local
                  matável (capabilities.kill) — hoje, todos exceto o Hermes. */}
              {run.status === "running" && run.backend !== "hermes" && (
                <div className="mt-2">
                  <StopRunControl
                    runId={run.id}
                    onStopped={(warning) => {
                      setRun((r) => (r ? { ...r, status: "cancelled" } : r));
                      setStopNotice(warning ?? null);
                    }}
                  />
                </div>
              )}
              {stopNotice && <p className="mt-2 max-w-md text-xs text-muted-foreground">{stopNotice}</p>}
            </SheetHeader>
            <Tabs defaultValue="timeline" className="flex min-h-0 flex-1 flex-col px-4">
              <TabsList>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
                <TabsTrigger value="recipe">Configuração</TabsTrigger>
              </TabsList>
              <TabsContent value="timeline" className="relative min-h-0 flex-1">
                <div
                  ref={timelineRef}
                  onScroll={onTimelineScroll}
                  className="h-full overflow-y-auto py-2"
                >
                  {blocks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Sem etapas registradas para este run (alguns backends, como Hermes, não reportam o passo a passo).
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {blocks.map((b) => (
                        <TimelineSegmentView key={b.key} segment={b} />
                      ))}
                    </div>
                  )}
                </div>
                {pendingNew > 0 && (
                  <button
                    type="button"
                    onClick={jumpToLatest}
                    className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur hover:bg-accent"
                  >
                    <IconChevronDown className="size-3.5" />
                    {pendingNew === 1 ? "1 novo evento" : `${pendingNew} novos eventos`}
                  </button>
                )}
              </TabsContent>
              <TabsContent value="recipe" className="min-h-0 flex-1">
                <ScrollArea className="h-full py-2">
                  <SnapshotTab run={run} workspacePath={data?.run.id === run.id ? data?.workspacePath : null} />
                </ScrollArea>
              </TabsContent>
            </Tabs>
            <Separator />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
