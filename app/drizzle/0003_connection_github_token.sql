-- GitHub token opcional por Linear connection (multi-org bots).
-- NULL = fallback para GITHUB_TOKEN global (config/ENV).
ALTER TABLE linear_connections ADD COLUMN github_token_enc TEXT;
