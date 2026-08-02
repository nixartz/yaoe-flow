// STATIC configuration registry: metadata for EVERY setting the service
// understands (1:1 with .env.example), with full description, type, default,
// scope and validation rules. The `settings` table stores only key/value;
// everything else comes from here (code = source of truth for METADATA;
// database = source of truth for edited VALUES).
//
// Scopes:
//   bootstrap  → always and only ENV; read-only in the UI.
//   config     → editable on the Config screen (precedence ENV > db > default).
//   harness    → harness credential/parameter; editable on the Harness screen
//                (same underlying value as the Config screen — never two
//                diverging sources of truth).
//   agent      → per-role configuration; superseded by the Agent entity — only
//                the seed reads these now (read-only in the UI).
import { resolve } from "node:path";

export type SettingType = "string" | "number" | "boolean" | "enum" | "json" | "duration_ms";
export type SettingScope = "bootstrap" | "config" | "harness" | "agent";

export interface SettingMeta {
  key: string;
  group: string;
  type: SettingType;
  enumValues?: string[];
  default: string | number | boolean;
  description: string;
  /** Encrypted at rest (db/secrets.ts) and ALWAYS masked in the API. */
  secret?: boolean;
  /** URL that may carry an embedded credential (user:pass@ is masked in the API). */
  url?: boolean;
  scope: SettingScope;
  /** true = only applies on next restart; false/absent = hot (next tick/dispatch). */
  requiresRestart?: boolean;
  /** Specific validation; returns an error message or null. */
  validate?: (value: string) => string | null;
  /** Field that can be validated against the Linear API ("validate against Linear" button). */
  linearValidatable?: "state" | "label";
}

const APP_ROOT = resolve(import.meta.dir, "..", "..");

function positiveInt(label: string, min = 1): (v: string) => string | null {
  return (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return `${label} must be an integer ≥ ${min}`;
    return null;
  };
}

function nonNegativeInt(label: string): (v: string) => string | null {
  return (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return `${label} must be an integer ≥ 0`;
    return null;
  };
}

// Expected shape of OPENROUTER_AUTO_CONFIG (same parse as openrouter/autoConfig.ts).
function validateAutoConfig(v: string): string | null {
  if (!v.trim()) return null;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return "must be a JSON array of per-recipe entries";
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) return "each entry must be an object";
      if (typeof (item as { recipeName?: unknown }).recipeName !== "string") {
        return 'each entry needs a "recipeName" (string)';
      }
    }
    return null;
  } catch {
    return "invalid JSON";
  }
}

const ROLES = ["PMO", "DEV", "REVIEWER", "ORCHESTRATOR"] as const;

// ── Groups ──

const bootstrapGroup: SettingMeta[] = [
  {
    key: "HOST",
    group: "Bootstrap (ENV only)",
    type: "string",
    default: "localhost",
    scope: "bootstrap",
    description:
      'Bind hostname for the API (PORT) and the dashboard (DASHBOARD_PORT). Default "localhost" — in Docker/K8s use "0.0.0.0", otherwise -p/Service cannot reach the process (loopback binds are not visible outside the container).',
  },
  {
    key: "PORT",
    group: "Bootstrap (ENV only)",
    type: "number",
    default: 4790,
    scope: "bootstrap",
    description: "Port of the service API (/health, /webhook/linear).",
  },
  {
    key: "DASHBOARD_ENABLED",
    group: "Bootstrap (ENV only)",
    type: "boolean",
    default: true,
    scope: "bootstrap",
    description: "Enables/disables the dashboard server (SPA + API on the secondary port).",
  },
  {
    key: "DASHBOARD_PORT",
    group: "Bootstrap (ENV only)",
    type: "number",
    default: 4791,
    scope: "bootstrap",
    description: "Dashboard port (SPA + REST/SSE API), in the same process as the service.",
  },
  {
    key: "DASHBOARD_DB_PATH",
    group: "Bootstrap (ENV only)",
    type: "string",
    default: "$YAOE_HOME/data/dashboard.sqlite",
    scope: "bootstrap",
    description:
      "Path of the application SQLite file (runs, webhooks, logs, users, settings). Map it as a volume in Docker/K8s to persist across deploys. Needed before the database exists — hence bootstrap.",
  },
  {
    key: "DASHBOARD_SESSION_SECRET",
    group: "Bootstrap (ENV only)",
    type: "string",
    default: "",
    secret: true,
    scope: "bootstrap",
    description:
      "Secret that signs the dashboard session cookie (JWT). Generate something random, e.g. openssl rand -hex 32 (the setup wizard generates one for you).",
  },
  {
    key: "DASHBOARD_STATIC_DIR",
    group: "Bootstrap (ENV only)",
    type: "string",
    default: "./dashboard/dist",
    scope: "bootstrap",
    description:
      "Where the static SPA build lives (dashboard/dist). Already set in the Docker image; in local dev prefer running the SPA with Vite (bun run dev).",
  },
  {
    key: "VALKEY_URL",
    group: "Bootstrap (ENV only)",
    type: "string",
    default: "redis://valkey:6379",
    url: true,
    scope: "bootstrap",
    description: "Valkey/Redis URL (footprint locks and pipeline attempt counters).",
  },
  {
    key: "APP_ENCRYPTION_KEY",
    group: "Bootstrap (ENV only)",
    type: "string",
    default: "",
    secret: true,
    scope: "bootstrap",
    description:
      "Key (32 bytes in hex — openssl rand -hex 32) that encrypts secrets stored in the database (AES-256-GCM). REQUIRED: the service refuses to start without it. Changing it makes previously stored secrets unreadable.",
  },
];

const serviceGroup: SettingMeta[] = [
  {
    key: "ORCHESTRATOR_ENABLED",
    group: "Service",
    type: "boolean",
    default: true,
    scope: "config",
    description:
      "Kill switch for orchestration behavior (reconciliation tick + agent dispatch from webhooks). false = only API/dashboard stay up (/health responds, webhooks are still audited), without touching Linear or dispatching any agent. Applied immediately (hot).",
  },
  {
    key: "TICK_INTERVAL_MS",
    group: "Service",
    type: "duration_ms",
    default: 15000,
    scope: "config",
    validate: (v) => (Number(v) >= 1000 ? null : "TICK_INTERVAL_MS must be ≥ 1000 (1s)"),
    description:
      "Interval of the scheduler reconciliation loop (safety net for missed webhooks). Minimum 1s. Hot: the next tick scheduling already uses the new value.",
  },
  {
    key: "HTTP_TIMEOUT_MS",
    group: "Service",
    type: "duration_ms",
    default: 20_000,
    scope: "config",
    validate: positiveInt("HTTP_TIMEOUT_MS"),
    description:
      "Ceiling for a single external API HTTP call (Linear/GitHub/Hermes). Without it, a fetch that never resolves holds the tick forever — the lock never releases and the scheduler silently stops reconciling.",
  },
  {
    key: "LOG_LEVEL",
    group: "Service",
    type: "enum",
    enumValues: ["trace", "debug", "info", "warn", "error", "fatal"],
    default: "info",
    scope: "config",
    description: "Pino log level. Hot: applied immediately to every logger in the process.",
  },
  {
    key: "AGENT_OUTPUT_LANGUAGE",
    group: "Service",
    type: "string",
    default: "English",
    scope: "config",
    description:
      "Language the agents use in HUMAN-FACING output (Linear comments, PR descriptions, review verdicts). Injected into every agent prompt/recipe. Any language name works (e.g. \"English\", \"Portuguese (Brazil)\").",
  },
];

const linearGroup: SettingMeta[] = [
  {
    key: "LINEAR_API_KEY",
    group: "Linear",
    type: "string",
    default: "",
    secret: true,
    scope: "config",
    description:
      "Personal or service-account API key (Linear → Settings → API → Personal API keys). Also forwarded to the agents' MCPs under the LINEAR_API_TOKEN alias.",
  },
  {
    key: "LINEAR_TEAM_ID",
    group: "Linear",
    type: "string",
    default: "",
    scope: "config",
    description:
      "ID of the team whose workflow the pipeline orchestrates (issue statuses and labels are per team). Empty = no team filter (not recommended). Use the \"Validate against Linear\" button to double-check.",
  },
  {
    key: "LINEAR_TEAM_KEY",
    group: "Linear",
    type: "string",
    default: "",
    scope: "config",
    description: "Team key (prefix) in Linear, e.g. ENG. Used in messages and identifier correlation.",
  },
  {
    key: "LINEAR_WEBHOOK_SECRET",
    group: "Linear",
    type: "string",
    default: "",
    secret: true,
    scope: "config",
    requiresRestart: true,
    description:
      "Webhook secret (Linear → Settings → API → Webhooks) used to validate delivery signatures. Empty = signatures are not validated.",
  },
];

const githubGroup: SettingMeta[] = [
  {
    key: "GITHUB_TOKEN",
    group: "GitHub & security",
    type: "string",
    default: "",
    secret: true,
    scope: "config",
    description:
      "Token with the minimum scope to READ PRs of the project repos and comment rejections — this is how the deterministic scope-check discovers the files changed in a PR. The GITHUB_PERSONAL_ACCESS_TOKEN alias is kept when forwarding to MCPs.",
  },
  {
    key: "AGENT_AUTHORIZED_ORGS",
    group: "GitHub & security",
    type: "string",
    default: "",
    scope: "config",
    description:
      "Anti-fork fail-safe: comma-separated list of GitHub orgs/owners the agents may operate on. When set, no PR from an owner outside the list passes the scope-check — even if the issue points there. Empty = no extra guard.",
  },
];

const capacityGroup: SettingMeta[] = [
  {
    key: "MAX_PMO_WORKERS",
    group: "Capacity",
    type: "number",
    default: 1,
    scope: "config",
    validate: nonNegativeInt("MAX_PMO_WORKERS"),
    description:
      "How many PMO agents (refinement: To Do → Refining) may run at the same time. Counts issues in Refining. 0 = no new refinement is pulled. Independent from the other roles (Dev/Reviewer/Orchestrator). Hot: the next tick already respects the value.",
  },
  {
    key: "MAX_DEV_WORKERS",
    group: "Capacity",
    type: "number",
    default: 1,
    scope: "config",
    validate: nonNegativeInt("MAX_DEV_WORKERS"),
    description:
      "How many Dev agents (implementation/fix: Planned/Reopened → In Progress) may run at the same time. Counts issues in In Progress. 0 = no new implementation is dispatched. Does not limit PMO/Reviewer/Orchestrator. Hot: the next tick already respects the value.",
  },
  {
    key: "MAX_REVIEWER_WORKERS",
    group: "Capacity",
    type: "number",
    default: 1,
    scope: "config",
    validate: nonNegativeInt("MAX_REVIEWER_WORKERS"),
    description:
      "How many Reviewer agents (Code Review → In Review) may run at the same time. Counts issues in In Review. 0 = no new review is dispatched. Hot: the next tick already respects the value.",
  },
  {
    key: "MAX_ORCHESTRATOR_WORKERS",
    group: "Capacity",
    type: "number",
    default: 1,
    scope: "config",
    validate: nonNegativeInt("MAX_ORCHESTRATOR_WORKERS"),
    description:
      "How many Orchestrators in merge mode may run at the same time. 0 = no automatic merge is dispatched. In practice merges remain serialized by a safety mutex (avoiding two conflicting merges); this ceiling also applies (and 0 turns it off). Synchronous footprint planning does not consume this seat. Hot: the next tick already respects the value.",
  },
];

const reliabilityGroup: SettingMeta[] = [
  {
    key: "MAX_ATTEMPTS",
    group: "Reliability & merge",
    type: "number",
    default: 3,
    scope: "config",
    validate: positiveInt("MAX_ATTEMPTS"),
    description:
      "Circuit breaker: after N rework cycles without approval, the issue goes to Blocked (human decision) instead of looping.",
  },
  {
    key: "REFINING_TIMEOUT_MS",
    group: "Reliability & merge",
    type: "duration_ms",
    default: 600_000,
    scope: "config",
    validate: positiveInt("REFINING_TIMEOUT_MS"),
    description:
      "INACTIVITY timeout of the refinement seat (not total duration): with trace (ACP harnesses), the seat is only reclaimed after this long without ANY event from the run. Without trace (Hermes), total time in the phase applies.",
  },
  {
    key: "IN_PROGRESS_TIMEOUT_MS",
    group: "Reliability & merge",
    type: "duration_ms",
    default: 2_700_000,
    scope: "config",
    validate: positiveInt("IN_PROGRESS_TIMEOUT_MS"),
    description: "Inactivity timeout of the implementation seat (same semantics as REFINING_TIMEOUT_MS).",
  },
  {
    key: "IN_REVIEW_TIMEOUT_MS",
    group: "Reliability & merge",
    type: "duration_ms",
    default: 1_200_000,
    scope: "config",
    validate: positiveInt("IN_REVIEW_TIMEOUT_MS"),
    description: "Inactivity timeout of the review seat (same semantics as REFINING_TIMEOUT_MS).",
  },
  {
    key: "MERGE_TIMEOUT_MS",
    group: "Reliability & merge",
    type: "duration_ms",
    default: 900_000,
    scope: "config",
    validate: positiveInt("MERGE_TIMEOUT_MS"),
    description: "Inactivity timeout of the merge seat (same semantics as REFINING_TIMEOUT_MS).",
  },
  {
    key: "AUTO_MERGE_ISSUES",
    group: "Reliability & merge",
    type: "boolean",
    default: false,
    scope: "config",
    description:
      "Automatic merge on reaching Pending Merge. Default false: the merge is only dispatched when the issue ALSO has the ready-to-merge label (human gate). true = Pending Merge is enough. Independent from AUTO_DISPATCH_ISSUES (which only covers refine/implement).",
  },
  {
    key: "AUTO_DISPATCH_ISSUES",
    group: "Reliability & merge",
    type: "boolean",
    default: false,
    scope: "config",
    description:
      "Automatic dispatch by status on the entry stages (refinement and implementation). Default false: To Do only enters Refining with ready-to-refine; Planned only enters In Progress with ready-to-implement. true = the status is enough (still respects seats, deps, footprint and in-flight issues). Does not affect ready-to-merge (use AUTO_MERGE_ISSUES). Reopened and Code Review already dispatch by status alone.",
  },
];

const labelsGroup: SettingMeta[] = [
  {
    key: "LABEL_READY_TO_REFINE",
    group: "Curation labels",
    type: "string",
    default: "ready-to-refine",
    scope: "config",
    linearValidatable: "label",
    description:
      "Human gate into refinement. With AUTO_DISPATCH_ISSUES=false (default), the scheduler only pulls To Do issues into Refining when they ALSO carry this label. With AUTO_DISPATCH_ISSUES=true, To Do is enough. Status = source of truth; the label only restricts.",
  },
  {
    key: "LABEL_READY_TO_IMPLEMENT",
    group: "Curation labels",
    type: "string",
    default: "ready-to-implement",
    scope: "config",
    linearValidatable: "label",
    description:
      "Human gate between Planned and In Progress. With AUTO_DISPATCH_ISSUES=false (default), a Planned issue without this label stays queued. With AUTO_DISPATCH_ISSUES=true, Planned is enough (still respects deps/footprint/seats).",
  },
  {
    key: "LABEL_READY_TO_MERGE",
    group: "Curation labels",
    type: "string",
    default: "ready-to-merge",
    scope: "config",
    linearValidatable: "label",
    description:
      "Human gate between Pending Merge and the merge — only required when AUTO_MERGE_ISSUES=false. Independent from AUTO_DISPATCH_ISSUES. Without the label, the approved PR waits for a human to release the merge.",
  },
];

const STATE_DEFS: Array<[string, string, string]> = [
  ["STATE_TODO", "To Do", "Refinement queue — with AUTO_DISPATCH_ISSUES=false it is only pulled with ready-to-refine."],
  ["STATE_REFINING", "Refining", "PMO seat occupied (transient) — refinement in progress."],
  ["STATE_PLANNED", "Planned", "Refinement done; with AUTO_DISPATCH_ISSUES=false it waits for ready-to-implement."],
  ["STATE_IN_PROGRESS", "In Progress", "Dev seat occupied — implementation in progress."],
  ["STATE_CODE_REVIEW", "Code Review", "PR open waiting for review (dispatch by status alone)."],
  ["STATE_IN_REVIEW", "In Review", "Reviewer seat occupied — review in progress."],
  ["STATE_PENDING_MERGE", "Pending Merge", "Approved in review; waiting for merge (ready-to-merge gate when AUTO_MERGE_ISSUES=false)."],
  ["STATE_REOPENED", "Reopened", "Rejected in review/scope-check — goes back to Dev in fix mode (dispatch by status alone)."],
  ["STATE_COMPLETED", "Completed", "Merged — end of the pipeline."],
  ["STATE_BLOCKED", "Blocked", "Needs human help. The scheduler does NOT reconcile this state: the issue leaves the active pipeline (frees the seat) but keeps its footprint lock until a human resolves it."],
];

const statesGroup: SettingMeta[] = STATE_DEFS.map(([key, def, desc]) => ({
  key,
  group: "Linear states",
  type: "string" as const,
  default: def,
  scope: "config" as const,
  linearValidatable: "state" as const,
  description: `EXACT status name in your Linear workspace. ${desc}`,
}));

const dashboardGroup: SettingMeta[] = [
  {
    key: "DASHBOARD_RUN_RETENTION_DAYS",
    group: "Dashboard",
    type: "number",
    default: 30,
    scope: "config",
    validate: positiveInt("DASHBOARD_RUN_RETENTION_DAYS"),
    description: "Retention window for runs (+ events) in the database. The sweep runs every DASHBOARD_RETENTION_SWEEP_INTERVAL_MS.",
  },
  {
    key: "DASHBOARD_WEBHOOK_RETENTION_DAYS",
    group: "Dashboard",
    type: "number",
    default: 90,
    scope: "config",
    validate: positiveInt("DASHBOARD_WEBHOOK_RETENTION_DAYS"),
    description: "Retention window for the webhook audit trail.",
  },
  {
    key: "DASHBOARD_LOG_RETENTION_DAYS",
    group: "Dashboard",
    type: "number",
    default: 7,
    scope: "config",
    validate: positiveInt("DASHBOARD_LOG_RETENTION_DAYS"),
    description: "Retention window for persisted log lines (log_lines). Logs generate far more volume — smaller window.",
  },
  {
    key: "DASHBOARD_RETENTION_SWEEP_INTERVAL_MS",
    group: "Dashboard",
    type: "duration_ms",
    default: 3_600_000,
    scope: "config",
    validate: positiveInt("DASHBOARD_RETENTION_SWEEP_INTERVAL_MS"),
    description: "Interval of the retention sweep (deletes runs/webhooks/logs outside the windows above).",
  },
  {
    key: "DASHBOARD_LOG_BUFFER_SIZE",
    group: "Dashboard",
    type: "number",
    default: 5000,
    scope: "config",
    requiresRestart: true,
    validate: positiveInt("DASHBOARD_LOG_BUFFER_SIZE"),
    description:
      "How many log lines stay in the in-memory ring buffer (initial load of the Logs screen before SSE takes over the tail). The buffer is created at boot — applied on next restart.",
  },
];

const backendGroup: SettingMeta[] = [
  {
    key: "AGENT_BACKEND",
    group: "Agent backend (fallback)",
    type: "enum",
    enumValues: ["hermes", "goose"],
    default: "hermes",
    scope: "config",
    requiresRestart: true,
    description:
      "Which backend executes pipeline roles when the role has no active Agent configured (hermes = HTTP fire-and-report; goose = ACP with full trace). The ACTIVE AGENT of each role decides the harness — this variable is only a compatibility fallback.",
  },
];

const harnessGroup: SettingMeta[] = [
  {
    key: "WORKSPACE_ROOT",
    group: "Agent workspaces",
    type: "string",
    default: "$YAOE_HOME/worktrees",
    scope: "harness",
    description:
      "BASE directory of the run workspaces (absolute). Every run operates in an exclusive subdirectory (run-<runId>), created at dispatch and removed at the end — concurrent runs never clone into the same place. Empty = $YAOE_HOME/worktrees.",
  },
  {
    key: "GOOSE_BIN",
    group: "Harness Goose / OpenRouter",
    type: "string",
    default: "goose",
    scope: "harness",
    description: "Goose binary (the backend spawns `<bin> acp` per dispatch).",
  },
  {
    key: "GOOSE_RECIPES_DIR",
    group: "Harness Goose / OpenRouter",
    type: "string",
    default: resolve(APP_ROOT, "..", "recipes"),
    scope: "harness",
    description: "Directory with the <recipe>.yaml files (turned into a deeplink on ACP newSession). Agents configured in the dashboard build their recipe at runtime from the database instead.",
  },
  {
    key: "GOOSE_REQUEST_TIMEOUT_MS",
    group: "Harness Goose / OpenRouter",
    type: "duration_ms",
    default: 2_700_000,
    scope: "harness",
    description: "Ceiling of a single Goose turn (prompt). Keep it ≥ the largest seat *_TIMEOUT_MS.",
  },
  {
    key: "GOOSE_PROMPT_RETRIES",
    group: "Harness Goose / OpenRouter",
    type: "number",
    default: 2,
    scope: "harness",
    description:
      "Retries (in the SAME session, context preserved) when the model provider fails transiently (empty response, rate limit…). 0 disables; once exhausted, the run becomes failed.",
  },
  {
    key: "GOOSE_KEEP_WORKSPACES",
    group: "Harness Goose / OpenRouter",
    type: "boolean",
    default: false,
    scope: "harness",
    description: "true keeps the run workspace on disk after it ends (debugging). Default removes it — workspaces are ephemeral by design.",
  },
  {
    key: "GOOSE_ENV_FILE",
    group: "Harness Goose / OpenRouter",
    type: "string",
    default: "",
    scope: "harness",
    description: "EXTRA .env forwarded to the `goose acp` process, on top of the service environment. Useful for agent-only secrets.",
  },
  {
    key: "GOOSE_PROVIDER",
    group: "Harness Goose / OpenRouter",
    type: "string",
    default: "openrouter",
    scope: "harness",
    description:
      "Model provider for Goose. openrouter | openai-compatible (base URL + key + model, covering self-hosted gateways/LiteLLM/vLLM — without cost reconciliation).",
  },
  {
    key: "OPENROUTER_API_KEY",
    group: "Harness Goose / OpenRouter",
    type: "string",
    default: "",
    secret: true,
    scope: "harness",
    description: "OpenRouter API key (BYOK) used by Goose and by cost reconciliation.",
  },
  {
    key: "OPENROUTER_RECONCILE",
    group: "Harness Goose / OpenRouter",
    type: "boolean",
    default: true,
    scope: "harness",
    description:
      "Cost reconciliation: the local proxy captures generation ids and, when the run ends, GET /generation sums official tokens/cost into the dashboard.",
  },
  {
    key: "OPENROUTER_PROXY_PORT",
    group: "Harness Goose / OpenRouter",
    type: "number",
    default: 4792,
    scope: "harness",
    description: "Port of the local OpenRouter proxy (generation-id capture).",
  },
  {
    key: "OPENROUTER_UPSTREAM",
    group: "Harness Goose / OpenRouter",
    type: "string",
    default: "https://openrouter.ai",
    url: true,
    scope: "harness",
    description: "Real upstream of the OpenRouter proxy.",
  },
  {
    key: "OPENROUTER_AUTO_ROUTER",
    group: "Harness Goose / OpenRouter",
    type: "boolean",
    default: false,
    scope: "harness",
    description: "Auto Router (openrouter/auto-beta) per recipe — see docs/openrouter-presets.md.",
  },
  {
    key: "OPENROUTER_AUTO_CONFIG",
    group: "Harness Goose / OpenRouter",
    type: "json",
    default: "",
    scope: "harness",
    validate: validateAutoConfig,
    description:
      'Per-recipe Auto Router config (JSON array; each entry with "recipeName" and options such as allowed_models/cost_quality_tradeoff).',
  },
  {
    key: "HINDSIGHT_API_KEY",
    group: "Harness Goose / OpenRouter",
    type: "string",
    default: "",
    secret: true,
    scope: "harness",
    description:
      "Hindsight API key (agent memory via MCP), forwarded to Goose and used in the MCP Authorization header. Only relevant with the Hindsight extension enabled in the recipe.",
  },
  {
    key: "HERMES_BASE_URL",
    group: "Harness Hermes",
    type: "string",
    default: "http://hermes:3000",
    url: true,
    scope: "harness",
    description: "Shared Hermes gateway (every profile on the same URL; the profile is chosen by the model field).",
  },
  {
    key: "HERMES_API_KEY",
    group: "Harness Hermes",
    type: "string",
    default: "",
    secret: true,
    scope: "harness",
    description: "API_SERVER_KEY of the Hermes gateway.",
  },
  {
    key: "CURSOR_ISOLATE_MCP_CONFIG",
    group: "Harness Cursor",
    type: "boolean",
    default: true,
    scope: "harness",
    description:
      "Runs `cursor-agent acp` with a per-run HOME (symlink mirror of the real HOME). Neutralizes the machine's ~/.cursor/mcp.json — without this the run inherits your personal MCPs and the provider refuses the turn with \"Too many MCP tools are enabled for this model\" — and isolates git/gh: ~/.gitconfig enters as a COPY, ~/.config/gh as an empty directory (GH_CONFIG_DIR) and ~/.git-credentials stays out, so the agent's `gh auth login`/`git config --global` never touch the host files. The agent's MCPs still enter via session/new; the git credential comes from the run token. Disable only if you deliberately want the host MCPs and git config.",
  },
  {
    key: "CURSOR_ATTRIBUTION",
    group: "Harness Cursor",
    type: "boolean",
    default: true,
    scope: "harness",
    description:
      "Add Cursor attribution/co-authorship to commits and PRs. Writes `attribution.attributeCommitsToAgent` / `attributePRsToAgent` in the run's HOME/CURSOR_CONFIG_DIR cli-config.json (does not touch the host ~/.cursor). Default true = Cursor CLI native behavior.",
  },
  {
    key: "CLAUDE_CODE_ATTRIBUTION",
    group: "Harness Claude Code",
    type: "boolean",
    default: true,
    scope: "harness",
    description:
      "Add Claude Code attribution/co-authorship to commits and PRs. Builds a per-run CLAUDE_CONFIG_DIR with `attribution.commit`/`pr` (empty disables) and `includeCoAuthoredBy`. Default true. Does not touch the host ~/.claude.",
  },
  {
    key: "CODEX_ATTRIBUTION",
    group: "Harness Codex",
    type: "boolean",
    default: true,
    scope: "harness",
    description:
      "Add Codex attribution/co-authorship to commits. Builds a per-run CODEX_HOME and sets `commit_attribution` in config.toml (`\"\"` disables). Default true = Codex native trailer. Does not touch the host ~/.codex.",
  },
];

const agentGroup: SettingMeta[] = [
  ...ROLES.map<SettingMeta>((role) => ({
    key: `GOOSE_${role}_RECIPE`,
    group: "Per-role agents (seed only — superseded by the Agent entity)",
    type: "string",
    default: role === "PMO" ? "pmo" : role === "DEV" ? "dev" : role === "REVIEWER" ? "reviewer" : "orchestrator",
    scope: "agent",
    description: `Name of the ${role.toLowerCase()} role .yaml (in GOOSE_RECIPES_DIR). Superseded by the agent's versioned SOUL in the database — only the seed reads this.`,
  })),
  {
    key: "GOOSE_MODEL",
    group: "Per-role agents (seed only — superseded by the Agent entity)",
    type: "string",
    default: "",
    scope: "agent",
    description: "Goose model (consumed by the goose process). Superseded by the model field of each agent's goose config.",
  },
  ...ROLES.map<SettingMeta>((role) => ({
    key: `HERMES_${role}_MODEL`,
    group: "Per-role agents (seed only — superseded by the Agent entity)",
    type: "string",
    default: role === "PMO" ? "pmo" : role === "DEV" ? "dev" : role === "REVIEWER" ? "reviewer" : "orchestrator",
    scope: "agent",
    description: `Hermes profile name for the ${role.toLowerCase()} role (= model id announced at /v1/models).`,
  })),
  ...ROLES.flatMap<SettingMeta>((role) => [
    {
      key: `HERMES_${role}_URL`,
      group: "Per-role agents (seed only — superseded by the Agent entity)",
      type: "string" as const,
      default: "",
      url: true,
      scope: "agent" as const,
      description: `Optional override: dedicated Hermes gateway for the ${role.toLowerCase()} role (one gateway per profile, on separate ports). Empty = uses HERMES_BASE_URL.`,
    },
    {
      key: `HERMES_${role}_KEY`,
      group: "Per-role agents (seed only — superseded by the Agent entity)",
      type: "string" as const,
      default: "",
      secret: true,
      scope: "agent" as const,
      description: `Optional override: API key of the ${role.toLowerCase()} role's dedicated gateway. Empty = uses HERMES_API_KEY.`,
    },
  ]),
];

/** Group order shown on the Config screen (bootstrap first). */
export const SETTINGS_REGISTRY: SettingMeta[] = [
  ...bootstrapGroup,
  ...serviceGroup,
  ...linearGroup,
  ...githubGroup,
  ...capacityGroup,
  ...reliabilityGroup,
  ...labelsGroup,
  ...statesGroup,
  ...dashboardGroup,
  ...backendGroup,
  ...harnessGroup,
  ...agentGroup,
];

const byKey = new Map(SETTINGS_REGISTRY.map((m) => [m.key, m]));

export function settingMeta(key: string): SettingMeta | undefined {
  return byKey.get(key);
}

// "harness"-scoped fields (Goose/OpenRouter/Hermes/Hindsight global
// credentials/parameters) are editable on the Harness screen; the Config
// screen shows the same value (same source, never two diverging truths).
// "agent" (GOOSE_<ROLE>_RECIPE, HERMES_<ROLE>_MODEL/_URL/_KEY, GOOSE_MODEL)
// stays read-only: superseded by the Agent entity — only the seed reads it.
export function isEditable(meta: SettingMeta): boolean {
  return meta.scope === "config" || meta.scope === "harness";
}
