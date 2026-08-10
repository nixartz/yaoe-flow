# Schema changes are versioned migrations + regenerate embedded assets

Every schema change is a versioned Drizzle migration in `app/drizzle/` — ad-hoc `CREATE TABLE IF NOT EXISTS` at runtime is forbidden.

**After creating a migration (or editing a SOUL), run `bun run embed-assets -- --no-dashboard` in `app/`** (or plain `bun run embed-assets` if you do not mind also baking a local `dashboard/dist` into the stub). `db/index.ts` prefers `EMBEDDED_MIGRATIONS` whenever `embedded-assets.generated.ts` has content — and migrations/SOULs **are** committed. So in dev and in tests the migrator reads from the embedded bundle, not from disk: without regenerating, the new migration is invisible and the error you get is a `SQLiteError: table X has no column named Y` that never mentions migrations.

**The dashboard SPA is not committed.** `EMBEDDED_DASHBOARD_ASSETS` must stay `{}` in git. `dashboard/dist/` is gitignored. Release / `bun scripts/build-and-install.ts` always: build the SPA → `embed-assets --require-dashboard` → compile. That flag fails the job if the SPA was not embedded (avoids shipping a binary with a stale or empty UI).

Never edit `app/src/embedded-assets.generated.ts` by hand.
