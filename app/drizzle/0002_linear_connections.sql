-- Multi-Linear connections: N workspaces Linear por instância do orchestrator.
-- Tabela própria (não settings flat), coluna de auditoria em runs/webhook_events.
CREATE TABLE linear_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  organization_key TEXT,
  api_key_enc TEXT NOT NULL,
  webhook_secret_enc TEXT NOT NULL,
  team_id TEXT,
  team_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_linear_connections_org ON linear_connections(organization_id);
--> statement-breakpoint
CREATE INDEX idx_linear_connections_enabled ON linear_connections(enabled);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN linear_connection_id TEXT;
--> statement-breakpoint
CREATE INDEX idx_runs_linear_connection ON runs(linear_connection_id);
--> statement-breakpoint
ALTER TABLE webhook_events ADD COLUMN organization_id TEXT;
--> statement-breakpoint
ALTER TABLE webhook_events ADD COLUMN connection_id TEXT;
