// Schema declarativo (Drizzle ORM sobre bun:sqlite) — §5.1 do blueprint.
// As tabelas de telemetria (runs/run_events/run_generations/webhook_events/
// log_lines) ESPELHAM o DDL histórico de dashboard/schema.sql — a migration
// baseline (drizzle/0000_baseline.sql) as adota com IF NOT EXISTS, sem recriar
// nem perder dados. users/settings nascem na Fase 0.
//
// Regra permanente: toda mudança de schema daqui em diante é migration
// versionada em app/drizzle/ — proibido CREATE TABLE ad-hoc em runtime.
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    backend: text("backend").notNull(),
    operation: text("operation").notNull(),
    role: text("role").notNull(),
    issueId: text("issue_id"),
    issueIdentifier: text("issue_identifier"),
    mode: text("mode"),
    status: text("status").notNull(),
    provider: text("provider"),
    model: text("model"),
    stopReason: text("stop_reason"),
    errorMessage: text("error_message"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: real("cost_usd"),
    costInputUsd: real("cost_input_usd"),
    costOutputUsd: real("cost_output_usd"),
    openrouterSessionId: text("openrouter_session_id"),
    gooseSessionId: text("goose_session_id"),
    usageSource: text("usage_source"),
    usageReconciledAt: integer("usage_reconciled_at"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    durationMs: integer("duration_ms"),
    // Fase 1 (§6.4): snapshot auditável — um run antigo sempre mostra o que
    // REALMENTE rodou, mesmo que a SOUL/config tenha mudado depois.
    agentId: text("agent_id"),
    agentVersionId: text("agent_version_id"),
    harnessId: text("harness_id"),
    resolvedConfigJson: text("resolved_config_json"),
    // Fase 2 (§7.5): custo honesto + referências pro histórico da ferramenta.
    costSource: text("cost_source"),
    externalSessionId: text("external_session_id"),
    externalRefsJson: text("external_refs_json"),
    // Multi-Linear: qual connection autenticou o run (nullable = legado/single).
    linearConnectionId: text("linear_connection_id"),
  },
  (t) => [
    index("idx_runs_started").on(t.startedAt),
    index("idx_runs_status").on(t.status),
    index("idx_runs_issue").on(t.issueId),
    index("idx_runs_linear_connection").on(t.linearConnectionId),
  ]
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    ts: integer("ts").notNull(),
    kind: text("kind").notNull(),
    text: text("text"),
    toolName: text("tool_name"),
    toolStatus: text("tool_status"),
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [index("idx_run_events_run").on(t.runId, t.seq)]
);

export const runGenerations = sqliteTable(
  "run_generations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    generationId: text("generation_id").notNull().unique(),
    capturedAt: integer("captured_at").notNull(),
    model: text("model"),
    providerName: text("provider_name"),
    tokensPrompt: integer("tokens_prompt"),
    tokensCompletion: integer("tokens_completion"),
    nativeTokensPrompt: integer("native_tokens_prompt"),
    nativeTokensCompletion: integer("native_tokens_completion"),
    nativeTokensReasoning: integer("native_tokens_reasoning"),
    nativeTokensCached: integer("native_tokens_cached"),
    totalCost: real("total_cost"),
    sessionId: text("session_id"),
    externalUser: text("external_user"),
    rawJson: text("raw_json"),
    reconciledAt: integer("reconciled_at"),
  },
  (t) => [index("idx_run_generations_run").on(t.runId)]
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    receivedAt: integer("received_at").notNull(),
    entityType: text("entity_type").notNull(),
    action: text("action"),
    issueId: text("issue_id"),
    issueIdentifier: text("issue_identifier"),
    issueTitle: text("issue_title"),
    teamId: text("team_id"),
    teamKey: text("team_key"),
    teamName: text("team_name"),
    projectId: text("project_id"),
    projectName: text("project_name"),
    milestoneId: text("milestone_id"),
    milestoneName: text("milestone_name"),
    actorName: text("actor_name"),
    actorType: text("actor_type"),
    summary: text("summary").notNull(),
    triggeredScheduler: integer("triggered_scheduler").notNull().default(0),
    rawJson: text("raw_json").notNull(),
    // Multi-Linear: org/connection que autenticou o webhook (auditoria).
    organizationId: text("organization_id"),
    connectionId: text("connection_id"),
  },
  (t) => [index("idx_webhook_received").on(t.receivedAt), index("idx_webhook_issue").on(t.issueId)]
);

export const logLines = sqliteTable(
  "log_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    level: text("level"),
    feature: text("feature"),
    msg: text("msg"),
    fieldsJson: text("fields_json").notNull(),
    raw: text("raw").notNull(),
  },
  (t) => [index("idx_log_lines_ts").on(t.ts), index("idx_log_lines_level").on(t.level), index("idx_log_lines_feature").on(t.feature)]
);

// ── Fase 0 ──

// Usuários da dashboard (D7): simples, sem SSO/2FA, sem hard-delete (inativar).
// `type` sempre administrator por enquanto — o campo existe preparado p/ tipos
// futuros (§11.5).
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: text("status").notNull().default("active"),
    type: text("type").notNull().default("administrator"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastLoginAt: integer("last_login_at"),
  },
  (t) => [uniqueIndex("idx_users_username").on(t.username), uniqueIndex("idx_users_email").on(t.email)]
);

// Config da aplicação no banco (D8). Precedência de leitura: ENV > banco >
// default (ver src/config/service.ts). `value` é cifrado (db/secrets.ts)
// quando o campo é `secret` no registry.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").references(() => users.id),
});

// Multi-Linear: N workspaces (API key + webhook secret) por instância.
export const linearConnections = sqliteTable(
  "linear_connections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    organizationId: text("organization_id").notNull(),
    organizationKey: text("organization_key"),
    apiKeyEnc: text("api_key_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    /** Token GitHub (PAT/bot) cifrado — NULL = usa GITHUB_TOKEN global. */
    githubTokenEnc: text("github_token_enc"),
    /** `"pat"` | `"app"` | NULL = legado (PAT da row, senão GITHUB_TOKEN global). */
    githubAuthMode: text("github_auth_mode"),
    /** Modo `app`: App ID numérico (issuer do JWT). */
    githubAppId: text("github_app_id"),
    /** Modo `app`: id da installation na org/conta alvo. */
    githubInstallationId: text("github_installation_id"),
    /** Modo `app`: private key PEM cifrada — nunca volta em claro pra API/UI. */
    githubAppPrivateKeyEnc: text("github_app_private_key_enc"),
    teamId: text("team_id"),
    teamKey: text("team_key"),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("idx_linear_connections_org").on(t.organizationId),
    index("idx_linear_connections_enabled").on(t.enabled),
  ]
);

// ── Fase 1 — Agents como entidade (§6.1) ──

// N variantes por papel, no máximo 1 ativa (unique index parcial na migration).
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isActive: integer("is_active").notNull().default(0),
  activeVersionId: text("active_version_id"),
  activeHarnessId: text("active_harness_id").notNull().default("goose"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// SOUL versionada, append-only — histórico nunca reescreve (rollback = versão nova).
export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    version: integer("version").notNull(),
    soulMarkdown: text("soul_markdown").notNull(),
    comment: text("comment").notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("idx_agent_versions_agent_version").on(t.agentId, t.version)]
);

// D3: config POR HARNESS, nunca apagada implicitamente — trocar o harness
// ativo não toca nas linhas dos outros; delete só explícito.
export const agentHarnessConfigs = sqliteTable(
  "agent_harness_configs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    harnessId: text("harness_id").notNull(),
    model: text("model"),
    settingsJson: text("settings_json").notNull().default("{}"),
    mcpServersJson: text("mcp_servers_json").notNull().default("[]"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_agent_harness_configs_unique").on(t.agentId, t.harnessId)]
);

// ── Fase 2 — cache de detecção + budgets por harness (§7.4) ──
export const harnesses = sqliteTable("harnesses", {
  id: text("id").primaryKey(),
  detectionJson: text("detection_json"),
  budgetsJson: text("budgets_json").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull(),
});

// ── Fase 3 — notificações (§8.1) ──
export const notificationChannels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const notificationRules = sqliteTable(
  "notification_rules",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    enabled: integer("enabled").notNull().default(1),
  },
  (t) => [uniqueIndex("idx_notification_rules_unique").on(t.channelId, t.event)]
);
