# Secrets never serialized; dashboard writes are best-effort

**Secrets**

- Settings marked `secret` in the registry are AES-256-GCM encrypted at rest
  (`app/src/db/secrets.ts`) and always masked in the API.
- MCP/recipe configs reference credentials by env-var **name** (`envKeys` for
  stdio, `${VAR}` placeholders in `streamable_http` headers) — resolved from
  the environment at dispatch, never written into a config, recipe or the
  database in plain text.
- Never log a secret; follow the masking patterns of the settings API.

**Best-effort dashboard writes**

`app/src/dashboard/store.ts` wraps every write in `safe()` which only logs on
error — a dashboard persistence failure must never take down a real dispatch.
Follow that pattern for any new dashboard write.

**Self-healing rule**

Any resource a dispatch acquires (lock, seat, run row) needs a release path in
`reclaimStale()` (scheduler) or equivalent — otherwise a hung agent pins that
resource forever.
