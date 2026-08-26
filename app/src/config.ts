// Configuração central. A partir da Fase 0 do blueprint multi-harness, `config`
// deixou de ser um objeto CONGELADO no boot e virou uma fachada de GETTERS
// sobre o config service (src/config/service.ts): cada leitura resolve com
// precedência ENV > banco > default (D8), com cache invalidado em escrita.
// O shape público é o MESMO de antes — scheduler/backends/API não mudaram —
// mas mudar um campo pela tela Config passa a valer no próximo tick/dispatch
// sem restart (campos marcados requiresRestart no registry são a exceção).
//
// Bootstrap (§5.6): o que precisa existir ANTES do banco abrir (portas, paths,
// VALKEY_URL, APP_ENCRYPTION_KEY…) vem de src/config/bootstrap.ts — sempre e
// somente ENV.
//
// A família src/config/ (este arquivo + bootstrap.ts + registry.ts +
// service.ts) é a única autorizada a ler process.env (ver AGENTS.md).
import { bootstrap, expandYaoeHomePath } from "./config/bootstrap";
import * as svc from "./config/service";

// Cada papel do pipeline é um PERFIL do Hermes (`hermes profile create <model>`,
// com a nossa SOUL.md). Por padrão todos os papéis caem no MESMO gateway
// (HERMES_BASE_URL/HERMES_API_KEY) e se distinguem pelo `model` (= nome do
// perfil); HERMES_<PAPEL>_URL/_KEY sobrescrevem por papel (um gateway por
// perfil). Na Fase 1 isso migra pro settingsJson do harness hermes por agente.
function hermesProfile(role: string) {
  return {
    get url() {
      return svc.str(`HERMES_${role}_URL`) || svc.str("HERMES_BASE_URL");
    },
    get apiKey() {
      return svc.str(`HERMES_${role}_KEY`) || svc.str("HERMES_API_KEY");
    },
    get model() {
      return svc.str(`HERMES_${role}_MODEL`);
    },
  };
}

export const config = {
  host: bootstrap.host,
  port: bootstrap.port,

  get orchestratorEnabled() {
    return svc.bool("ORCHESTRATOR_ENABLED");
  },

  get httpTimeoutMs() {
    return svc.num("HTTP_TIMEOUT_MS");
  },

  linear: {
    get apiKey() {
      return svc.str("LINEAR_API_KEY");
    },
    get webhookSecret() {
      return svc.str("LINEAR_WEBHOOK_SECRET");
    },
    get teamId() {
      return svc.str("LINEAR_TEAM_ID");
    },
    get teamKey() {
      return svc.str("LINEAR_TEAM_KEY");
    },
  },

  // Qual "cérebro" executa os papéis. O scheduler fala só com a interface
  // AgentBackend (src/agent). Na Fase 2 vira fallback: o harness de cada
  // dispatch passa a ser decidido pelo agente ativo do papel.
  agent: {
    get backend() {
      return svc.str("AGENT_BACKEND") as "hermes" | "goose";
    },
  },

  hermes: {
    profiles: {
      pmo: hermesProfile("PMO"),
      dev: hermesProfile("DEV"),
      reviewer: hermesProfile("REVIEWER"),
      orchestrator: hermesProfile("ORCHESTRATOR"),
    },
  },

  // Reconciliação de custo OpenRouter: proxy local captura generation ids
  // (OPENROUTER_HOST do goose → 127.0.0.1:proxyPort) e, ao fim do run,
  // GET /api/v1/generation?id= soma tokens/custo oficiais na dashboard.
  openrouter: {
    get reconcile() {
      return svc.bool("OPENROUTER_RECONCILE");
    },
    get proxyPort() {
      return svc.num("OPENROUTER_PROXY_PORT");
    },
    get upstream() {
      // OPENROUTER_HOST é a env que o goose consome; quando aponta pro proxy
      // local, o upstream real vem de OPENROUTER_UPSTREAM (ou o default).
      const hostEnv = process.env.OPENROUTER_HOST ?? "";
      const looksLocal = /127\.0\.0\.1|localhost/.test(hostEnv);
      return process.env.OPENROUTER_UPSTREAM ?? (!looksLocal && hostEnv ? hostEnv : "https://openrouter.ai");
    },
    get apiKey() {
      return svc.str("OPENROUTER_API_KEY");
    },
    reconcileDelayMs: Number(process.env.OPENROUTER_RECONCILE_DELAY_MS ?? 2_000),
    reconcileRetries: Number(process.env.OPENROUTER_RECONCILE_RETRIES ?? 4),
    reconcileRetryMs: Number(process.env.OPENROUTER_RECONCILE_RETRY_MS ?? 1_500),
    get autoRouter() {
      return svc.bool("OPENROUTER_AUTO_ROUTER");
    },
    get autoConfigRaw() {
      return svc.str("OPENROUTER_AUTO_CONFIG");
    },
  },

  // Backend alternativo: Goose via ACP (spawna `goose acp`, JSON-RPC sobre
  // stdio). Semântica de cada campo: ver description no registry
  // (src/config/registry.ts) — é a mesma documentação exibida na tela Config.
  goose: {
    get bin() {
      return svc.str("GOOSE_BIN");
    },
    get recipesDir() {
      return svc.str("GOOSE_RECIPES_DIR");
    },
    get workingDir() {
      // Workspace root for EVERY harness: issue-scoped durable dirs under here
      // (`issue-<issueId>`), plus rare ephemeral `run-<runId>`. Default: $YAOE_HOME/worktrees.
      // Registry default is the literal "$YAOE_HOME/worktrees" — expand it, and
      // treat empty / placeholder as the bootstrap absolute path.
      const raw = expandYaoeHomePath(svc.str("WORKSPACE_ROOT"));
      if (!raw || raw === bootstrap.yaoeWorktreesDir) return bootstrap.yaoeWorktreesDir;
      // After expansion, still reject a leftover unexpanded placeholder.
      if (raw.includes("$YAOE_HOME")) return bootstrap.yaoeWorktreesDir;
      return raw;
    },
    get requestTimeoutMs() {
      return svc.num("GOOSE_REQUEST_TIMEOUT_MS");
    },
    get promptRetries() {
      return svc.num("GOOSE_PROMPT_RETRIES");
    },
    get keepWorkspaces() {
      return svc.bool("GOOSE_KEEP_WORKSPACES");
    },
    get envFile() {
      return svc.str("GOOSE_ENV_FILE");
    },
    recipes: {
      get pmo() {
        return svc.str("GOOSE_PMO_RECIPE");
      },
      get dev() {
        return svc.str("GOOSE_DEV_RECIPE");
      },
      get reviewer() {
        return svc.str("GOOSE_REVIEWER_RECIPE");
      },
      get orchestrator() {
        return svc.str("GOOSE_ORCHESTRATOR_RECIPE");
      },
    },
  },

  // Harness Cursor (`cursor-agent acp`) — ver description no registry.
  cursor: {
    get apiKey() {
      return svc.str("CURSOR_API_KEY");
    },
    get isolateMcpConfig() {
      return svc.bool("CURSOR_ISOLATE_MCP_CONFIG");
    },
    get attribution() {
      return svc.bool("CURSOR_ATTRIBUTION");
    },
  },

  claudeCode: {
    get attribution() {
      return svc.bool("CLAUDE_CODE_ATTRIBUTION");
    },
  },

  codex: {
    get attribution() {
      return svc.bool("CODEX_ATTRIBUTION");
    },
  },

  valkey: {
    url: bootstrap.valkeyUrl,
  },

  // GitHub — usado pelo scope-check determinístico p/ ler os arquivos da PR.
  github: {
    get token() {
      return svc.str("GITHUB_TOKEN");
    },
  },

  // Fail-safe anti-fork/repo-errado — ver descrição no registry.
  security: {
    get authorizedOrgs() {
      return svc
        .str("AGENT_AUTHORIZED_ORGS")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    },
  },

  // Deterministic scope-check (src/scope.ts) — what it lets through outside the
  // footprint besides locks/config/tests: the process docs each repo's AGENTS.md
  // / CLAUDE.md requires with every change (protocol §8.1/§14). Configurable
  // because every project stores its change bundle somewhere else.
  scope: {
    get ancillaryDocPaths() {
      return svc
        .str("SCOPE_ANCILLARY_DOC_PATHS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    },
  },

  capacity: {
    get maxPmoWorkers() {
      return svc.num("MAX_PMO_WORKERS");
    },
    get maxDevWorkers() {
      return svc.num("MAX_DEV_WORKERS");
    },
    get maxReviewerWorkers() {
      return svc.num("MAX_REVIEWER_WORKERS");
    },
    get maxOrchestratorWorkers() {
      return svc.num("MAX_ORCHESTRATOR_WORKERS");
    },
  },

  // Circuit breaker + timeouts de INATIVIDADE por seat — ver registry.
  reliability: {
    get maxAttempts() {
      return svc.num("MAX_ATTEMPTS");
    },
    get refiningTimeoutMs() {
      return svc.num("REFINING_TIMEOUT_MS");
    },
    get inProgressTimeoutMs() {
      return svc.num("IN_PROGRESS_TIMEOUT_MS");
    },
    get inReviewTimeoutMs() {
      return svc.num("IN_REVIEW_TIMEOUT_MS");
    },
    get mergeTimeoutMs() {
      return svc.num("MERGE_TIMEOUT_MS");
    },
    get quotaDefaultCooldownMs() {
      return svc.num("HARNESS_QUOTA_DEFAULT_COOLDOWN_MS");
    },
  },

  get autoMergeIssues() {
    return svc.bool("AUTO_MERGE_ISSUES");
  },

  get autoDispatchIssues() {
    return svc.bool("AUTO_DISPATCH_ISSUES");
  },

  // Opt-in bypasses of the two independent Planned → In Progress gates.
  // Default false = collision-freedom + Linear blockedBy still apply.
  // Hot: next tick/dispatch already reads the new value (no requiresRestart).
  get ignoreFootprintLocks() {
    return svc.bool("IGNORE_FOOTPRINT_LOCKS");
  },

  get ignoreBlockingIssues() {
    return svc.bool("IGNORE_BLOCKING_ISSUES");
  },

  // Labels (MUDANÇA 4). Regra de ouro: status = fonte da verdade; label nunca
  // decide sozinha.
  labels: {
    get readyToRefine() {
      return svc.str("LABEL_READY_TO_REFINE");
    },
    get readyToImplement() {
      return svc.str("LABEL_READY_TO_IMPLEMENT");
    },
    get readyToMerge() {
      return svc.str("LABEL_READY_TO_MERGE");
    },
    agentPrefix: "agent:",
  },

  // Nomes EXATOS dos status no workspace Linear (validáveis pela tela Config).
  states: {
    get todo() {
      return svc.str("STATE_TODO");
    },
    get refining() {
      return svc.str("STATE_REFINING");
    },
    get planned() {
      return svc.str("STATE_PLANNED");
    },
    get inProgress() {
      return svc.str("STATE_IN_PROGRESS");
    },
    get codeReview() {
      return svc.str("STATE_CODE_REVIEW");
    },
    get inReview() {
      return svc.str("STATE_IN_REVIEW");
    },
    get pendingMerge() {
      return svc.str("STATE_PENDING_MERGE");
    },
    get reopened() {
      return svc.str("STATE_REOPENED");
    },
    get completed() {
      return svc.str("STATE_COMPLETED");
    },
    get blocked() {
      return svc.str("STATE_BLOCKED");
    },
  },

  get tickIntervalMs() {
    return svc.num("TICK_INTERVAL_MS");
  },

  // ── Dashboard ──
  dashboard: {
    enabled: bootstrap.dashboardEnabled,
    port: bootstrap.dashboardPort,
    // DEPRECADAS — só alimentam o seed do primeiro admin (§5.3); depois são
    // ignoradas com warning. Login real: tabela users.
    user: process.env.DASHBOARD_USER ?? "",
    password: process.env.DASHBOARD_PASSWORD ?? "",
    sessionSecret: bootstrap.dashboardSessionSecret,
    dbPath: bootstrap.dashboardDbPath,
    staticDir: bootstrap.dashboardStaticDir,
    get runRetentionDays() {
      return svc.num("DASHBOARD_RUN_RETENTION_DAYS");
    },
    get webhookRetentionDays() {
      return svc.num("DASHBOARD_WEBHOOK_RETENTION_DAYS");
    },
    get logRetentionDays() {
      return svc.num("DASHBOARD_LOG_RETENTION_DAYS");
    },
    get retentionSweepIntervalMs() {
      return svc.num("DASHBOARD_RETENTION_SWEEP_INTERVAL_MS");
    },
    get logBufferSize() {
      return svc.num("DASHBOARD_LOG_BUFFER_SIZE");
    },
  },
};
