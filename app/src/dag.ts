// Camada 2 de dependência: colisão de footprint (arquivos que duas tasks tocam).
// Matcher: Bun.Glob — `**` is globstar (zero or more path segments), mid-path `*` is
// one segment. Dialect: a trailing `/*` means the whole subtree (same as `/**`),
// matching the SOUL convention `<module>/*` as a directory lock/ceiling.
// The matcher itself lives in footprint-glob.ts (shared with
// footprint-ancillary.ts, which also matches globs) — re-exported here because
// scope.ts and the tests import `isWithinFootprint`/`toGlobPattern` from this module.
import type { Footprint } from "./types";
import { isAncillaryScopePath } from "./footprint-ancillary";
import { cleanPath, hasGlobMeta, isWithinFootprint, toGlobPattern } from "./footprint-glob";

export { isWithinFootprint, toGlobPattern } from "./footprint-glob";

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

/**
 * The literal segment right after a pattern's FIRST globstar, when that
 * globstar sits immediately after the literal prefix (prefix, globstar,
 * segment, ...). Returns null when there's no such globstar, the next
 * segment is itself a wildcard, or the globstar is trailing (prefix +
 * globstar alone, which still matches everything under prefix — ambiguous
 * on purpose).
 */
function firstLiteralSegmentAfterLeadingGlobstar(pattern: string): string | null {
  const p = toGlobPattern(cleanPath(pattern));
  const prefix = literalPrefix(pattern);
  const rest = (prefix ? p.slice(prefix.length) : p).replace(/^\//, "");
  if (!rest.startsWith("**/")) return null;
  const nextSeg = rest.slice(3).split("/")[0];
  if (!nextSeg || hasGlobMeta(nextSeg)) return null;
  return nextSeg;
}

/**
 * Narrow, provable disjointness: two patterns sharing the exact same literal
 * prefix, both followed by `**` then a literal segment — if those segments
 * differ, no single path can satisfy both (a path segment can't equal two
 * different literal strings at once). Anything else (nested-but-unequal
 * prefixes, a `*`/`**` in that position) stays conservative (collides).
 */
function disjointAfterSharedGlobstar(a: string, b: string): boolean {
  if (literalPrefix(a) !== literalPrefix(b)) return false;
  const segA = firstLiteralSegmentAfterLeadingGlobstar(a);
  const segB = firstLiteralSegmentAfterLeadingGlobstar(b);
  if (segA === null || segB === null) return false;
  return segA !== segB;
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
    (hasGlobMeta(ea.path) &&
      hasGlobMeta(eb.path) &&
      literalPrefixesNest(ea.path, eb.path) &&
      !disjointAfterSharedGlobstar(ea.path, eb.path));
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
