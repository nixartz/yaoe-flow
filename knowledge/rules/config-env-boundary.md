# Only `app/src/config/` reads process.env

The `src/config/` family (`bootstrap.ts`, `registry.ts`, `service.ts`, plus
the `config.ts` facade) is the **only** backend code allowed to read
`process.env`. Every other module imports `config` (or the config service).

Configuration resolves with precedence **ENV > database > default** — the
dashboard Config screen edits the database. Adding a setting means:

1. An entry in `app/src/config/registry.ts` (type + English description +
   scope + validation).
2. A getter in `app/src/config.ts`.

Never a raw `process.env.X` at a call site.
