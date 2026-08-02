// `yaoe-flow status`: SUMMARIZED health — the faster/shallower sibling of
// doctor, meant to be run all the time (no round-trip to Linear/GitHub, only
// reports what is already configured/cached).
import Redis from "ioredis";
import { bootstrap } from "../config/bootstrap";
import { isYaoeProcess, isPidAlive, readPidFile } from "./paths";

async function daemonHealth(): Promise<{ ok: boolean; detail: string }> {
  const url = `http://${bootstrap.host}:${bootstrap.port}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { ok: res.ok, detail: url };
  } catch {
    return { ok: false, detail: url };
  }
}

async function valkeyHealth(): Promise<boolean> {
  const redis = new Redis(bootstrap.valkeyUrl, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export async function cmdStatus(): Promise<void> {
  const pid = readPidFile();
  const running = pid !== null && isPidAlive(pid) && isYaoeProcess(pid);
  console.log(`daemon:     ${running ? `running (PID ${pid})` : "stopped"}`);

  const health = await daemonHealth();
  console.log(`API:        ${health.ok ? "responding" : "no response"} — ${health.detail}`);

  const valkeyOk = await valkeyHealth();
  console.log(`Valkey:     ${valkeyOk ? "reachable" : "unreachable"} — ${bootstrap.valkeyUrl}`);

  try {
    const { config } = await import("../config");
    console.log(`scheduler:  ${config.orchestratorEnabled ? "enabled" : "OFF (ORCHESTRATOR_ENABLED=false)"}`);
    console.log(`Linear:     ${config.linear.apiKey ? `configured (team ${config.linear.teamKey || config.linear.teamId || "?"})` : "not configured"}`);
    console.log(`GitHub:     ${config.github.token ? "configured" : "not configured"}`);

    const { listWebhooks } = await import("../dashboard/store");
    const last = listWebhooks({ pageSize: 1 }).rows[0] as { received_at?: number; issue_identifier?: string } | undefined;
    console.log(
      last
        ? `webhook:    last event at ${new Date(last.received_at ?? 0).toISOString()} (${last.issue_identifier ?? "?"})`
        : "webhook:    no events received yet"
    );

    const { harnessReport } = await import("../agent/harness/detect");
    const report = harnessReport();
    console.log("harness:");
    for (const h of report) {
      const d = h.detection;
      const state = !d ? "not detected yet" : !d.installed ? "not installed" : `installed (${d.authStatus})`;
      console.log(`  - ${h.label}: ${state}`);
    }
  } catch (e) {
    console.log(`(failed to read config/database — ${String(e)}; run "yaoe-flow doctor" for a full diagnosis)`);
  }
}
