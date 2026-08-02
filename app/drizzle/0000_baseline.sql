-- Migration baseline (§5.1): adota o banco EXISTENTE da dashboard sem recriar
-- nem perder dados. Todo o DDL usa IF NOT EXISTS de propósito — num banco novo
-- cria tudo; num banco real já populado é no-op (mesmas tabelas/índices do
-- antigo dashboard/schema.sql). Colunas adicionadas por ALTER em versões
-- antigas do serviço são normalizadas ANTES desta migration rodar
-- (ver normalizeLegacyRuns em src/db/index.ts).
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  operation TEXT NOT NULL,
  role TEXT NOT NULL,
  issue_id TEXT,
  issue_identifier TEXT,
  mode TEXT,
  status TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  stop_reason TEXT,
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  cost_input_usd REAL,
  cost_output_usd REAL,
  openrouter_session_id TEXT,
  goose_session_id TEXT,
  usage_source TEXT,
  usage_reconciled_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  tool_name TEXT,
  tool_status TEXT,
  payload_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL UNIQUE,
  captured_at INTEGER NOT NULL,
  model TEXT,
  provider_name TEXT,
  tokens_prompt INTEGER,
  tokens_completion INTEGER,
  native_tokens_prompt INTEGER,
  native_tokens_completion INTEGER,
  native_tokens_reasoning INTEGER,
  native_tokens_cached INTEGER,
  total_cost REAL,
  session_id TEXT,
  external_user TEXT,
  raw_json TEXT,
  reconciled_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_generations_run ON run_generations(run_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  action TEXT,
  issue_id TEXT,
  issue_identifier TEXT,
  issue_title TEXT,
  team_id TEXT,
  team_key TEXT,
  team_name TEXT,
  project_id TEXT,
  project_name TEXT,
  milestone_id TEXT,
  milestone_name TEXT,
  actor_name TEXT,
  actor_type TEXT,
  summary TEXT NOT NULL,
  triggered_scheduler INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_webhook_received ON webhook_events(received_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_webhook_issue ON webhook_events(issue_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS log_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT,
  feature TEXT,
  msg TEXT,
  fields_json TEXT NOT NULL,
  raw TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_log_lines_ts ON log_lines(ts DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_log_lines_level ON log_lines(level);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_log_lines_feature ON log_lines(feature);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  type TEXT NOT NULL DEFAULT 'administrator' CHECK (type IN ('administrator')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
