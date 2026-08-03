# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via GitHub Security Advisories (https://github.com/nixartz/yaoe-flow/security/advisories/new) or e-mail security@sims.dev.br. You should get an answer within a few days.

## Scope notes for operators

- Secrets (API keys, tokens) are stored AES-256-GCM encrypted in the SQLite database; the key lives in `~/.yaoe-flow/config.env` (chmod 600). Protect that directory.
- The daemon refuses to run as root by design — harness CLI credentials live in the logged-in user's HOME.
- Set `AGENT_AUTHORIZED_ORGS` in any real deployment (anti-fork fail-safe).
- The dashboard should not be exposed to the public internet without a reverse proxy providing TLS; sessions are cookie-based (JWT signed with `DASHBOARD_SESSION_SECRET`).

## Supply chain

- CI runs gitleaks on every push/PR.
- Release binaries ship with a `SHA256SUMS` file; the install scripts verify checksums before installing.

