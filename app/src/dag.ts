// Camada 2 de dependência: colisão de footprint (arquivos que duas tasks tocam).
// Matcher: Bun.Glob — `**` is globstar (zero or more path segments), mid-path `*` is
// one segment. Dialect: a trailing `/*` means the whole subtree (same as `/**`),
// matching the SOUL convention `<module>/*` as a directory lock/ceiling.
import { Glob } from "bun";
import type { Footprint } from "./types";
import { isAncillaryScopePath } from "./footprint-ancillary";

function cleanPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasGlobMeta(p: string): boolean {
  return /[*?\[]/.test(p);
}

/** Trailing `/*` (exactly one star) → `/**` so `<module>/*` covers the whole tree. */
export function toGlobPattern(entry: string): string {
  const p = cleanPath(entry);
  if (/\/\*$/.test(p) && !/\/\*\*$/.test(p)) return `${p.slice(0, -1)}**`;
  return p;
}

/** Collapse wildcards to a concrete witness path (for collision membership checks). */
export function collapseGlobToPath(pattern: string): string {
  return (
    cleanPath(pattern)
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/\/+/g, "/")
      .replace(/^\//, "")
      .replace(/\/$/, "") || ""
  );
}

function literalPrefix(pattern: string): string {
  const p = toGlobPattern(pattern);
  const idx = p.search(/[*?\[]/);
  return cleanPath(idx === -1 ? p : p.slice(0, idx));
}

function literalPrefixesNest(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  // Leading globstar / empty literal → conservative: treat as whole-repo under that side.
  if (pa === "" || pb === "") return true;
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

// Um arquivo concreto está "dentro" de uma entrada de footprint?
//   isWithinFootprint("src/auth/login.ts", "src/auth/*")           → true (subtree)
//   isWithinFootprint("src/auth/deep/x.ts", "src/auth/*")          → true (trailing /* = recursive)
//   isWithinFootprint("src/app/perfil/page.tsx", "src/app/**/perfil/**") → true (** = empty ok)
//   isWithinFootprint("src/api/x.ts", "src/auth/*")                → false
//   isWithinFootprint(qualquer, "*")                               → true (lock de repo inteiro)
export function isWithinFootprint(file: string, footprintEntry: string): boolean {
  const entry = cleanPath(footprintEntry);
  if (entry === "*" || entry === "") return true;
  const f = cleanPath(file);
  const pattern = toGlobPattern(entry);

  if (!hasGlobMeta(pattern)) {
    return f === pattern || f.startsWith(`${pattern}/`);
  }

  if (new Glob(pattern).match(f)) return true;
  // `foo/**` does not match the directory node `foo` itself; the old prefix
  // dialect did. Only apply when the stem has no remaining wildcards (otherwise
  // `src/app/**/perfil/**` would invent a literal `**` prefix).
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    if (base && !hasGlobMeta(base) && f === base) return true;
  }
  return false;
}

// Separa o qualificador de repo ("repoA:src/x" → repo "repoA", path "src/x").
// Entrada sem ":" é legado mono-repo — vale para QUALQUER repo (mesma semântica
// de entriesForRepo em scope.ts), representado por repo = null.
function splitEntry(entry: string): { repo: string | null; path: string } {
  const idx = entry.indexOf(":");
  if (idx === -1) return { repo: null, path: cleanPath(entry) };
  return { repo: entry.slice(0, idx), path: cleanPath(entry.slice(idx + 1)) };
}

function entriesCollide(a: string, b: string): boolean {
  const ea = splitEntry(a);
  const eb = splitEntry(b);
  // Repos DIFERENTES (ambos qualificados) nunca colidem — namespaces distintos.
  // Se um lado é não-qualificado (null), vale pra qualquer repo → compara paths.
  if (ea.repo !== null && eb.repo !== null && ea.repo !== eb.repo) return false;
  // "*" (ou vazio) = repo inteiro → colide com qualquer path daquele repo. É o
  // caso do fallback de planning (["*"]), que DEVE serializar tudo.
  if (ea.path === "*" || ea.path === "" || eb.path === "*" || eb.path === "") return true;

  const overlap =
    isWithinFootprint(collapseGlobToPath(ea.path), eb.path) ||
    isWithinFootprint(collapseGlobToPath(eb.path), ea.path) ||
    (hasGlobMeta(ea.path) && hasGlobMeta(eb.path) && literalPrefixesNest(ea.path, eb.path));
  if (!overlap) return false;
  // Overlap SÓ em paths ancillary (locks/config) não serializa — protocolo §8.1.
  const aWitness = collapseGlobToPath(ea.path) || ea.path;
  const bWitness = collapseGlobToPath(eb.path) || eb.path;
  if (isAncillaryScopePath(aWitness) && isAncillaryScopePath(bWitness)) return false;
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
