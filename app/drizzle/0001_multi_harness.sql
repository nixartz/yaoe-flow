-- Multi-harness blueprint phases 1-3: agents as an entity, per-run snapshot,
-- usage/cost/external refs, per-harness detection+budget cache, and
-- notifications.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('pmo', 'senior-engineer', 'reviewer', 'orchestrator')),
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  active_version_id TEXT,
  active_harness_id TEXT NOT NULL DEFAULT 'goose',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_agents_one_active_per_role ON agents(role) WHERE is_active = 1;
--> statement-breakpoint
CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL,
  soul_markdown TEXT NOT NULL,
  comment TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_agent_versions_agent_version ON agent_versions(agent_id, version);
--> statement-breakpoint
CREATE TABLE agent_harness_configs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  harness_id TEXT NOT NULL,
  model TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  mcp_servers_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_agent_harness_configs_unique ON agent_harness_configs(agent_id, harness_id);
--> statement-breakpoint
CREATE TABLE harnesses (
  id TEXT PRIMARY KEY,
  detection_json TEXT,
  budgets_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'slack', 'telegram')),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_notification_rules_unique ON notification_rules(channel_id, event);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN agent_id TEXT;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN agent_version_id TEXT;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN harness_id TEXT;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN resolved_config_json TEXT;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN cost_source TEXT;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN external_session_id TEXT;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN external_refs_json TEXT;
