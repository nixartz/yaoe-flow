// Estado persistente em Valkey, isolado por Linear connection:
//  • LOCKS    — footprint travado de cada task EM ANDAMENTO (vivo até Completed
//               ou até reconcileStaleLocks no tick se o webhook se perder).
//               Hash field SEM TTL — Blocked pode segurar o lock por dias;
//               liberação é por evento (Completed) + self-heal no tick.
//  • FP       — cache do footprint estimado pelo planning pass.
//  • MERGING  — qual issue está em merge AGORA (serializa: um merge por connection).
//
// Prefixo: connectionId === "default" → `orch:*` (legado single-tenant);
// demais → `orch:conn:{connectionId}:*` pra não misturar locks entre orgs.
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { log, errFields } from "./logger";
import type { Footprint } from "./types";
import { DEFAULT_CONNECTION_ID } from "./db/linearConnections";

const redis = new Redis(config.valkey.url);

redis.on("connect", () => log.valkey.info({ url: config.valkey.url }, "valkey connected"));
redis.on("error", (e) => log.valkey.error(errFields(e), "valkey connection error"));
redis.on("close", () => log.valkey.warn("valkey connection closed"));

const SESSION_TTL_SECONDS = 14 * 24 * 3_600;

function keyPrefix(connectionId: string): string {
  if (!connectionId || connectionId === DEFAULT_CONNECTION_ID) return "orch:";
  return `orch:conn:${connectionId}:`;
}

function keys(connectionId: string) {
  const p = keyPrefix(connectionId);
  return {
    locks: `${p}locks`,
    fp: `${p}footprint`,
    merging: `${p}merging`,
    mergingAt: `${p}merging_at`,
    attempts: `${p}attempts`,
    started: `${p}started`,
    sessionPrefix: `${p}session:`,
    /** Snapshot de prontidão (candidatas + motivos) — TTL, refresh no tick. */
    readiness: `${p}readiness`,
    /** In-flight Orchestrator footprint estimate (SET NX + TTL). */
    estimatingPrefix: `${p}estimating:`,
    /** Per-issue/role dispatch lease (SET NX + TTL) — cross-process double-dispatch guard. */
    dispatchingPrefix: `${p}dispatching:`,
  };
}

/** TTL safety net if the process dies mid-estimate (daemon restart). */
export const ESTIMATING_TTL_SECONDS = 15 * 60;

/**
 * TTL safety net if the process dies mid-dispatch without reaching the
 * `finally` release — must comfortably outlast the longest legitimate run
 * (IN_PROGRESS_TIMEOUT_MS default is 45min, but that's an *inactivity* clock
 * that resets on every harness event, so a genuinely long, active run can
 * exceed it). 2h errs on the side of not stealing a live run's lock.
 */
export const DISPATCH_LOCK_TTL_SECONDS = 2 * 3_600;

const RELEASE_DISPATCH_LOCK_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Cross-process guard: at most one in-flight dispatch per (connection, issue,
 * role), even across daemon instances sharing the same Valkey — the in-memory
 * `activeRuns` map in agent/dispatch.ts only guards within a single process.
 * Returns an opaque ownership token on success (pass it to
 * releaseDispatchLock so a lease that already expired and was re-claimed by
 * another process can't be released out from under it), or null if another
 * process already holds the lease.
 */
export async function tryAcquireDispatchLock(
  connectionId: string,
  issueId: string,
  role: string
): Promise<string | null> {
  const key = `${keys(connectionId).dispatchingPrefix}${role}:${issueId}`;
  const token = randomUUID();
  const ok = await redis.set(key, token, "EX", DISPATCH_LOCK_TTL_SECONDS, "NX");
  if (ok === "OK") {
    log.valkey.info({ connectionId, issueId, role }, "dispatch lock acquired");
    return token;
  }
  log.valkey.warn({ connectionId, issueId, role }, "dispatch lock denied (already held by another process)");
  return null;
}

/** No-op if `token` no longer owns the lease (already expired + re-claimed). */
export async function releaseDispatchLock(
  connectionId: string,
  issueId: string,
  role: string,
  token: string
): Promise<void> {
  const key = `${keys(connectionId).dispatchingPrefix}${role}:${issueId}`;
  const removed = await redis.eval(RELEASE_DISPATCH_LOCK_IF_OWNER, 1, key, token);
  if (removed) log.valkey.info({ connectionId, issueId, role }, "dispatch lock released");
}

// ── Boot-time instance lock ──
// Defense in depth against two daemons accidentally pointed at the same
// YAOE_HOME + Valkey (e.g. a supervisor restart racing an old process that
// hasn't exited yet). Not connection-scoped — one lock for the whole process,
// renewed on every scheduler tick so a live daemon never loses it, and freed
// within RENEW-interval-ish of a crash (no renewal ⇒ TTL expiry).
const DAEMON_LOCK_KEY = "orch:daemon:lock";
const daemonInstanceToken = randomUUID();

const RENEW_DAEMON_LOCK_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  redis.call("pexpire", KEYS[1], ARGV[2])
  return 1
else
  return 0
end
`;

/** Best-effort: on a Valkey error, callers should treat this as "unknown" (proceed), not "denied". */
export async function acquireDaemonInstanceLock(leaseMs: number): Promise<boolean> {
  const ok = await redis.set(DAEMON_LOCK_KEY, daemonInstanceToken, "PX", leaseMs, "NX");
  if (ok === "OK") {
    log.valkey.info({ instanceId: daemonInstanceToken, leaseMs }, "daemon instance lock acquired");
    return true;
  }
  log.valkey.warn(
    { instanceId: daemonInstanceToken },
    "daemon instance lock DENIED — another process already holds it against this Valkey; dispatch/tick stay disabled on this instance until it's freed"
  );
  return false;
}

/** Returns false if another instance now owns the lock (this instance lost it — TTL lapsed without renewal). */
export async function renewDaemonInstanceLock(leaseMs: number): Promise<boolean> {
  const result = await redis.eval(RENEW_DAEMON_LOCK_IF_OWNER, 1, DAEMON_LOCK_KEY, daemonInstanceToken, leaseMs);
  return result === 1;
}

export async function acquireLock(connectionId: string, issueId: string, fp: Footprint): Promise<void> {
  const k = keys(connectionId);
  await redis.hset(k.locks, issueId, JSON.stringify(fp));
  log.valkey.info({ connectionId, issueId, footprint: fp }, "footprint lock acquired");
}

/**
 * Atomic claim of the footprint lock for a **new** implementation.
 * Returns false if this issue already holds a lock (lost a race with a twin
 * estimateThenDispatch / concurrent commit) — caller must NOT dispatch again.
 */
export async function tryAcquireLock(connectionId: string, issueId: string, fp: Footprint): Promise<boolean> {
  const k = keys(connectionId);
  const added = await redis.hsetnx(k.locks, issueId, JSON.stringify(fp));
  if (added === 1) {
    log.valkey.info({ connectionId, issueId, footprint: fp }, "footprint lock acquired (exclusive)");
    return true;
  }
  log.valkey.info({ connectionId, issueId }, "footprint lock claim lost (already held)");
  return false;
}

/** Reserve exclusive right to run the Orchestrator planning pass for this issue. */
export async function tryBeginEstimate(connectionId: string, issueId: string): Promise<boolean> {
  const key = `${keys(connectionId).estimatingPrefix}${issueId}`;
  const ok = await redis.set(key, "1", "EX", ESTIMATING_TTL_SECONDS, "NX");
  if (ok === "OK") {
    log.valkey.info({ connectionId, issueId, ttlSeconds: ESTIMATING_TTL_SECONDS }, "estimate reservation acquired");
    return true;
  }
  log.valkey.debug({ connectionId, issueId }, "estimate reservation denied (already in flight)");
  return false;
}

export async function isEstimating(connectionId: string, issueId: string): Promise<boolean> {
  return (await redis.exists(`${keys(connectionId).estimatingPrefix}${issueId}`)) === 1;
}

export async function clearEstimating(connectionId: string, issueId: string): Promise<void> {
  const removed = await redis.del(`${keys(connectionId).estimatingPrefix}${issueId}`);
  if (removed) log.valkey.info({ connectionId, issueId }, "estimate reservation cleared");
}

export async function releaseLock(connectionId: string, issueId: string): Promise<void> {
  const removed = await redis.hdel(keys(connectionId).locks, issueId);
  if (removed) log.valkey.info({ connectionId, issueId }, "footprint lock released");
}

export async function hasLock(connectionId: string, issueId: string): Promise<boolean> {
  return (await redis.hexists(keys(connectionId).locks, issueId)) === 1;
}

export async function activeFootprints(
  connectionId: string
): Promise<{ issueId: string; footprint: Footprint }[]> {
  const all = await redis.hgetall(keys(connectionId).locks);
  return Object.entries(all).map(([issueId, v]) => ({
    issueId,
    footprint: JSON.parse(v) as Footprint,
  }));
}

export async function getFootprint(connectionId: string, issueId: string): Promise<Footprint | null> {
  const v = await redis.hget(keys(connectionId).fp, issueId);
  return v ? (JSON.parse(v) as Footprint) : null;
}

export async function setFootprint(connectionId: string, issueId: string, fp: Footprint): Promise<void> {
  await redis.hset(keys(connectionId).fp, issueId, JSON.stringify(fp));
  log.valkey.info({ connectionId, issueId, footprint: fp }, "footprint cached");
}

export async function clearFootprint(connectionId: string, issueId: string): Promise<void> {
  const removed = await redis.hdel(keys(connectionId).fp, issueId);
  if (removed) log.valkey.info({ connectionId, issueId }, "footprint cache cleared");
}

export async function isMerging(connectionId: string): Promise<boolean> {
  return (await redis.exists(keys(connectionId).merging)) === 1;
}

export async function setMerging(connectionId: string, issueId: string): Promise<void> {
  const k = keys(connectionId);
  await redis.set(k.merging, issueId);
  await redis.set(k.mergingAt, Date.now());
  log.valkey.info({ connectionId, issueId }, "merge mutex acquired");
}

export async function mergingIssue(connectionId: string): Promise<string | null> {
  return redis.get(keys(connectionId).merging);
}

export async function mergingSince(connectionId: string): Promise<number | null> {
  const v = await redis.get(keys(connectionId).mergingAt);
  return v ? Number(v) : null;
}

export async function clearMergingIf(connectionId: string, issueId: string): Promise<void> {
  const cur = await redis.get(keys(connectionId).merging);
  if (cur === issueId) await clearMerging(connectionId);
}

export async function clearMerging(connectionId: string): Promise<void> {
  const k = keys(connectionId);
  const issueId = await redis.get(k.merging);
  await redis.del(k.merging);
  await redis.del(k.mergingAt);
  if (issueId) log.valkey.info({ connectionId, issueId }, "merge mutex released");
}

export async function bumpAttempts(connectionId: string, issueId: string): Promise<number> {
  const attempts = await redis.hincrby(keys(connectionId).attempts, issueId, 1);
  log.valkey.info({ connectionId, issueId, attempts }, "retry attempt incremented");
  return attempts;
}

export async function getAttempts(connectionId: string, issueId: string): Promise<number> {
  return Number((await redis.hget(keys(connectionId).attempts, issueId)) ?? 0);
}

export async function clearAttempts(connectionId: string, issueId: string): Promise<void> {
  const removed = await redis.hdel(keys(connectionId).attempts, issueId);
  if (removed) log.valkey.info({ connectionId, issueId }, "retry attempts cleared");
}

export async function markStarted(connectionId: string, issueId: string): Promise<void> {
  const at = Date.now();
  await redis.hset(keys(connectionId).started, issueId, at);
  log.valkey.debug({ connectionId, issueId, startedAt: at }, "seat liveness clock started");
}

export async function getStarted(connectionId: string, issueId: string): Promise<number | null> {
  const v = await redis.hget(keys(connectionId).started, issueId);
  return v ? Number(v) : null;
}

export async function clearStarted(connectionId: string, issueId: string): Promise<void> {
  const removed = await redis.hdel(keys(connectionId).started, issueId);
  if (removed) log.valkey.debug({ connectionId, issueId }, "seat liveness clock cleared");
}

export async function recordSession(
  connectionId: string,
  issueId: string,
  harnessId: string,
  sessionId: string
): Promise<void> {
  await redis.set(
    `${keys(connectionId).sessionPrefix}${harnessId}:${issueId}`,
    sessionId,
    "EX",
    SESSION_TTL_SECONDS
  );
}

export async function getSession(
  connectionId: string,
  issueId: string,
  harnessId: string
): Promise<string | null> {
  return redis.get(`${keys(connectionId).sessionPrefix}${harnessId}:${issueId}`);
}

export async function clearSession(connectionId: string, issueId: string, harnessId: string): Promise<void> {
  await redis.del(`${keys(connectionId).sessionPrefix}${harnessId}:${issueId}`);
}

/** TTL de segurança: se o daemon cair, a chave some sozinha (refresh real = tick). */
export const READINESS_TTL_SECONDS = 15 * 60;

export async function setReadinessSnapshot(connectionId: string, snapshot: unknown): Promise<void> {
  await redis.set(keys(connectionId).readiness, JSON.stringify(snapshot), "EX", READINESS_TTL_SECONDS);
  log.valkey.debug({ connectionId }, "readiness snapshot stored");
}

export async function getReadinessSnapshot<T = unknown>(connectionId: string): Promise<T | null> {
  const v = await redis.get(keys(connectionId).readiness);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch (e) {
    log.valkey.warn({ connectionId, ...errFields(e) }, "invalid readiness snapshot JSON");
    return null;
  }
}
