// Verifica a assinatura HMAC e extrai os dados relevantes do webhook do Linear.
// Multi-workspace: autenticação via resolveLinearContextFromWebhook (org id +
// secret da connection); fallback single-tenant quando a tabela está vazia.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { log } from "./logger";
import {
  resolveLinearContextFromWebhook,
  extractOrganizationId,
  type LinearContext,
} from "./db/linearConnections";

/** @deprecated Prefer authenticateWebhook — mantido p/ compat de testes. */
export function verifySignature(rawBody: string, signature: string, secret?: string): boolean {
  const s = secret ?? config.linear.webhookSecret;
  if (!s) return false;
  const expected = createHmac("sha256", s).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return expected === signature;
  }
}

/**
 * Autentica o webhook e devolve o LinearContext da connection.
 * null = rejeitar (401). Sem secret em lugar nenhum (legado), o resolver
 * ainda pode aceitar o fallback single-tenant.
 */
export function authenticateWebhook(rawBody: string, signatureHeader: string): LinearContext | null {
  return resolveLinearContextFromWebhook(rawBody, signatureHeader);
}

export { extractOrganizationId };
export type { LinearContext };

export interface WebhookEvent {
  issueId: string;
  stateName: string;
  type?: string;
  action?: string;
}

export function parseWebhook(raw: string): WebhookEvent | null {
  try {
    const body = JSON.parse(raw) as {
      type?: string;
      action?: string;
      data?: { id?: string; state?: { name?: string } };
      updatedFrom?: Record<string, unknown>;
    };
    if (body.type !== "Issue") return null;
    const issueId = body.data?.id;
    const stateName = body.data?.state?.name;
    if (!issueId || !stateName) return null;
    // Só aciona o scheduler quando o ESTADO mudou. Updates de label/assignee/
    // descrição trazem o stateName atual e, sem este filtro, onStatusChange
    // fechava runs em voo (ex.: merge em Pending Merge) por engano.
    if (body.action === "update") {
      const from = body.updatedFrom ?? {};
      if (!("state" in from) && !("stateId" in from)) return null;
    }
    return { issueId, stateName, type: body.type, action: body.action };
  } catch {
    return null;
  }
}

// ── Leitura rica p/ auditoria (dashboard) ────────────────────────────────────

interface RawActor {
  id?: string;
  name?: string;
  type?: string;
}

interface RawLabelRef {
  id?: string;
  name?: string;
}

interface RawIssueData {
  id?: string;
  identifier?: string;
  title?: string;
  state?: { id?: string; name?: string };
  team?: { id?: string; key?: string; name?: string };
  project?: { id?: string; name?: string };
  projectMilestone?: { id?: string; name?: string };
  labels?: RawLabelRef[];
  labelIds?: string[];
  description?: string;
}

interface RawCommentData {
  id?: string;
  body?: string;
  issueId?: string;
}

interface RawWebhookBody {
  type?: string;
  action?: string;
  actor?: RawActor;
  createdBy?: RawActor;
  organizationId?: string;
  organization?: { id?: string };
  data?: RawIssueData & RawCommentData;
  updatedFrom?: Record<string, unknown>;
  createdAt?: string;
}

export interface WebhookEnvelope {
  entityType: string;
  action?: string;
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  projectId?: string;
  projectName?: string;
  milestoneId?: string;
  milestoneName?: string;
  actorName?: string;
  actorType?: string;
  organizationId?: string;
  summary: string;
  raw: unknown;
}

function diffLabels(before: string[] | undefined, after: RawLabelRef[] | undefined): string {
  const beforeSet = new Set(before ?? []);
  const afterList = after ?? [];
  const added = afterList.filter((l) => l.id && !beforeSet.has(l.id)).map((l) => l.name ?? l.id);
  const afterIds = new Set(afterList.map((l) => l.id));
  const removed = [...beforeSet].filter((id) => !afterIds.has(id));
  const parts: string[] = [];
  if (added.length) parts.push(`label(s) adicionada(s): ${added.join(", ")}`);
  if (removed.length) parts.push(`label(s) removida(s) (${removed.length})`);
  return parts.join("; ");
}

function summarizeIssue(body: RawWebhookBody): string {
  const d = body.data ?? {};
  if (body.action === "create") return `Issue criada${d.title ? `: "${d.title}"` : ""}`;
  if (body.action === "remove") return "Issue removida";

  const from = body.updatedFrom ?? {};
  const bits: string[] = [];

  if ("state" in from || "stateId" in from) {
    const oldState = typeof from.state === "string" ? from.state : undefined;
    const newState = d.state?.name;
    bits.push(oldState && newState ? `Movida de ${oldState} para ${newState}` : "Estado alterado");
  }
  if ("labelIds" in from) {
    const labelDiff = diffLabels(from.labelIds as string[] | undefined, d.labels);
    if (labelDiff) bits.push(labelDiff);
  }
  if ("title" in from) {
    const oldTitle = typeof from.title === "string" ? from.title : undefined;
    bits.push(oldTitle ? `Título alterado de "${oldTitle}" para "${d.title ?? "?"}"` : "Título alterado");
  }
  if ("description" in from) bits.push("Descrição alterada");
  if ("projectId" in from) bits.push("Projeto alterado");
  if ("projectMilestoneId" in from) bits.push("Milestone alterado");

  return bits.length ? bits.join(" · ") : "Issue atualizada";
}

function summarize(body: RawWebhookBody): string {
  if (body.type === "Comment") {
    const actor = body.actor?.name ?? body.createdBy?.name ?? "alguém";
    return body.action === "create" ? `Comentário adicionado por ${actor}` : `Comentário ${body.action ?? "atualizado"}`;
  }
  if (body.type === "Issue") return summarizeIssue(body);
  return `${body.type ?? "Evento"} ${body.action ?? ""}`.trim();
}

export function parseWebhookEnvelope(raw: string): WebhookEnvelope | null {
  let body: RawWebhookBody;
  try {
    body = JSON.parse(raw) as RawWebhookBody;
  } catch {
    return null;
  }

  log.webhook.debug({ type: body.type, action: body.action, keys: Object.keys(body) }, "webhook raw envelope (shape validation)");

  const d = body.data ?? {};
  const actor = body.actor ?? body.createdBy;
  const isIssue = body.type === "Issue";
  const organizationId =
    (typeof body.organizationId === "string" && body.organizationId) ||
    (typeof body.organization?.id === "string" && body.organization.id) ||
    undefined;

  return {
    entityType: body.type ?? "unknown",
    action: body.action,
    issueId: isIssue ? d.id : d.issueId,
    issueIdentifier: d.identifier,
    issueTitle: d.title,
    teamId: d.team?.id,
    teamKey: d.team?.key,
    teamName: d.team?.name,
    projectId: d.project?.id,
    projectName: d.project?.name,
    milestoneId: d.projectMilestone?.id,
    milestoneName: d.projectMilestone?.name,
    actorName: actor?.name,
    actorType: actor?.type,
    organizationId,
    summary: summarize(body),
    raw: body,
  };
}
