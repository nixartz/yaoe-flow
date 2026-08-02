// Estado persistente em Valkey, isolado por Linear connection:
//  • LOCKS    — footprint travado de cada task EM ANDAMENTO (vivo até Completed).
//  • FP       — cache do footprint estimado pelo planning pass.
//  • MERGING  — qual issue está em merge AGORA (serializa: um merge por connection).
//
// Prefixo: connectionId === "default" → `orch:*` (legado single-tenant);
// demais → `orch:conn:{connectionId}:*` pra não misturar locks entre orgs.
import Redis from "ioredis";
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
  };
}

export async function acquireLock(connectionId: string, issueId: string, fp: Footprint): Promise<void> {
  const k = keys(connectionId);
  await redis.hset(k.locks, issueId, JSON.stringify(fp));
  log.valkey.info({ connectionId, issueId, footprint: fp }, "footprint lock acquired");
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
    log.valkey.warn({ connectionId, ...errFields(e) }, "readiness snapshot JSON inválido");
    return null;
  }
}
