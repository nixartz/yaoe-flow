/**
 * Footprint path matcher (Bun.Glob) — the shared core.
 *
 * It lives outside dag.ts because footprint-ancillary.ts needs it too (the
 * ancillary doc paths are configurable and arrive as globs), and dag.ts imports
 * footprint-ancillary — the cycle would be dag → ancillary → dag.
 *
 * Dialect: `**` is globstar (zero or more segments), a mid-path `*` is ONE
 * segment, and a trailing `/*` means the whole subtree (the SOUL convention
 * `<module>/*` as a directory ceiling/lock).
 */
import { Glob } from "bun";

export function cleanPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function hasGlobMeta(p: string): boolean {
  return /[*?\[]/.test(p);
}

/** Trailing `/*` (exactly one star) → `/**` so `<module>/*` covers the whole tree. */
export function toGlobPattern(entry: string): string {
  const p = cleanPath(entry);
  if (/\/\*$/.test(p) && !/\/\*\*$/.test(p)) return `${p.slice(0, -1)}**`;
  return p;
}

// Is a concrete file "inside" a footprint entry?
//   isWithinFootprint("src/auth/login.ts", "src/auth/*")           → true (subtree)
//   isWithinFootprint("src/auth/deep/x.ts", "src/auth/*")          → true (trailing /* = recursive)
//   isWithinFootprint("src/app/perfil/page.tsx", "src/app/**/perfil/**") → true (** = empty ok)
//   isWithinFootprint("src/api/x.ts", "src/auth/*")                → false
//   isWithinFootprint(anything, "*")                               → true (whole-repo lock)
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
