// Extrai diff estruturado de um webhook Linear a partir do raw_json
// (mesmo shape que parseWebhookEnvelope no backend) — sem mudar a API.

export interface WebhookChange {
  entityType: string;
  action: string | null;
  stateFrom: string | null;
  stateTo: string | null;
  labelsAdded: string[];
  labelsRemoved: string[];
  titleFrom: string | null;
  titleTo: string | null;
  titleChanged: boolean;
  descriptionChanged: boolean;
  projectChanged: boolean;
  milestoneChanged: boolean;
  /** true se há algo além do summary genérico pra mostrar em chips */
  hasStructuredDiff: boolean;
}

interface RawLabelRef {
  id?: string;
  name?: string;
}

interface RawBody {
  type?: string;
  action?: string;
  data?: {
    state?: { name?: string };
    labels?: RawLabelRef[];
    title?: string;
  };
  updatedFrom?: Record<string, unknown>;
}

function safeParse(raw: string | null | undefined): RawBody | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RawBody;
  } catch {
    return null;
  }
}

function labelDiff(
  beforeIds: string[] | undefined,
  after: RawLabelRef[] | undefined
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(beforeIds ?? []);
  const afterList = after ?? [];
  const added = afterList.filter((l) => l.id && !beforeSet.has(l.id)).map((l) => l.name ?? l.id!);
  const afterIds = new Set(afterList.map((l) => l.id).filter(Boolean) as string[]);
  const removedCount = [...beforeSet].filter((id) => !afterIds.has(id)).length;
  return {
    added,
    removed: removedCount > 0 ? [`${removedCount} removida(s)`] : [],
  };
}

export function parseWebhookChange(rawJson: string | null | undefined, summaryFallback?: string): WebhookChange {
  const empty: WebhookChange = {
    entityType: "unknown",
    action: null,
    stateFrom: null,
    stateTo: null,
    labelsAdded: [],
    labelsRemoved: [],
    titleFrom: null,
    titleTo: null,
    titleChanged: false,
    descriptionChanged: false,
    projectChanged: false,
    milestoneChanged: false,
    hasStructuredDiff: false,
  };

  const body = safeParse(rawJson);
  if (!body) {
    // Tenta extrair "Movida de X para Y" do summary textual
    if (summaryFallback) {
      const m = summaryFallback.match(/Movida de (.+?) para (.+?)(?:\s·|$)/);
      if (m) {
        return {
          ...empty,
          stateFrom: m[1],
          stateTo: m[2],
          hasStructuredDiff: true,
        };
      }
    }
    return empty;
  }

  const from = body.updatedFrom ?? {};
  const d = body.data ?? {};
  let stateFrom: string | null = null;
  let stateTo: string | null = null;
  if ("state" in from || "stateId" in from) {
    stateFrom = typeof from.state === "string" ? from.state : null;
    stateTo = d.state?.name ?? null;
  }

  let labelsAdded: string[] = [];
  let labelsRemoved: string[] = [];
  if ("labelIds" in from) {
    const diff = labelDiff(from.labelIds as string[] | undefined, d.labels);
    labelsAdded = diff.added;
    labelsRemoved = diff.removed;
  }

  const titleChanged = "title" in from;
  const titleFrom = titleChanged && typeof from.title === "string" ? from.title : null;
  const titleTo = titleChanged ? (d.title ?? null) : null;

  const descriptionChanged = "description" in from;
  const projectChanged = "projectId" in from;
  const milestoneChanged = "projectMilestoneId" in from;

  const hasStructuredDiff = !!(
    stateFrom ||
    stateTo ||
    labelsAdded.length ||
    labelsRemoved.length ||
    titleChanged ||
    descriptionChanged ||
    projectChanged ||
    milestoneChanged
  );

  return {
    entityType: body.type ?? "unknown",
    action: body.action ?? null,
    stateFrom,
    stateTo,
    labelsAdded,
    labelsRemoved,
    titleFrom,
    titleTo,
    titleChanged,
    descriptionChanged,
    projectChanged,
    milestoneChanged,
    hasStructuredDiff,
  };
}

/** Labels amigáveis pra entity_type / action. */
export function entityTypeLabel(type: string): string {
  const map: Record<string, string> = {
    Issue: "Issue",
    Comment: "Comentário",
    Project: "Projeto",
    Cycle: "Cycle",
  };
  return map[type] ?? type;
}

export function actionLabel(action: string | null): string {
  if (!action) return "";
  const map: Record<string, string> = {
    create: "criada",
    update: "atualizada",
    remove: "removida",
  };
  return map[action] ?? action;
}
