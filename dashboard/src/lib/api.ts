// Cliente HTTP fino para a API da dashboard. Sempre credentials:"include" (cookie
// de sessão httpOnly) — sem token manual no client.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ── Auth & usuários ──
export interface SafeUser {
  id: string;
  name: string;
  email: string | null;
  username: string;
  status: "active" | "inactive";
  type: "administrator";
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}
export interface Me {
  authenticated: boolean;
  user?: SafeUser;
}
export const authApi = {
  me: () => request<Me>("/auth/me"),
  login: (username: string, password: string) =>
    request<{ ok: boolean; user: SafeUser }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  // First-access (§5.3): formulário de setup que só existe enquanto users está vazia.
  setupStatus: () => request<{ needsSetup: boolean }>("/auth/setup-status"),
  setup: (input: { name: string; email?: string; username: string; password: string }) =>
    request<{ ok: boolean; user: SafeUser }>("/auth/setup", { method: "POST", body: JSON.stringify(input) }),
};

export const usersApi = {
  list: () => request<{ users: SafeUser[] }>("/users"),
  create: (input: { name: string; email?: string | null; username: string; password: string }) =>
    request<{ ok: boolean; user: SafeUser }>("/users", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: { name?: string; email?: string | null; status?: "active" | "inactive"; password?: string }) =>
    request<{ ok: boolean; user: SafeUser }>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/profile/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
};

// ── Settings (tela Config, Fase 0) ──
export type SettingSource = "env" | "db" | "default";
export type SettingScope = "bootstrap" | "config" | "harness" | "agent" | "deprecated";
export interface SettingEntry {
  key: string;
  group: string;
  type: "string" | "number" | "boolean" | "enum" | "json" | "duration_ms";
  enumValues?: string[];
  description: string;
  secret: boolean;
  scope: SettingScope;
  requiresRestart: boolean;
  editable: boolean;
  linearValidatable?: "state" | "label";
  value: string;
  defaultValue: string;
  source: SettingSource;
}
export interface SettingGroup {
  group: string;
  entries: SettingEntry[];
}
export interface LinearValidationResult {
  key: string;
  value: string;
  kind: "state" | "label";
  ok: boolean;
}
export const settingsApi = {
  get: () => request<{ groups: SettingGroup[] }>("/settings"),
  update: (key: string, value: string) =>
    request<{ ok: boolean; groups: SettingGroup[] }>(`/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
  reset: (key: string) => request<{ ok: boolean; groups: SettingGroup[] }>(`/settings/${key}`, { method: "DELETE" }),
  validateLinear: () =>
    request<{ ok: boolean; results: LinearValidationResult[]; teamStates: string[]; teamLabels: string[] }>(
      "/settings/validate-linear",
      { method: "POST" }
    ),
};

// ── Linear (link run→issue) ──
export const linearApi = {
  workspace: () => request<{ urlKey: string | null }>("/linear/workspace"),
};

// ── Runs ──
export type RunStatus = "running" | "completed" | "failed" | "dispatched" | "timeout" | "cancelled";
// Historicamente só "goose"|"hermes"; desde a Fase 2 (multi-harness) é
// qualquer HarnessId — ver app/src/agent/harness/types.ts.
export type RunBackend = string;

export interface Run {
  id: string;
  backend: RunBackend;
  operation: string;
  role: string;
  issue_id: string | null;
  issue_identifier: string | null;
  mode: string | null;
  status: RunStatus;
  provider: string | null;
  model: string | null;
  stop_reason: string | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  cost_input_usd: number | null;
  cost_output_usd: number | null;
  openrouter_session_id: string | null;
  goose_session_id: string | null;
  /** goose_accumulated | prompt_response_fallback | openrouter_reconciled */
  usage_source: string | null;
  usage_reconciled_at: number | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  // Multi-harness (Fases 1–2): snapshot auditável + refs externas.
  agent_id: string | null;
  agent_version_id: string | null;
  harness_id: string | null;
  /** Snapshot efetivo do dispatch (§6.4) — modelo/MCPs/settings SEM segredos. */
  resolved_config_json: string | null;
  /** api | subscription | unknown (§7.5) — "subscription" nunca inventa USD. */
  cost_source: string | null;
  external_session_id: string | null;
  external_refs_json: string | null;
  /** Multi-Linear: id da connection que autenticou/despachou o run. */
  linear_connection_id: string | null;
  /** Nome amigável via JOIN (null se connection apagada ou run legado). */
  linear_connection_name: string | null;
  /** urlKey da org Linear (JOIN) — link issue→workspace certo. */
  linear_organization_key: string | null;
}

export interface RunGeneration {
  id: number;
  run_id: string;
  generation_id: string;
  captured_at: number;
  model: string | null;
  provider_name: string | null;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  native_tokens_prompt: number | null;
  native_tokens_completion: number | null;
  native_tokens_reasoning: number | null;
  native_tokens_cached: number | null;
  total_cost: number | null;
  session_id: string | null;
  external_user: string | null;
  reconciled_at: number | null;
}

export interface RunEvent {
  id: number;
  run_id: string;
  seq: number;
  ts: number;
  kind: string;
  text: string | null;
  tool_name: string | null;
  tool_status: string | null;
  payload_json: string;
}

export interface Paginated<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface RunFilters {
  status?: string;
  role?: string;
  backend?: string;
  issueId?: string;
  page?: number;
  pageSize?: number;
}

function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params as Record<string, string | number | undefined>)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const runsApi = {
  list: (filters: RunFilters) => request<Paginated<Run>>(`/runs${qs(filters)}`),
  active: () => request<Run[]>("/runs/active"),
  get: (id: string) =>
    request<{ run: Run; events: RunEvent[]; workspacePath: string | null }>(`/runs/${id}`),
  // Só suportado no backend Goose — ver /api/runs/:id/stop no serviço.
  stop: (id: string, reason: string) =>
    request<{ ok: boolean; warning?: string }>(`/runs/${id}/stop`, { method: "POST", body: JSON.stringify({ reason }) }),
};

// ── Recipe do papel (só backend Goose — ver /api/recipes/:role) ──
export interface RecipeExtension {
  type: string;
  name: string;
  [key: string]: unknown;
}
export interface RecipeDetail {
  title?: string;
  description?: string;
  settings?: { goose_provider?: string; goose_model?: string };
  extensions?: RecipeExtension[];
  instructions?: string;
}
export const recipesApi = {
  get: (role: string) => request<RecipeDetail>(`/recipes/${role}`),
};

// ── Configuração efetiva (tela Config — ver /api/config) ──
export interface ConfigEntry {
  env: string;
  value: string;
  source: "env" | "default";
  secret?: boolean;
}
export interface ConfigGroup {
  group: string;
  entries: ConfigEntry[];
}
export interface ConfigRecipe {
  role: string;
  file: string;
  provider?: string;
  model?: string;
  extensions: Array<{ name: string; type: string; uri?: string }>;
}
export interface ConfigResponse {
  backend: string;
  groups: ConfigGroup[];
  recipes: ConfigRecipe[];
}
export const configApi = {
  get: () => request<ConfigResponse>("/config"),
};

// ── Webhooks ──
export interface WebhookEventRow {
  id: number;
  received_at: number;
  entity_type: string;
  action: string | null;
  issue_id: string | null;
  issue_identifier: string | null;
  issue_title: string | null;
  team_id: string | null;
  team_key: string | null;
  team_name: string | null;
  project_id: string | null;
  project_name: string | null;
  milestone_id: string | null;
  milestone_name: string | null;
  actor_name: string | null;
  actor_type: string | null;
  summary: string;
  triggered_scheduler: number;
  raw_json: string;
}

export const webhooksApi = {
  list: (filters: { issueId?: string; teamId?: string; projectId?: string; q?: string; page?: number; pageSize?: number }) =>
    request<Paginated<WebhookEventRow>>(`/webhooks${qs(filters)}`),
  get: (id: number) => request<WebhookEventRow>(`/webhooks/${id}`),
};

// ── Overview ──
export interface OverviewResponse {
  tokensPerDay: { day: string; inputTokens: number; outputTokens: number }[];
  runsPerDay: { day: string; role: string; count: number }[];
  kpis: {
    tokensInputToday: number;
    tokensOutputToday: number;
    runsToday: number;
    activeNow: number;
    avgDurationMs: number;
    completedInWindow: number;
    failedInWindow: number;
    costUsdInWindow: number;
  };
  topIssues: { issueIdentifier: string; runs: number; failures: number; costUsd: number }[];
}
export const overviewApi = {
  get: (days: number) => request<OverviewResponse>(`/overview?days=${days}`),
};

// ── Logs (tail ao vivo) ──
export const logsApi = {
  recent: (limit?: number) => request<{ lines: string[] }>(`/logs/recent${qs({ limit })}`),
};

// ── Query genérica (fields/filter/busca livre/sort/limit/page) — usada hoje
// pela tela de Logs; o mesmo endpoint já serve "runs" e "webhook_events" caso
// vire ligado nas outras telas. See app/src/dashboard/query.ts. ──
export type QueryEntity = "log_lines" | "runs" | "webhook_events";
export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";

export interface QueryFilter {
  field: string;
  op: FilterOp;
  value: string | number;
}

export interface QuerySortSpec {
  field: string;
  dir: "asc" | "desc";
}

export interface QuerySpec {
  fields?: string[];
  filters?: QueryFilter[];
  // Mini-linguagem estilo CloudWatch Insights (fields/filter/sort/limit
  // separados por "|") — ver app/src/dashboard/queryLang.ts.
  query?: string;
  q?: string;
  from?: number;
  to?: number;
  sort?: QuerySortSpec[];
  limit?: number;
  page?: number;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  fields: string[];
}

export const queryApi = {
  columns: (entity: QueryEntity) => request<{ columns: string[] }>(`/query/${entity}/columns`),
  run: (entity: QueryEntity, spec: QuerySpec) =>
    request<QueryResult>(`/query/${entity}`, { method: "POST", body: JSON.stringify(spec) }),
};

// ── Agents (Fase 1 — §6) ──
export type AgentRole = "pmo" | "dev" | "reviewer" | "orchestrator";
export interface Agent {
  id: string;
  role: AgentRole;
  name: string;
  description: string | null;
  isActive: number;
  activeVersionId: string | null;
  activeHarnessId: string;
  createdAt: number;
  updatedAt: number;
}
export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  soulMarkdown: string;
  comment: string;
  createdAt: number;
  createdBy: string | null;
}
export interface AgentHarnessConfig {
  id: string;
  agentId: string;
  harnessId: string;
  model: string | null;
  settingsJson: string;
  mcpServersJson: string;
  updatedAt: number;
}
export interface AgentDetail {
  agent: Agent;
  versions: AgentVersion[];
  harnessConfigs: AgentHarnessConfig[];
  harnessIds: string[];
  roleMeta: { title: string; description: string; prompt: string };
}

/** Mirrors `app/src/agent/soulSync.ts` (SOUL bundled with the binary × active version). */
export type SoulSyncStatus = "up-to-date" | "outdated" | "no-agent" | "no-seed";
export interface SoulSyncEntry {
  role: AgentRole;
  soulFile: string;
  status: SoulSyncStatus;
  agentId: string | null;
  agentName: string | null;
  currentVersion: number | null;
  currentVersionComment: string | null;
  currentHash: string | null;
  currentLines: number | null;
  nextVersion: number | null;
  seedHash: string | null;
  seedLines: number | null;
}
export interface SoulSyncApplied {
  role: AgentRole;
  agentId: string;
  agentName: string;
  previousVersion: number | null;
  newVersion: number;
  versionId: string;
}

export const agentsApi = {
  list: () => request<{ agents: Agent[]; roles: AgentRole[] }>("/agents"),
  get: (id: string) => request<AgentDetail>(`/agents/${id}`),
  create: (input: { role: string; name: string; description?: string | null; soulMarkdown: string; comment?: string; harnessId?: string; activate?: boolean }) =>
    request<{ ok: boolean; agent: Agent }>("/agents", { method: "POST", body: JSON.stringify(input) }),
  updateMeta: (id: string, input: { name?: string; description?: string | null }) =>
    request<{ ok: boolean; agent: Agent }>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  activate: (id: string) => request<{ ok: boolean; agent: Agent }>(`/agents/${id}/activate`, { method: "POST" }),
  deactivate: (id: string) => request<{ ok: boolean; agent: Agent }>(`/agents/${id}/deactivate`, { method: "POST" }),
  createVersion: (id: string, input: { soulMarkdown: string; comment: string; activate?: boolean }) =>
    request<{ ok: boolean; version: AgentVersion; agent: Agent }>(`/agents/${id}/versions`, { method: "POST", body: JSON.stringify(input) }),
  activateVersion: (id: string, versionId: string) =>
    request<{ ok: boolean; agent: Agent }>(`/agents/${id}/versions/${versionId}/activate`, { method: "POST" }),
  exportVersionUrl: (id: string, versionId: string) => `/api/agents/${id}/versions/${versionId}/export`,
  updateHarnessConfig: (id: string, harnessId: string, input: { model?: string | null; settingsJson?: string; mcpServersJson?: string }) =>
    request<{ ok: boolean; config: AgentHarnessConfig }>(`/agents/${id}/harness/${harnessId}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteHarnessConfig: (id: string, harnessId: string) =>
    request<{ ok: boolean }>(`/agents/${id}/harness/${harnessId}`, { method: "DELETE" }),
  activateHarness: (id: string, harnessId: string) =>
    request<{ ok: boolean; agent: Agent }>(`/agents/${id}/activate-harness`, { method: "POST", body: JSON.stringify({ harnessId }) }),
  soulSyncPlan: () => request<{ plan: SoulSyncEntry[] }>("/agents/soul-sync"),
  soulSyncApply: (roles?: AgentRole[]) =>
    request<{ ok: boolean; applied: SoulSyncApplied[]; plan: SoulSyncEntry[] }>("/agents/soul-sync", {
      method: "POST",
      body: JSON.stringify({ roles: roles ?? [] }),
    }),
};

// ── Harness (Fase 2 — §7.4) ──
/** `id` é a string exata aceita pelo harness; `name` é o rótulo do próprio CLI. */
export interface HarnessModelInfo {
  id: string;
  name?: string;
  description?: string;
}
export interface HarnessDetection {
  installed: boolean;
  binPath?: string;
  version?: string;
  authStatus: "ok" | "not-logged" | "unknown";
  authAccount?: string;
  installHint?: string;
  loginHint?: string;
  models?: HarnessModelInfo[];
  defaultModelId?: string;
  checkedAt: number;
}
export interface HarnessCapabilities {
  integration: "acp" | "native" | "http";
  modelSelection: "list" | "flag" | "none";
  usageReporting: "tokens+cost" | "tokens" | "none";
  costSource: "api" | "subscription";
  sessionResume: boolean;
  mcp: boolean;
  kill: boolean;
}
export interface HarnessBudgets {
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  unit: "usd" | "tokens";
  action: "avisar" | "pausar";
}
export interface HarnessReportEntry {
  id: string;
  label: string;
  capabilities: HarnessCapabilities;
  detection: HarnessDetection | null;
  budgets: HarnessBudgets;
  settings: SettingEntry[];
}
export interface BudgetStatus {
  harnessId: string;
  exceeded: boolean;
  action: "avisar" | "pausar";
  unit: "usd" | "tokens";
  window?: "daily" | "weekly" | "monthly";
  spend?: number;
  limit?: number;
}

export const harnessApi = {
  get: () => request<{ harnesses: HarnessReportEntry[]; banners: BudgetStatus[] }>("/harness"),
  detectAll: () => request<{ ok: boolean }>("/harness/detect-all", { method: "POST" }),
  redetect: (id: string) => request<{ ok: boolean; detection: HarnessDetection }>(`/harness/${id}/redetect`, { method: "POST" }),
  models: (id: string) =>
    request<{
      harnessId: string;
      modelSelection: HarnessCapabilities["modelSelection"];
      models: HarnessModelInfo[];
      defaultModelId?: string;
      checkedAt?: number;
    }>(`/harness/${id}/models`),
  setBudgets: (id: string, budgets: HarnessBudgets) =>
    request<{ ok: boolean; budgets: HarnessBudgets }>(`/harness/${id}/budgets`, { method: "PUT", body: JSON.stringify(budgets) }),
  budgetBanners: () => request<{ banners: BudgetStatus[] }>("/harness/budget-banners"),
  startCursorLogin: () =>
    request<{ url: string | null; alreadyLoggedIn: boolean; message: string }>("/harness/cursor/login", {
      method: "POST",
    }),
  cursorLoginStatus: () =>
    request<{
      session: { active: boolean; url: string | null; startedAt?: number; error?: string };
      auth: { loggedIn: boolean; account?: string; raw: string };
    }>("/harness/cursor/login"),
  cancelCursorLogin: () => request<{ ok: boolean }>("/harness/cursor/login", { method: "DELETE" }),
};

// ── Notificações (Fase 3 — §8.1) ──
export type NotificationEventType = "issue_blocked" | "issue_pending_merge" | "run_failed" | "circuit_breaker" | "budget_exceeded" | "reclaim_timeout";
export interface NotificationChannel {
  id: string;
  type: "webhook" | "slack" | "telegram";
  name: string;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  events: Array<{ event: NotificationEventType; enabled: boolean }>;
}

export const notificationsApi = {
  list: () => request<{ channels: NotificationChannel[]; events: NotificationEventType[] }>("/notifications"),
  create: (input: { type: string; name: string; config: Record<string, unknown> }) =>
    request<{ ok: boolean; channel: NotificationChannel }>("/notifications", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: { name?: string; config?: Record<string, unknown> }) =>
    request<{ ok: boolean; channel: NotificationChannel }>(`/notifications/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  remove: (id: string) => request<{ ok: boolean }>(`/notifications/${id}`, { method: "DELETE" }),
  setRule: (id: string, event: string, enabled: boolean) =>
    request<{ ok: boolean; channel: NotificationChannel }>(`/notifications/${id}/rules/${event}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  test: (id: string) => request<{ ok: boolean }>(`/notifications/${id}/test`, { method: "POST" }),
};

// ── Linear connections (multi-workspace) ──
/** `null` = usa o GITHUB_TOKEN global (Config) — o "modo global" da UI. */
export type GithubAuthMode = "pat" | "app" | null;

export interface LinearConnection {
  id: string;
  name: string;
  organizationId: string;
  organizationKey: string | null;
  teamId: string | null;
  teamKey: string | null;
  enabled: boolean;
  apiKeyMasked: string;
  webhookSecretMasked: string;
  githubTokenMasked: string | null;
  hasGithubToken: boolean;
  githubAuthMode: GithubAuthMode;
  githubAppId: string | null;
  githubInstallationId: string | null;
  /** A PEM nunca volta do backend, nem mascarada — só o fato de estar salva. */
  hasGithubAppKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GithubAppProbeResult {
  ok: boolean;
  app?: { id: number; slug: string; name: string };
  installations?: Array<{ id: number; account: string | null; accountType: string | null }>;
  installation?: { id: string; account: string | null; expiresAt: string };
  error?: string;
}

/** Campos de auth GitHub aceitos no create/update (null = limpar). */
export interface GithubAuthPayload {
  githubAuthMode?: GithubAuthMode;
  githubToken?: string | null;
  githubAppId?: string | null;
  githubInstallationId?: string | null;
  githubAppPrivateKey?: string | null;
}

export interface LinearProbeResult {
  ok: boolean;
  viewer?: { id: string; name: string; email: string };
  organizations?: Array<{ id: string; urlKey: string; name: string }>;
  organization?: { id: string; urlKey: string; name: string };
  teams?: Array<{ id: string; key: string; name: string }>;
  error?: string;
}

export const linearConnectionsApi = {
  list: () =>
    request<{ connections: LinearConnection[]; webhookUrl: string; legacyFallbackActive: boolean }>(
      "/linear-connections"
    ),
  probe: (apiKey: string) =>
    request<LinearProbeResult>("/linear-connections/probe", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    }),
  probeGithub: (token: string) =>
    request<{ ok: boolean; user?: { login: string; id: number; type: string }; error?: string }>(
      "/linear-connections/probe-github",
      { method: "POST", body: JSON.stringify({ token }) }
    ),
  probeGithubApp: (input: { appId: string; privateKey: string; installationId?: string }) =>
    request<GithubAppProbeResult>("/linear-connections/probe-github-app", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  testGithub: (id: string) =>
    request<{
      ok: boolean;
      source?: "pat" | "app" | "global";
      user?: { login: string; id: number; type: string } | null;
      committer?: { name: string; email: string } | null;
      error?: string;
    }>(`/linear-connections/${id}/test-github`, { method: "POST" }),
  create: (
    input: GithubAuthPayload & {
      name: string;
      apiKey: string;
      organizationId: string;
      organizationKey?: string;
      teamId?: string | null;
      teamKey?: string | null;
      webhookSecret?: string;
      enabled?: boolean;
    }
  ) =>
    request<{ ok: boolean; connection: LinearConnection; webhookSecret: string }>("/linear-connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (
    id: string,
    /** Em todo campo de secret: string = set; null = limpar; ausente = manter. */
    input: GithubAuthPayload & {
      name?: string;
      apiKey?: string;
      webhookSecret?: string;
      organizationId?: string;
      organizationKey?: string | null;
      teamId?: string | null;
      teamKey?: string | null;
      enabled?: boolean;
    }
  ) =>
    request<{ ok: boolean; connection: LinearConnection }>(`/linear-connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) => request<{ ok: boolean }>(`/linear-connections/${id}`, { method: "DELETE" }),
  test: (id: string) => request<LinearProbeResult>(`/linear-connections/${id}/test`, { method: "POST" }),
  rotateWebhookSecret: (id: string) =>
    request<{ ok: boolean; connection: LinearConnection; webhookSecret: string; webhookCreated: boolean }>(
      `/linear-connections/${id}/rotate-webhook-secret`,
      { method: "POST" }
    ),
};

// ── Dispatch manual (§8.2) ──
export const dispatchApi = {
  now: (issue: string) => request<{ dispatched: boolean; reason?: string }>(`/dispatch/${encodeURIComponent(issue)}`, { method: "POST" }),
};

// ── Prontidão / candidatas (snapshot Valkey pós-tick) ──
export type ReadinessPhase = "refine" | "implement" | "review" | "merge" | "blocked";
export type ReadinessStatus =
  | "ready"
  | "waiting_capacity"
  | "blocked_by_rule"
  | "estimating"
  | "waiting_human";

export type ReadinessReasonCode =
  | "ready"
  | "no_capacity"
  | "missing_label"
  | "deps_unsatisfied"
  | "footprint_collision"
  | "estimating_footprint"
  | "budget_paused"
  | "lock_held"
  | "circuit_breaker"
  | "merge_mutex_held"
  | "orchestrator_workers_disabled"
  | "missing_pr"
  | "unauthorized_repo"
  | "waiting_human";

export interface ReadinessDep {
  issueId: string;
  identifier: string;
  stateName: string;
}

export interface ReadinessCollision {
  issueId: string;
  identifier: string;
  stateName: string | null;
  overlappingEntries: { ours: string; theirs: string }[];
}

export interface ReadinessReason {
  code: ReadinessReasonCode;
  detail: string;
  label?: string;
  deps?: ReadinessDep[];
  collidingIssueIds?: string[];
  collisions?: ReadinessCollision[];
  attempts?: number;
  maxAttempts?: number;
  mergingIssueId?: string | null;
  mergingIssueIdentifier?: string | null;
  prOwner?: string;
}

export interface ReadinessIssue {
  issueId: string;
  identifier: string;
  title: string;
  stateName: string;
  phase: ReadinessPhase;
  status: ReadinessStatus;
  reasons: ReadinessReason[];
  tier: "reopened" | "planned" | null;
  attempts: number;
  maxAttempts: number;
  hasFootprint: boolean;
  hasLock: boolean;
  blockedComment: string | null;
}

export interface ReadinessSnapshot {
  updatedAt: number;
  connectionId: string;
  connectionName: string;
  organizationId: string;
  organizationKey: string | null;
  capacity: {
    refine: { occupied: number; max: number; free: number };
    implement: { occupied: number; max: number; free: number };
    review: { occupied: number; max: number; free: number };
    merge: { max: number; busy: boolean; mergingIssueId: string | null };
  };
  flags: {
    autoDispatchIssues: boolean;
    autoMergeIssues: boolean;
    orchestratorEnabled: boolean;
  };
  issues: ReadinessIssue[];
}

export interface ReadinessResponse {
  ttlSeconds: number;
  snapshots: ReadinessSnapshot[];
  missingConnectionIds: string[];
}

export const readinessApi = {
  get: (connectionId?: string) =>
    request<ReadinessResponse>(
      connectionId ? `/readiness?connectionId=${encodeURIComponent(connectionId)}` : "/readiness"
    ),
};

// ── Locks (footprint, Valkey) ──
export interface LockEntry {
  issueId: string;
  footprint: string[];
}
export interface ConnectionLocks {
  connectionId: string;
  connectionName: string;
  locks: LockEntry[];
}
export interface LocksListResponse {
  connections: ConnectionLocks[];
}
export const locksApi = {
  list: () => request<LocksListResponse>("/locks"),
  release: (connectionId: string, issueId: string) =>
    request<{ ok: true; warning?: string }>(
      `/locks/${encodeURIComponent(connectionId)}/${encodeURIComponent(issueId)}/release`,
      { method: "POST" }
    ),
};
