# Pipeline semantics that must not break

- **Status is the source of truth; labels only restrict/decorate.** No new logic may decide based on a label alone (see `config.labels`).
- **Footprint is a privilege ceiling.** Changes to the scope-check (`app/src/scope.ts`) or the collision matcher (`app/src/dag.ts`) must keep treating `repo:path` as a namespace — never compare paths without qualifying the repo.
- **`RunStatus` is deliberately duplicated** (no shared package between `app/` and `dashboard/`) in `app/src/dashboard/store.ts` and `dashboard/src/lib/api.ts`. When adding a status, update both — the `Record<RunStatus, …>` in `StatusBadge.tsx` forces you via TypeScript to style the new value.
- **SOULs are the single source of agent behavior.** `agents/*.SOUL.md` is the seed/interchange format; the runtime source of truth is the database (`app/src/db/agents.ts`). `recipes/*.yaml` are static seeds/debug fallback — agents configured on the dashboard build their recipe at runtime (`app/src/agent/recipe/builder.ts`).

