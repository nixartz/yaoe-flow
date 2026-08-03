-- Dual-mode GitHub auth per Linear connection: PAT (existing behavior) OR
-- GitHub App (App ID + Installation ID + Private Key PEM → installation token).
-- github_auth_mode NULL = legacy behavior (the row's PAT, else the global
-- GITHUB_TOKEN) — no existing connection changes behavior from this migration.
ALTER TABLE linear_connections ADD COLUMN github_auth_mode TEXT;
--> statement-breakpoint
ALTER TABLE linear_connections ADD COLUMN github_app_id TEXT;
--> statement-breakpoint
ALTER TABLE linear_connections ADD COLUMN github_installation_id TEXT;
--> statement-breakpoint
ALTER TABLE linear_connections ADD COLUMN github_app_private_key_enc TEXT;
