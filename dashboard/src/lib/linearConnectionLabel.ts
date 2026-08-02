/** Rótulo da connection Linear de um run (History / Live / detalhe). Preferir nome. */
export function linearConnectionLabel(run: {
  linear_connection_id?: string | null;
  linear_connection_name?: string | null;
}): string | null {
  if (run.linear_connection_name) return run.linear_connection_name;
  if (run.linear_connection_id === "default") return "Default";
  // Sem nome: devolve o Connection ID completo (nunca um pedaço de UUID sem rótulo).
  if (run.linear_connection_id) return run.linear_connection_id;
  return null;
}
