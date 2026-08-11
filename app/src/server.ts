import pkg from "../package.json" with { type: "json" };
import { config } from "./config";
import { onSettingChange } from "./config/service";
import { assertEncryptionKey, EncryptionKeyError } from "./db/secrets";
import { appDb } from "./db";
import { log, errFields, logLevel, setLogLevel, maskSecret } from "./logger";
import { tick } from "./scheduler";
import { maybeSeedDefaultConnection } from "./db/linearConnections";
import { backendName } from "./agent";
import { startDashboardServer } from "./dashboard/server";
import { startOpenRouterProxy } from "./openrouter";
import { seedAgentsFromSouls } from "./db/agents";
import { detectAllHarnesses } from "./agent/harness/detect";
import { versionInfo } from "./version";
import { ensureHarnessBinOnPath } from "./cli/setup/harnessDeps";
import { createOrchestratorApp } from "./api/orchestrator/app";
import { acquireDaemonInstanceLock, renewDaemonInstanceLock } from "./locks";
import { closeOrphanRunningRows } from "./dashboard/store";
/**
 * Sobe o serviço (API Hono + webhook + tick + dashboard + proxy OpenRouter) —
 * o MESMO entrypoint tanto pro boot direto (`bun src/index.ts`, Docker CMD,
 * sem argv) quanto pro CLI `yaoe-flow daemon` (docs/daemon-binary.md §4).
 *
 * Vive em módulo SEPARADO de index.ts de propósito: este arquivo (e tudo que
 * ele importa, em especial scheduler.ts, que lê `config.states` NO TOPO do
 * módulo) exige APP_ENCRYPTION_KEY/banco válidos só de ser IMPORTADO — se
 * index.ts importasse isso estaticamente, comandos leves da CLI como
 * `yaoe-flow version`/`status`/`doctor` (que devem rodar mesmo ANTES do
 * `yaoe-flow setup` existir) quebrariam só de o binário ser invocado.
 * index.ts importa este módulo dinamicamente, e só no caminho de boot.
 */
export async function bootServer(): Promise<void> {
  // ── Pré-boot (Fase 0): sem APP_ENCRYPTION_KEY o processo NÃO sobe (§5.2) e o
  // banco (com as migrations) abre ANTES de qualquer coisa ler config do serviço.
  try {
    assertEncryptionKey();
    appDb();
  } catch (e) {
    if (e instanceof EncryptionKeyError) {
      console.error(`\n[boot] ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  // ACPs/CLIs instalados pelo setup em ~/.yaoe-flow/harness/bin precisam
  // estar no PATH deste processo pra detect/spawn achar (sem depender do shell).
  ensureHarnessBinOnPath();

  // ── Instância única (defense in depth) ── Duas cópias do daemon apontando pro
  // mesmo YAOE_HOME+Valkey (ex.: supervisor reiniciando antes do processo velho
  // sair) não devem despachar em paralelo. Lease > 1 tick pra sobreviver a um
  // tick perdido; renovado a cada tick (abaixo). NÃO é um crash — se outra
  // instância já segura o lock, API/dashboard sobem normalmente, só tick/dispatch
  // ficam fora até o processo ser reiniciado. Erro de rede (Valkey fora) é
  // tratado como "desconhecido, segue" (fail-open) — não bloqueia o boot por algo
  // que já quebraria o resto do daemon de qualquer forma.
  const daemonLockLeaseMs = () => Math.max(config.tickIntervalMs * 3, 60_000);
  let instanceLockOwned = true;
  try {
    instanceLockOwned = await acquireDaemonInstanceLock(daemonLockLeaseMs());
  } catch (e) {
    log.server.warn(errFields(e), "daemon instance lock check failed (valkey unreachable?) — proceeding without exclusivity guarantee");
  }
  if (!instanceLockOwned) {
    log.server.warn(
      "another live process already holds the daemon instance lock for this YAOE_HOME/Valkey — reconciliation tick and agent dispatch stay OFF on this process until it is restarted (or the other instance stops)"
    );
  } else {
    // Só roda com exclusividade CONFIRMADA: se o lock foi negado (outra
    // instância viva) ou o check falhou (Valkey inacessível), linhas 'running'
    // podem pertencer legitimamente a um processo que ainda está de pé.
    const { closed } = closeOrphanRunningRows();
    if (closed > 0) {
      log.server.warn({ closed }, "closed orphan 'running' run rows left by a previous process (no Linear transition — self-heals via reconcileStaleLocks on the next tick)");
    }
  }

  // LOG_LEVEL editado pela tela Config aplica na hora (hot) — os demais settings
  // são lidos por getter a cada uso e não precisam de hook.
  onSettingChange((key, raw) => {
    if (key === "LOG_LEVEL") setLogLevel(raw);
  });

  const app = createOrchestratorApp();

  // Loop do tick com re-agendamento a cada iteração (em vez de setInterval fixo):
  // TICK_INTERVAL_MS e ORCHESTRATOR_ENABLED editados pela tela Config valem no
  // PRÓXIMO agendamento, sem restart (hot-reload — §5.4). O kill switch desligado
  // não para o loop, só pula o tick — religar volta a reconciliar sozinho.
  async function runScheduledTick(): Promise<void> {
    if (!(config.orchestratorEnabled && instanceLockOwned)) return;
    try {
      const stillOwned = await renewDaemonInstanceLock(daemonLockLeaseMs());
      if (!stillOwned) {
        instanceLockOwned = false;
        log.scheduler.error(
          "daemon instance lock lost (another process took over — this instance missed renewals past the lease) — dispatch/tick disabled until restart"
        );
        return;
      }
    } catch (e) {
      log.scheduler.warn(errFields(e), "daemon instance lock renewal failed (valkey unreachable?) — ticking anyway");
    }
    await tick().catch((e) => log.scheduler.error(errFields(e), "tick failed"));
  }
  function scheduleTick(): void {
    setTimeout(() => {
      runScheduledTick().finally(scheduleTick);
    }, config.tickIntervalMs);
  }
  scheduleTick();

  // ── Log de boot: tudo que precisa pra identificar QUAL versão/config subiu ──
  // (nome+versão do pacote, backend ativo, nível de log, credenciais carregadas —
  // mascaradas — e os recipes/perfis configurados) sem precisar entrar no container.
  const version = versionInfo();
  log.server.info(
    {
      name: pkg.name,
      version: version.version,
      commit: version.commit,
      bunVersion: Bun.version,
      logLevel,
      agentBackend: backendName(),
      port: config.port,
      tickIntervalMs: config.tickIntervalMs,
      orchestratorEnabled: config.orchestratorEnabled,
    },
    "orchestrator booting"
  );

  if (!config.orchestratorEnabled) {
    log.server.warn(
      "ORCHESTRATOR_ENABLED=false — reconciliation tick and agent dispatch are OFF; only the API (/health, /webhook/linear for audit) and the dashboard stay up"
    );
  }

  if (config.linear.teamKey || config.linear.teamId) {
    log.server.info(
      {
        teamKey: config.linear.teamKey || undefined,
        teamId: config.linear.teamId || undefined,
        apiKey: maskSecret(config.linear.apiKey),
        webhookSecret: maskSecret(config.linear.webhookSecret),
      },
      "linear configured"
    );
  } else {
    log.server.warn("LINEAR_TEAM_ID not set — pipeline will not filter by team");
  }

  log.server.info({ token: maskSecret(config.github.token) }, "github configured");

  if (backendName() === "goose") {
    log.server.info(
      {
        bin: config.goose.bin,
        recipesDir: config.goose.recipesDir,
        workingDir: config.goose.workingDir,
        recipes: config.goose.recipes,
      },
      "goose recipes configured"
    );
  } else {
    const profiles = Object.fromEntries(
      Object.entries(config.hermes.profiles).map(([role, p]) => [role, { url: p.url, model: p.model, apiKey: maskSecret(p.apiKey) }])
    );
    log.server.info({ profiles }, "hermes profiles configured");
  }

  log.server.info(
    {
      maxPmoWorkers: config.capacity.maxPmoWorkers,
      maxDevWorkers: config.capacity.maxDevWorkers,
      maxReviewerWorkers: config.capacity.maxReviewerWorkers,
      maxOrchestratorWorkers: config.capacity.maxOrchestratorWorkers,
    },
    "capacity configured"
  );

  // §6.6: as ENVs por papel foram substituídas pela entidade Agent (só o SEED
  // as lê agora) — warning de deprecação quando ainda estão setadas no ambiente.
  {
    const legacyAgentEnvs = [
      "GOOSE_MODEL",
      ...["PMO", "DEV", "WORKER", "REVIEWER", "ORCHESTRATOR"].flatMap((r) => [
        `GOOSE_${r}_RECIPE`,
        `HERMES_${r}_MODEL`,
        `HERMES_${r}_URL`,
        `HERMES_${r}_KEY`,
      ]),
    ].filter((k) => process.env[k] !== undefined);
    if (legacyAgentEnvs.length > 0) {
      log.server.warn(
        { envs: legacyAgentEnvs },
        "DEPRECATED: these per-role ENVs only feed the initial agent SEED — dispatch uses the Agent entity (database). Manage agents on the dashboard and remove these ENVs."
      );
    }
    if (process.env.AGENT_BACKEND !== undefined) {
      log.server.warn(
        "AGENT_BACKEND is legacy: the harness for each dispatch comes from the role's ACTIVE agent — this ENV only serves as a seed/compatibility fallback."
      );
    }
  }

  // Fase 1 (§6.2): seed dos 4 agentes a partir de agents/*.SOUL.md — no-op se a
  // tabela já tem linhas. Vive AQUI (não na dashboard) porque o dispatch depende
  // do agente ativo mesmo com DASHBOARD_ENABLED=false.
  try {
    seedAgentsFromSouls();
  } catch (e) {
    log.server.error(errFields(e), "seedAgentsFromSouls failed");
  }
  // Multi-Linear: se tabela vazia e LINEAR_* legado existe, cria connection Default.
  maybeSeedDefaultConnection().catch((e) =>
    log.server.warn(errFields(e), "maybeSeedDefaultConnection failed (best-effort)")
  );
  // Fase 2 (§7.4): detecção dos harness no boot (cacheada; "re-detectar" na UI).
  detectAllHarnesses().catch((e) => log.server.warn(errFields(e), "detectAllHarnesses failed (best-effort)"));

  log.server.info(
    { enabled: config.dashboard.enabled, port: config.dashboard.port },
    "dashboard configuration"
  );
  startDashboardServer();

  // Proxy OpenRouter: captura generation ids pra reconciliar custo. Incondicional
  // (no-op com OPENROUTER_RECONCILE=false): o harness ativo pode virar goose em
  // RUNTIME pela dashboard (§7.9) — o proxy precisa já estar de pé nesse momento.
  startOpenRouterProxy();

  // Bind explícito (em vez do `export default { fetch }` do Bun) — assim
  // controlamos o hostname (HOST/config.host) e evitamos o log automático do
  // Bun ("Started development server: ..."), que não respeita nosso Pino/HOST.
  Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch });
  log.server.info({ url: `http://${config.host}:${config.port}` }, "orchestrator listening");
}
