import { useMemo, useState, type ReactNode } from "react";
import { IconRobot, IconWebhook } from "@tabler/icons-react";
import type { Run, WebhookEventRow } from "@/lib/api";
import { useSse } from "@/lib/useSse";
import { formatDateTime } from "@/lib/format";
import { RoleBadge } from "@/components/RoleBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { IssueIdentity } from "@/components/LinearIssueLink";
import { WebhookChangeChips } from "@/components/WebhookChangeChips";
import { parseWebhookChange } from "@/lib/webhookChange";
import { upsertById, removeById, mergeExtrasWithSnapshot } from "@/lib/listSync";
import { EmptyState } from "@/components/PageStates";

export type ActivityKindFilter = "runs" | "webhooks" | "both";

interface FeedItem {
  key: string;
  ts: number;
  kind: "run" | "webhook";
  content: ReactNode;
}

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

export function ActivityFeed({
  initialRuns,
  initialWebhooks,
  kindFilter = "both",
  onOpenRun,
}: {
  initialRuns: Run[];
  initialWebhooks: WebhookEventRow[];
  kindFilter?: ActivityKindFilter;
  onOpenRun?: (runId: string) => void;
}) {
  const [extraRuns, setExtraRuns] = useState<Run[]>([]);
  const [extraWebhooks, setExtraWebhooks] = useState<WebhookEventRow[]>([]);

  // Descarta extras que o poll já trouxe (evita duplicata).
  const orphanRuns = useMemo(() => mergeExtrasWithSnapshot(extraRuns, initialRuns), [extraRuns, initialRuns]);
  const orphanWebhooks = useMemo(
    () => mergeExtrasWithSnapshot(extraWebhooks, initialWebhooks),
    [extraWebhooks, initialWebhooks]
  );

  useSse<Record<string, unknown>>("/api/runs/stream", (eventName, payload) => {
    if (eventName === "run_started") {
      setExtraRuns((prev) => upsertById(prev, runFromSse(payload)));
    } else if (eventName === "run_finished") {
      const id = payload.runId as string;
      setExtraRuns((prev) => removeById(prev, id));
    }
  });

  useSse<Record<string, unknown>>("/api/webhooks/stream", (eventName, payload) => {
    if (eventName !== "webhook_received") return;
    const row: WebhookEventRow = {
      id: payload.id as number,
      received_at: Date.now(),
      entity_type: (payload.entityType as string) ?? "Issue",
      action: (payload.action as string) ?? null,
      issue_id: (payload.issueId as string) ?? null,
      issue_identifier: (payload.issueIdentifier as string) ?? null,
      issue_title: (payload.issueTitle as string) ?? null,
      team_id: null,
      team_key: null,
      team_name: null,
      project_id: null,
      project_name: null,
      milestone_id: null,
      milestone_name: null,
      actor_name: null,
      actor_type: null,
      summary: (payload.summary as string) ?? "Evento recebido",
      triggered_scheduler: 0,
      raw_json: "{}",
    };
    setExtraWebhooks((prev) => upsertById(prev, row));
  });

  const items = useMemo<FeedItem[]>(() => {
    const showRuns = kindFilter === "runs" || kindFilter === "both";
    const showWh = kindFilter === "webhooks" || kindFilter === "both";

    const runs = showRuns
      ? [...orphanRuns, ...initialRuns].map<FeedItem>((r) => ({
          key: `run-${r.id}`,
          ts: r.started_at,
          kind: "run",
          content: (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpenRun?.(r.id)}
            >
              <IconRobot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="sr-only">Execução</span>
              <StatusBadge status={r.status} />
              <RoleBadge role={r.role} />
              <IssueIdentity
                identifier={r.issue_identifier}
                issueId={r.issue_id}
                organizationKey={r.linear_organization_key}
                className="min-w-0"
              />
            </button>
          ),
        }))
      : [];

    const webhooks = showWh
      ? [...orphanWebhooks, ...initialWebhooks].map<FeedItem>((w) => {
          const change = parseWebhookChange(w.raw_json, w.summary);
          return {
            key: `wh-${w.id}`,
            ts: w.received_at,
            kind: "webhook" as const,
            content: (
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <IconWebhook className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="sr-only">Evento Linear</span>
                  <IssueIdentity identifier={w.issue_identifier} issueId={w.issue_id} title={w.issue_title} />
                </div>
                <WebhookChangeChips change={change} summaryFallback={w.summary} className="sm:ml-2" />
              </div>
            ),
          };
        })
      : [];

    // Dedupe por key (extras + snapshot podem overlap antes do mergeExtras)
    const map = new Map<string, FeedItem>();
    for (const item of [...runs, ...webhooks]) map.set(item.key, item);
    return [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, 40);
  }, [orphanRuns, orphanWebhooks, initialRuns, initialWebhooks, kindFilter, onOpenRun]);

  if (items.length === 0) {
    return (
      <EmptyState
        title="Sem atividade ainda"
        description={
          kindFilter === "runs"
            ? "Nenhuma execução recente."
            : kindFilter === "webhooks"
              ? "Nenhum evento do Linear recente."
              : "Quando houver execuções ou eventos do Linear, eles aparecem aqui."
        }
      />
    );
  }

  return (
    <ul className="flex flex-col divide-y">
      {items.map((item) => (
        <li key={item.key} className="flex items-start justify-between gap-4 py-2.5 text-sm">
          {item.content}
          <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(item.ts)}</span>
        </li>
      ))}
    </ul>
  );
}
