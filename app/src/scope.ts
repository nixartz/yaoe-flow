// Scope-check determinístico: a guarda mais forte do pipeline — NÃO depende do
// julgamento do LLM. Compara os arquivos efetivamente alterados na PR com o
// footprint travado da task. O que vazar é reprovado — exceto paths ancillary
// (locks/config/test companions), que o Reviewer ainda audita semanticamente
// (protocolo §8.1 / agents/COMMUNICATION_PROTOCOL.md).
import type { Footprint } from "./types";
import { isWithinFootprint } from "./dag";
import { isAncillaryScopePath } from "./footprint-ancillary";

export { isAncillaryScopePath } from "./footprint-ancillary";

// Resolve as entradas do footprint aplicáveis a UM repo.
// O footprint pode ser repo-qualificado: "api-bun-guesty-portals:bookings/saga/*".
//  • entrada com prefixo "repo:" → vale só para aquele repo (prefixo removido);
//  • entrada sem prefixo → vale para qualquer repo (footprint mono-repo legado).
function entriesForRepo(footprint: Footprint, repo: string): string[] {
  const out: string[] = [];
  for (const raw of footprint) {
    const idx = raw.indexOf(":");
    if (idx === -1) {
      out.push(raw); // sem qualificador de repo → aplica a qualquer repo
    } else if (raw.slice(0, idx) === repo) {
      out.push(raw.slice(idx + 1)); // qualificada para este repo
    }
  }
  return out;
}

// Retorna os arquivos que NÃO casam com nenhuma entrada do footprint daquele repo.
// changedFiles são paths relativos ao repo da PR; as entradas são normalizadas
// (prefixo de repo removido) antes de comparar via isWithinFootprint.
//
// Conservador por design: se o footprint não tem nenhuma entrada para este repo,
// todo arquivo NÃO-ancillary da PR é considerado fora (uma PR num repo
// não-declarado é vazamento). Ancillary (§8.1) nunca entra na lista.
export function filesOutsideFootprint(
  changedFiles: string[],
  footprint: Footprint,
  repo: string
): string[] {
  const entries = entriesForRepo(footprint, repo);
  return changedFiles.filter(
    (file) =>
      !isAncillaryScopePath(file) && !entries.some((entry) => isWithinFootprint(file, entry))
  );
}
