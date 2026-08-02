// Camada 2 de dependência: colisão de footprint (arquivos que duas tasks tocam).
// Versão simples por prefixo de path. Para produção, troque por um matcher de glob
// real (ex.: micromatch) se as tasks usarem padrões mais complexos.
import type { Footprint } from "./types";
import { isAncillaryScopePath } from "./footprint-ancillary";

function normalize(p: string): string {
  return p.replace(/\/\*+$/, "").replace(/\/+$/, "");
}

// Um arquivo concreto está "dentro" de uma entrada de footprint?
// Mesma noção de prefixo/glob de `footprintsCollide`, mas unidirecional
// (o arquivo precisa estar sob a entrada). Reutilizado pelo scope-check (scope.ts).
//   isWithinFootprint("src/auth/login.ts", "src/auth/*") → true
//   isWithinFootprint("src/api/x.ts",      "src/auth/*") → false
//   isWithinFootprint(qualquer,            "*")          → true (lock de repo inteiro)
export function isWithinFootprint(file: string, footprintEntry: string): boolean {
  const entry = normalize(footprintEntry);
  if (entry === "*" || entry === "") return true; // repo inteiro / sem restrição
  const f = normalize(file);
  return f === entry || f.startsWith(entry + "/");
}

// Separa o qualificador de repo ("repoA:src/x" → repo "repoA", path "src/x").
// Entrada sem ":" é legado mono-repo — vale para QUALQUER repo (mesma semântica
// de entriesForRepo em scope.ts), representado por repo = null.
function splitEntry(entry: string): { repo: string | null; path: string } {
  const idx = entry.indexOf(":");
  if (idx === -1) return { repo: null, path: normalize(entry) };
  return { repo: entry.slice(0, idx), path: normalize(entry.slice(idx + 1)) };
}

function entriesCollide(a: string, b: string): boolean {
  const ea = splitEntry(a);
  const eb = splitEntry(b);
  // Repos DIFERENTES (ambos qualificados) nunca colidem — namespaces distintos.
  // Se um lado é não-qualificado (null), vale pra qualquer repo → compara paths.
  if (ea.repo !== null && eb.repo !== null && ea.repo !== eb.repo) return false;
  // "*" (ou vazio) = repo inteiro → colide com qualquer path daquele repo. É o
  // caso do fallback de planning (["*"]), que DEVE serializar tudo — a comparação
  // por prefixo de string pura tratava "*" como um path comum e não colidia com
  // nada, o oposto do comportamento pretendido/documentado.
  if (ea.path === "*" || ea.path === "" || eb.path === "*" || eb.path === "") return true;
  const pathOverlap =
    ea.path === eb.path || ea.path.startsWith(eb.path + "/") || eb.path.startsWith(ea.path + "/");
  if (!pathOverlap) return false;
  // Overlap SÓ em paths ancillary (locks/config) não serializa — protocolo §8.1.
  // "*" já retornou acima; aqui só entradas concretas tipo "package-lock.json".
  if (isAncillaryScopePath(ea.path) && isAncillaryScopePath(eb.path)) return false;
  return true;
}

export function footprintsCollide(a: Footprint, b: Footprint): boolean {
  return a.some((x) => b.some((y) => entriesCollide(x, y)));
}

export function collidesWithActive(candidate: Footprint, active: Footprint[]): boolean {
  return active.some((fp) => footprintsCollide(candidate, fp));
}

/** Pares de entradas que de fato colidem entre dois footprints (pra diagnóstico). */
export function collidingEntryPairs(
  a: Footprint,
  b: Footprint
): { ours: string; theirs: string }[] {
  const pairs: { ours: string; theirs: string }[] = [];
  for (const x of a) {
    for (const y of b) {
      if (entriesCollide(x, y)) pairs.push({ ours: x, theirs: y });
    }
  }
  return pairs;
}
