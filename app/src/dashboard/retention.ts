// Sweep periódico de retenção — mantém o SQLite da dashboard num tamanho
// controlado. Roda no mesmo padrão do `tick()` do scheduler (setInterval),
// deletando por idade e fazendo VACUUM só de vez em quando (é caro).
import { config } from "../config";
import { log, errFields } from "../logger";
import { db } from "./db";
import * as store from "./store";

let sweeps = 0;
const VACUUM_EVERY_N_SWEEPS = 24; // com o default de 1h/sweep, ~1x/dia

// Rede de segurança (belt-and-suspenders) além de scheduler.ts (onStatusChange
// + reclaimStale já fecham runs órfãs pelos sinais normais — webhook do Linear
// e timeout de fase). Aqui é o último recurso: qualquer run que, por algum
// caminho não coberto, ainda esteja em running/dispatched bem além do maior
// timeout de fase configurado, é fechada como "timeout". A margem (3x) evita
// competir com o reclaim normal do scheduler.
function staleRunCutoffMs(): number {
  const R = config.reliability;
  return Math.max(R.refiningTimeoutMs, R.inProgressTimeoutMs, R.inReviewTimeoutMs, R.mergeTimeoutMs) * 3;
}

function sweepStaleRuns(now: number): void {
  const cutoff = now - staleRunCutoffMs();
  const stale = db()
    .query(`SELECT id FROM runs WHERE status IN ('running','dispatched') AND started_at < $cutoff`)
    .all({ $cutoff: cutoff }) as { id: string }[];
  if (!stale.length) return;
  for (const { id } of stale) {
    store.finishRun(id, { status: "timeout", error: "Fechado pelo sweep de segurança (nenhum sinal de término recebido)" });
  }
  log.dashboard.warn({ count: stale.length, cutoffMs: staleRunCutoffMs() }, "stale runs closed by safety-net sweep");
}

export function sweepRetention(): void {
  const now = Date.now();
  try {
    sweepStaleRuns(now);

    const runCutoff = now - config.dashboard.runRetentionDays * 86_400_000;
    const webhookCutoff = now - config.dashboard.webhookRetentionDays * 86_400_000;

    const staleRuns = db().query(`SELECT id FROM runs WHERE started_at < $cutoff`).all({ $cutoff: runCutoff }) as {
      id: string;
    }[];
    if (staleRuns.length) {
      const ids = staleRuns.map((r) => r.id);
      const placeholders = ids.map((_, i) => `$id${i}`).join(",");
      const params: Record<string, string> = {};
      ids.forEach((id, i) => (params[`$id${i}`] = id));
      db().query(`DELETE FROM run_events WHERE run_id IN (${placeholders})`).run(params);
      db().query(`DELETE FROM run_generations WHERE run_id IN (${placeholders})`).run(params);
      db().query(`DELETE FROM runs WHERE id IN (${placeholders})`).run(params);
      log.dashboard.info({ count: ids.length, runRetentionDays: config.dashboard.runRetentionDays }, "runs retention sweep");
    }

    const deletedWebhooks = db()
      .query(`DELETE FROM webhook_events WHERE received_at < $cutoff`)
      .run({ $cutoff: webhookCutoff });
    if (deletedWebhooks.changes) {
      log.dashboard.info(
        { count: deletedWebhooks.changes, webhookRetentionDays: config.dashboard.webhookRetentionDays },
        "webhooks retention sweep"
      );
    }

    const logCutoff = now - config.dashboard.logRetentionDays * 86_400_000;
    const deletedLogs = db().query(`DELETE FROM log_lines WHERE ts < $cutoff`).run({ $cutoff: logCutoff });
    if (deletedLogs.changes) {
      log.dashboard.info(
        { count: deletedLogs.changes, logRetentionDays: config.dashboard.logRetentionDays },
        "logs retention sweep"
      );
    }

    sweeps++;
    if (sweeps % VACUUM_EVERY_N_SWEEPS === 0) {
      db().exec("VACUUM;");
      log.dashboard.info("dashboard db vacuumed");
    }
  } catch (e) {
    log.dashboard.error(errFields(e), "retention sweep failed");
  }
}

export function startRetentionSweep(): void {
  setInterval(sweepRetention, config.dashboard.retentionSweepIntervalMs);
  log.dashboard.info(
    {
      runRetentionDays: config.dashboard.runRetentionDays,
      webhookRetentionDays: config.dashboard.webhookRetentionDays,
      sweepIntervalMs: config.dashboard.retentionSweepIntervalMs,
    },
    "retention sweep scheduled"
  );
}
