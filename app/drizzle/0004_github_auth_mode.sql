-- Auth GitHub dual-mode por Linear connection: PAT (o que já existia) OU
-- GitHub App (App ID + Installation ID + Private Key PEM → installation token).
-- github_auth_mode NULL = comportamento legado (PAT da row, senão GITHUB_TOKEN
-- global) — nenhuma connection existente muda de comportamento na migration.
ALTER TABLE linear_connections ADD COLUMN github_auth_mode TEXT;
--> statement-breakpoint
ALTER TABLE linear_connections ADD COLUMN github_app_id TEXT;
--> statement-breakpoint
ALTER TABLE linear_connections ADD COLUMN github_installation_id TEXT;
--> statement-breakpoint
ALTER TABLE linear_connections ADD COLUMN github_app_private_key_enc TEXT;
