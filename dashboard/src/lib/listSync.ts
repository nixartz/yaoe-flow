// Helpers de merge idempotente pra listas alimentadas por poll + SSE
// (evita duplicatas/triplicatas quando o mesmo id chega das duas fontes).

/** Substitui o snapshot pela autoridade do poll (ids = verdade atual). */
export function replaceById<T extends { id: string | number }>(items: T[]): T[] {
  const map = new Map<string | number, T>();
  for (const item of items) map.set(item.id, item);
  return [...map.values()];
}

/** Insere ou atualiza por id; novos vão pro início. */
export function upsertById<T extends { id: string | number }>(prev: T[], item: T): T[] {
  const idx = prev.findIndex((r) => r.id === item.id);
  if (idx === -1) return [item, ...prev];
  const next = prev.slice();
  next[idx] = { ...prev[idx], ...item };
  return next;
}

/** Remove por id. */
export function removeById<T extends { id: string | number }>(prev: T[], id: string | number): T[] {
  return prev.filter((r) => r.id !== id);
}

/**
 * Merge de extras SSE com o snapshot do poll: extras que já estão no
 * snapshot são descartados; extras órfãos (ainda não no poll) permanecem.
 */
export function mergeExtrasWithSnapshot<T extends { id: string | number }>(
  extras: T[],
  snapshot: T[]
): T[] {
  const snapIds = new Set(snapshot.map((r) => r.id));
  return extras.filter((e) => !snapIds.has(e.id));
}
