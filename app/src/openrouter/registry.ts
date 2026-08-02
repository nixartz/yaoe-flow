// Mapeia ids OpenRouter → runId da dashboard enquanto o goose está vivo.
// - session_id no body (goose ≥ 1.41) = runId
// - user / Agent-Session-Id (qualquer goose) = goose ACP sessionId
import { runExists } from "../dashboard/store";

const byOpenRouterSession = new Map<string, string>();
const byGooseSession = new Map<string, string>();
const runBindings = new Map<string, { openrouterSessionId?: string; gooseSessionId?: string }>();

export function registerOpenRouterRun(
  runId: string,
  ids: { openrouterSessionId?: string; gooseSessionId?: string }
): void {
  const prev = runBindings.get(runId) ?? {};
  const next = {
    openrouterSessionId: ids.openrouterSessionId ?? prev.openrouterSessionId,
    gooseSessionId: ids.gooseSessionId ?? prev.gooseSessionId,
  };
  if (prev.openrouterSessionId && prev.openrouterSessionId !== next.openrouterSessionId) {
    byOpenRouterSession.delete(prev.openrouterSessionId);
  }
  if (prev.gooseSessionId && prev.gooseSessionId !== next.gooseSessionId) {
    byGooseSession.delete(prev.gooseSessionId);
  }
  if (next.openrouterSessionId) byOpenRouterSession.set(next.openrouterSessionId, runId);
  if (next.gooseSessionId) byGooseSession.set(next.gooseSessionId, runId);
  // session_id injetado = runId — registra também o próprio id
  byOpenRouterSession.set(runId, runId);
  runBindings.set(runId, next);
}

export function unregisterOpenRouterRun(runId: string): void {
  const prev = runBindings.get(runId);
  if (prev?.openrouterSessionId) byOpenRouterSession.delete(prev.openrouterSessionId);
  if (prev?.gooseSessionId) byGooseSession.delete(prev.gooseSessionId);
  byOpenRouterSession.delete(runId);
  runBindings.delete(runId);
}

/** Resolve runId a partir do body OpenRouter (session_id e/ou user). */
export function resolveRunId(ids: { sessionId?: string | null; user?: string | null }): string | undefined {
  if (ids.sessionId) {
    const bySession = byOpenRouterSession.get(ids.sessionId);
    if (bySession) return bySession;
    // Contrato: session_id injetado = runId (registry, binding ou row no SQLite).
    if (runBindings.has(ids.sessionId) || runExists(ids.sessionId)) return ids.sessionId;
  }
  if (ids.user) {
    const byUser = byGooseSession.get(ids.user);
    if (byUser) return byUser;
  }
  return undefined;
}
