# Schema changes are versioned migrations + regenerate embedded assets

Every schema change is a versioned Drizzle migration in `app/drizzle/` — ad-hoc `CREATE TABLE IF NOT EXISTS` at runtime is forbidden.

**After creating a migration (or editing a SOUL), run `bun run embed-assets` in `app/`.** `db/index.ts` prefers `EMBEDDED_MIGRATIONS` whenever `embedded-assets.generated.ts` has content — and it is committed WITH content. So in dev and in tests the migrator reads from the embedded bundle, not from disk: without regenerating, the new migration is invisible and the error you get is a `SQLiteError: table X has no column named Y` that never mentions migrations.

Release builds (`yaoe-flow install-local` / `bun scripts/build-and-install.ts` / the release workflow) run `embed-assets` on their own — the manual step is only for the dev/test loop.

Never edit `app/src/embedded-assets.generated.ts` by hand.

