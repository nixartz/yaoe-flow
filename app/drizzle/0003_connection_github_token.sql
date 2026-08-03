-- Optional GitHub token per Linear connection (multi-org bots).
-- NULL = falls back to the global GITHUB_TOKEN (config/ENV).
ALTER TABLE linear_connections ADD COLUMN github_token_enc TEXT;
