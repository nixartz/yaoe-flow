export type {
  ReadinessPhase,
  ReadinessStatus,
  ReadinessReasonCode,
  ReadinessDep,
  ReadinessReason,
  ReadinessIssue,
  ReadinessSeatCapacity,
  ReadinessSnapshot,
} from "./types";
export { READINESS_TTL_SECONDS } from "./types";
export { buildReadinessSnapshot } from "./evaluate";

import { log, errFields } from "../logger";
import type { LinearContext } from "../db/linearConnections";
import * as locks from "../locks";
import { buildReadinessSnapshot } from "./evaluate";
import type { ReadinessSnapshot } from "./types";

/** Avalia + grava no Valkey (best-effort — falha não derruba o tick). */
export async function refreshReadinessSnapshot(ctx: LinearContext): Promise<ReadinessSnapshot | null> {
  try {
    const snapshot = await buildReadinessSnapshot(ctx);
    await locks.setReadinessSnapshot(ctx.connectionId, snapshot);
    log.scheduler.info(
      {
        connectionId: ctx.connectionId,
        issueCount: snapshot.issues.length,
        byPhase: snapshot.issues.reduce<Record<string, number>>((acc, i) => {
          acc[i.phase] = (acc[i.phase] ?? 0) + 1;
          return acc;
        }, {}),
      },
      "readiness snapshot refreshed"
    );
    return snapshot;
  } catch (e) {
    log.scheduler.warn(
      { connectionId: ctx.connectionId, ...errFields(e) },
      "readiness snapshot failed (best-effort)"
    );
    return null;
  }
}

export async function loadReadinessSnapshot(connectionId: string): Promise<ReadinessSnapshot | null> {
  return locks.getReadinessSnapshot<ReadinessSnapshot>(connectionId);
}
