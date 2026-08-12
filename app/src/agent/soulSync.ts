/**
 * Re-import of the SOULs shipped with the binary into the database.
 *
 * `seedAgentsFromSouls()` only runs while the `agents` table is EMPTY — by
 * design (it must never overwrite what an operator tuned on the dashboard).
 * The side effect: after an upgrade that changes `agents/*.SOUL.md`, every
 * existing install keeps dispatching the OLD prompt forever, with no way to
 * pick up the new one other than copy-pasting it version by version.
 *
 * This module is that path, for both surfaces (CLI `sync-souls` and the
 * dashboard button). Two phases on purpose — `planSoulSync()` is read-only and
 * describes exactly what WOULD change, `applySoulSync()` writes only after the
 * human confirmed that plan.
 *
 * Guarantees:
 *  • only the ACTIVE agent of each role is touched (custom variants are never
 *    rewritten behind the operator's back);
 *  • the previous SOUL is NEVER lost: `createVersion` is append-only, so the
 *    old text stays in the agent's history as its own version and can be
 *    reactivated from the dashboard (Agents → versions → activate);
 *  • no restart needed — dispatch resolves the active version per run.
 */
import { createHash } from "node:crypto";
import { activeAgentForRole, createVersion, type AgentVersionRow } from "../db/agents";
import { AGENT_ROLES, ROLE_METAS, readSoulFile, type AgentRole } from "./recipe/defaults";

export type SoulSyncStatus =
  /** DB text already equals the bundled seed — nothing to do. */
  | "up-to-date"
  /** Seed differs from the active version: a new version would be created. */
  | "outdated"
  /** No active agent for the role (nothing to update; the seed only lands via the first-boot seed). */
  | "no-agent"
  /** SOUL file missing from the bundle/checkout — cannot sync this role. */
  | "no-seed";

export interface SoulSyncEntry {
  role: AgentRole;
  /** `dev.SOUL.md` — where the seed comes from. */
  soulFile: string;
  status: SoulSyncStatus;
  agentId: string | null;
  agentName: string | null;
  /** Active version today (the one that would be preserved in history). */
  currentVersion: number | null;
  currentVersionComment: string | null;
  currentHash: string | null;
  currentLines: number | null;
  /** Version number the sync would create. */
  nextVersion: number | null;
  /** Identity of the SOUL being applied — sha256 prefix of the bundled text. */
  seedHash: string | null;
  seedLines: number | null;
}

export interface SoulSyncApplied {
  role: AgentRole;
  agentId: string;
  agentName: string;
  previousVersion: number | null;
  newVersion: number;
  versionId: string;
}

/** CRLF and trailing whitespace must not read as "the SOUL changed". */
function normalize(soul: string): string {
  return soul.replace(/\r\n/g, "\n").trimEnd();
}

function hash(soul: string): string {
  return createHash("sha256").update(normalize(soul)).digest("hex").slice(0, 12);
}

function lineCount(soul: string): number {
  return normalize(soul).split("\n").length;
}

function planForRole(role: AgentRole): SoulSyncEntry {
  const soulFile = ROLE_METAS[role].soulFile;
  const seed = readSoulFile(role);
  const active = activeAgentForRole(role);

  const base: SoulSyncEntry = {
    role,
    soulFile,
    status: "up-to-date",
    agentId: active?.agent.id ?? null,
    agentName: active?.agent.name ?? null,
    currentVersion: active?.version.version ?? null,
    currentVersionComment: active?.version.comment ?? null,
    currentHash: active ? hash(active.version.soulMarkdown) : null,
    currentLines: active ? lineCount(active.version.soulMarkdown) : null,
    nextVersion: null,
    seedHash: seed ? hash(seed) : null,
    seedLines: seed ? lineCount(seed) : null,
  };

  if (!seed) return { ...base, status: "no-seed" };
  if (!active) return { ...base, status: "no-agent" };
  if (normalize(active.version.soulMarkdown) === normalize(seed)) return base;
  return { ...base, status: "outdated", nextVersion: active.version.version + 1 };
}

/** Read-only: what a sync WOULD do, per role. Never writes. */
export function planSoulSync(roles: readonly AgentRole[] = AGENT_ROLES): SoulSyncEntry[] {
  return roles.map(planForRole);
}

export function isSyncable(entry: SoulSyncEntry): boolean {
  return entry.status === "outdated";
}

/**
 * Applies the plan: one new (active) version per outdated role, carrying the
 * bundled seed. Roles that are up-to-date / have no agent / have no seed are
 * skipped silently — re-planning inside the write keeps a stale plan from the
 * UI from ever overwriting something that changed in between.
 */
export function applySoulSync(opts: {
  roles?: readonly AgentRole[];
  createdBy: string | null;
  /** Free-text suffix for the version comment (e.g. "via dashboard"). */
  source: string;
}): SoulSyncApplied[] {
  const applied: SoulSyncApplied[] = [];
  for (const entry of planSoulSync(opts.roles ?? AGENT_ROLES)) {
    if (!isSyncable(entry) || !entry.agentId) continue;
    const seed = readSoulFile(entry.role);
    if (!seed) continue;
    const version: AgentVersionRow = createVersion(
      entry.agentId,
      seed,
      `sync-souls (${opts.source}): bundled agents/${entry.soulFile} @ ${entry.seedHash} — previous v${entry.currentVersion} kept in history`,
      opts.createdBy,
      { activate: true }
    );
    applied.push({
      role: entry.role,
      agentId: entry.agentId,
      agentName: entry.agentName ?? entry.role,
      previousVersion: entry.currentVersion,
      newVersion: version.version,
      versionId: version.id,
    });
  }
  return applied;
}

export function parseRoleFilter(raw: string | undefined): AgentRole[] {
  if (!raw?.trim()) return [...AGENT_ROLES];
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = wanted.filter((r) => !(AGENT_ROLES as readonly string[]).includes(r));
  if (unknown.length > 0) {
    throw new Error(`unknown role(s): ${unknown.join(", ")} — valid: ${AGENT_ROLES.join(", ")}`);
  }
  return wanted as AgentRole[];
}
