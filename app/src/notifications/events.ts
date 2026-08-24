// Eventos v1 (§8.1): issue→Blocked, issue→Pending Merge, run failed, circuit
// breaker, budget estourado, timeout/reclaim de seat. Payload: título curto +
// link da issue no Linear (quando houver) + agente/papel. `notify()` é
// fire-and-forget de propósito — os call sites (scheduler.ts, dispatch.ts)
// nunca esperam a entrega: uma notificação lenta/falha NUNCA pode atrasar o
// pipeline.
import { log, errFields } from "../logger";
import { linearFor } from "../linear";
import { resolveContextById, type LinearContext } from "../db/linearConnections";
import { channelsForEvent, type NotificationEvent } from "./store";
import { deliver, type NotificationPayload } from "./send";

interface EventData {
  issueId?: string;
  role?: string;
  harnessId?: string;
  runId?: string;
  error?: string;
  attempts?: number;
  maxAttempts?: number;
  phase?: string;
  spend?: number;
  limit?: number;
  window?: string;
  action?: string;
  /** Epoch ms de quando o harness volta a ficar disponível (harness_quota_exceeded). */
  resetAt?: number;
  /** Connection do evento — sem isso o link abre no workspace default (errado em multi-org). */
  linearCtx?: LinearContext;
  connectionId?: string;
}

async function issueLink(
  issueId: string | undefined,
  ctx: LinearContext | null
): Promise<{ label: string; url: string } | undefined> {
  if (!issueId || !ctx) return undefined;
  try {
    // A URL do Linear usa o IDENTIFIER (ex.: ENG-123), não o UUID que circula
    // internamente — resolver aqui garante link clicável (critério §8.4).
    const lin = linearFor(ctx);
    const [urlKey, issue] = await Promise.all([lin.organizationUrlKey(), lin.getIssue(issueId)]);
    return { label: `Ver ${issue.identifier} no Linear`, url: `https://linear.app/${urlKey}/issue/${issue.identifier}` };
  } catch {
    return undefined;
  }
}

function resolveNotifyCtx(data: EventData): LinearContext | null {
  if (data.linearCtx) return data.linearCtx;
  if (data.connectionId) return resolveContextById(data.connectionId);
  return null;
}

async function buildPayload(event: NotificationEvent, data: EventData): Promise<NotificationPayload> {
  const link = await issueLink(data.issueId, resolveNotifyCtx(data));
  const links = link ? [link] : [];
  switch (event) {
    case "issue_blocked":
      return { title: "🛑 Issue movida para Blocked", body: "Precisa de decisão humana para continuar.", links };
    case "issue_pending_merge":
      return { title: "🔀 Issue aguardando merge", body: "PR aprovada, esperando o gate de merge.", links };
    case "run_failed":
      return {
        title: `⚠️ Run falhou (${data.role ?? "?"} · ${data.harnessId ?? "?"})`,
        body: data.error ?? "erro desconhecido",
        links,
      };
    case "circuit_breaker":
      return {
        title: "🛑 Circuit breaker acionado",
        body: `${data.attempts}/${data.maxAttempts} ciclos de retrabalho sem aprovação — pausado para decisão humana.`,
        links,
      };
    case "budget_exceeded":
      return {
        title: `💸 Budget estourado: ${data.harnessId}`,
        body: `${data.spend ?? "?"} / ${data.limit ?? "?"} (${data.window ?? "?"}) — ação: ${data.action ?? "avisar"}.`,
      };
    case "reclaim_timeout":
      return {
        title: `⏱️ Seat reclamado por inatividade (${data.phase ?? "?"})`,
        body: "O agente pode ter morrido/travado — issue devolvida à fila.",
        links,
      };
    case "harness_quota_exceeded": {
      const resetLabel = data.resetAt ? new Date(data.resetAt).toLocaleString("pt-BR") : "horário desconhecido";
      return {
        title: `⏳ Quota do provedor esgotada (${data.harnessId ?? "?"})`,
        body: `${data.error ?? "limite atingido"}\n\nDispatches deste harness ficam em espera até ${resetLabel}. A issue foi devolvida à fila automaticamente.`,
        links,
      };
    }
  }
}

export function notify(event: NotificationEvent, data: EventData): void {
  void (async () => {
    try {
      const channels = channelsForEvent(event);
      if (channels.length === 0) return;
      const payload = await buildPayload(event, data);
      await Promise.all(channels.map(({ channel, config }) => deliver(channel, config, payload)));
    } catch (e) {
      log.dashboard.warn({ event, ...errFields(e) }, "notify() failed (best-effort)");
    }
  })();
}
