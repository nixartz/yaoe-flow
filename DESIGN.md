# DESIGN.md — dashboard design system

Scope: `dashboard/` only (React SPA). The backend (`app/`) and the `yaoe-flow` CLI have no UI — plain terminal output (✅/⚠️/❌, see `AGENTS.md`). This document describes what **actually exists** in the code — it is not aspirational; keep it in sync when tokens/components change.

## Visual stack

React 19 + Vite + TypeScript · Tailwind CSS 4 (`@tailwindcss/vite`, zero config file — everything in `src/index.css` via `@theme inline`) · [shadcn/ui](https://ui.shadcn.com)-style components written by hand in `src/components/ui/` (no shadcn CLI here, no `components.json`) · [Radix UI](https://radix-ui.com) primitives underneath the interactive components · [`class-variance-authority`](https://cva.style) (`cva`) for variants · [`@tabler/icons-react`](https://tabler.io/icons) as the default icon set (a few spots use `lucide-react`) · [Recharts](https://recharts.org) for the usage/cost charts.

Font: **Inter** (`--font-sans`), fallback `system-ui`. Monospace: `ui-monospace`/`SFMono-Regular`/`Menlo`/`Consolas` (`--font-mono`) — used for IDs, hashes, JSON (`JsonEditor.tsx`).

## Color tokens

All in [OKLCH](https://oklch.com), defined as CSS custom properties in `src/index.css` (`:root` = light, `.dark` = dark — class toggle on the root, no media query), remapped to Tailwind via `@theme inline` (`--color-background`, `--color-primary`, etc. — use the normal Tailwind classes, `bg-primary`/`text-muted-foreground`/etc., never the CSS var directly except for the dynamic cases described below).

| Token | Role | Light | Dark |
|---|---|---|---|
| `background` / `foreground` | base page background/text | `oklch(0.99 0 0)` / `oklch(0.16 0.01 285)` | `oklch(0.15 0.006 285)` / `oklch(0.95 0.003 285)` |
| `card` / `card-foreground` | elevated surfaces | `oklch(1 0 0)` | `oklch(0.19 0.006 285)` |
| `primary` | main action, focus, selection | `oklch(0.55 0.2 265)` (blue-violet) | `oklch(0.72 0.17 265)` |
| `secondary` / `muted` | neutral backgrounds, secondary text | `oklch(0.96 0.005 285)` | `oklch(0.25 0.006 285)` |
| `accent` | subtle hover/highlight | `oklch(0.96 0.02 265)` | `oklch(0.27 0.03 265)` |
| `destructive` | error, destructive action | `oklch(0.58 0.22 27)` (red) | `oklch(0.65 0.22 27)` |
| `success` | success, completed run | `oklch(0.62 0.15 148)` (green) | `oklch(0.7 0.16 148)` |
| `warning` | attention, pending | `oklch(0.75 0.15 75)` (amber) | `oklch(0.8 0.15 80)` |
| `border` / `input` / `ring` | borders, fields, focus | `oklch(0.9 0.005 285)` | `oklch(1 0 0 / 10%)` (translucent) |
| `chart-1..5` | chart series (Recharts) | see `index.css` | same, lighter |

`--radius: 0.65rem` is the base radius; `--radius-{sm,md,lg,xl}` derive from it (`calc(var(--radius) ± Npx)`) — use the Tailwind classes `rounded-{sm,md,lg,xl}` generated from those, do not hardcode `rounded-[Npx]`.

### Color per agent role (`--role-*`)

Fixed accent per pipeline role, **theme-independent** (only lightness changes between light/dark, never the hue) — used for fast visual scanning in lists/timelines without reading the text:

| Role | Var | Approx. hue |
|---|---|---|
| PMO | `--role-pmo` | purple (`oklch(_ _ 300)`) |
| Dev / worker | `--role-worker` | blue-violet (`oklch(_ _ 265)`, same hue as `primary`) |
| Reviewer | `--role-reviewer` | teal (`oklch(_ _ 165)`) |
| Orchestrator | `--role-orchestrator` | orange/amber (`oklch(_ _ 70)`) |

Resolved in code by `roleColorVar(role)` (`dashboard/src/lib/format.ts`) — `pmo`/`reviewer`/`orchestrator` map directly; any other value (`dev`, `worker`, `senior-engineer`) falls back to `--role-worker`. Consumed via inline `style` (not a Tailwind class, because the color is dynamic per role) with `color-mix(in oklch, var(--role-x) N%, transparent)` to derive translucent background/border from the SAME color — see `RoleBadge.tsx`. When adding a new role, add the var in `index.css` (light + dark) and the mapping in `roleColorVar`.

## Components (`src/components/ui/`)

Actual inventory (shadcn-style, `cva` + `React.ComponentProps`): `badge`, `button`, `card`, `input`, `popover`, `scroll-area`, `select`, `separator`, `sheet`, `switch`, `table`, `tabs`, `textarea`, `tooltip`.

**`Badge`** (`badge.tsx`) — variants via `cva`: `default` (bg `primary/10`), `secondary`, `outline`, `success`, `warning`, `destructive`. All follow the `bg-{color}/10 text-{color} border-{color}/20` pattern — when adding a new variant, follow that same opacity pattern (do not invent a different combo).

Domain components (outside `ui/`, in `src/components/`): `StatusBadge` (maps `RunStatus` → `Badge` variant + Tabler icon — `running`→`default`+spinner, `completed`→`success`, `failed`/`timeout`→`destructive`, `dispatched`/`cancelled`→`secondary`; `RunStatus` exists duplicated in `app/src/dashboard/store.ts` and here, see AGENTS.md), `RoleBadge` (pill with the `--role-*` color, above), `UsageBadge` (tokens/cost), `RunDetailSheet` (side `Sheet` with a run's timeline), `DispatchManual` (manual dispatch form), `ActivityFeed`, `JsonEditor` (JSON editor with beautify/highlight — used on the Config/Agents screens), `McpServersEditor` (agent Integrations: table 2/4 + detail 1/4 + JSON 1/4, min-h 660px, sortable via dnd-kit), `LinearIssueLink` / `IssueIdentity`, `CopyableId` (labeled ID + full value + copy button — never truncate a UUID without a tooltip/type label), `TimeRangePicker`.

## Layout and navigation

`src/components/layout/` — shell with a persistent navigation sidebar + content area. Routes in `src/App.tsx` (React Router 7), one page per route in `src/pages/`:

`Login` (no sidebar — first-access flow when no user exists) · `Overview` (KPIs + Recharts) · `Live` (in-flight runs, SSE) · `Readiness` (orchestrator candidates + skip reasons, Valkey snapshot) · `History` (paginated table of finished runs) · `Logs` (`components/logs/`, live tail via SSE + query mini-language search) · `Webhooks` (audit of received Linear events) · `Agents` / `AgentEditor` (CRUD of the 4 agents + versions + per-agent harness config) · `Harness` (installed/version/auth detection table + budgets) · `Notifications` (channels/rules) · `Config` (settings screen — `SettingReportEntry`, "set via ENV" badge when locked) · `Users` · `Profile`.

## UI conventions

- **State comes from the backend, never invented in the component.** Every screen fetches via TanStack Query (`dashboard/src/lib/api.ts` is the only HTTP client — no loose `fetch` in components) or consumes SSE. No mock/local state simulating server data.
- **Icons**: `@tabler/icons-react` by default (`Icon*`), size via the Tailwind `size-N` class (not the component's `size` prop).
- **Badges/pills always use opacity over the solid color** (`/10`, `/20`, `/40` — see `Badge` and `RoleBadge`), never a 100% opaque status/role background — keeps both themes readable without duplicated hardcodes.
- **Theme**: `.dark` class on the root (no theme toggle implemented today — if you add one, follow `prefers-color-scheme` + manual override, do not invent a third color scheme).
- **No CSS Modules/styled-components** — only Tailwind utility classes + the CSS vars above; inline `style` only when the color is genuinely dynamic at runtime (agent role, see `RoleBadge`).

