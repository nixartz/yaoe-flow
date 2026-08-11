/**
 * Ancillary paths (protocol §8.1): expected collateral of almost any change.
 * Used by the scope-check and by the collision matcher — kept in its own module
 * to avoid a dag ↔ scope cycle.
 *
 * Lockfiles / toolchain / test companions are recognized by NAME PATTERN (they
 * are universal). Process docs — change bundle, OKF, CHANGELOG, ADR — are not:
 * they follow each repo's own convention (its `AGENTS.md`/`CLAUDE.md`, protocol
 * §14) — `knowledge/changes/**` here, `docs/changes/**` or `.okf/**` elsewhere.
 * Hence SCOPE_ANCILLARY_DOC_PATHS (ENV > db > default) instead of a hardcoded
 * list: with the wrong paths the scope-check rejects exactly the documentation
 * the repo's guide ordered the agent to write.
 */
import { config } from "./config";
import { isWithinFootprint } from "./footprint-glob";

export function isAncillaryScopePath(
  file: string,
  /** Doc-glob override (tests / callers outside the service). */
  docPaths?: readonly string[]
): boolean {
  const normalized = file.replace(/\\/g, "/");
  const base = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;

  // Lockfiles / resolved dependency graphs — regeneráveis.
  if (
    /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|go\.sum|Gemfile\.lock|flake\.lock|pnpm-workspace\.yaml)$/i.test(
      base
    )
  ) {
    return true;
  }

  // Manifests / toolchain config — deltas mínimos pra build/typecheck/lint.
  if (/^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|Gemfile|deno\.json|deno\.jsonc)$/i.test(base)) {
    return true;
  }
  if (/^tsconfig(\.[^/]+)?\.json$/i.test(base)) return true;
  if (/^jsconfig(\.[^/]+)?\.json$/i.test(base)) return true;
  if (
    /^(biome|prettier|eslint|stylelint|commitlint|vitest|jest|playwright|cypress|vite|rollup|webpack)\.config\.[cm]?[jt]sx?$/i.test(
      base
    )
  ) {
    return true;
  }
  if (/^\.eslintrc(\.|$)/i.test(base)) return true;
  if (/^\.prettierrc(\.|$)/i.test(base)) return true;
  if (/^\.eslintignore$/i.test(base) || /^\.prettierignore$/i.test(base)) return true;
  if (
    /^(biome\.json|biome\.jsonc|\.editorconfig|\.nvmrc|\.node-version|\.npmrc|\.yarnrc\.yml|\.tool-versions|\.bun-version)$/i.test(
      base
    )
  ) {
    return true;
  }

  // Test companions — Reviewer ainda valida se o ajuste é da feature.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/(^|\/)(__tests__|__mocks__|tests?|spec)(\/|$)/i.test(normalized)) return true;

  // Process docs required by the repo's own agent guide (AGENTS.md / CLAUDE.md →
  // OKF bundle, CHANGELOG, ADR). Not feature scope; listing them in ## Footprint
  // would false-collide every task that ships a change bundle.
  const patterns = docPaths ?? config.scope.ancillaryDocPaths;
  return patterns.some((pattern) => matchesDocPattern(normalized, pattern));
}

/**
 * Every pattern matches root-anchored AND at any depth — `CHANGELOG.md` also
 * covers `apps/web/CHANGELOG.md`, `knowledge/changes/**` also covers
 * `packages/api/knowledge/changes/...`. A monorepo keeps one change bundle per
 * package, and the scope-check sees paths relative to the PR repo's root.
 * Write `./CHANGELOG.md` to anchor for real.
 */
function matchesDocPattern(file: string, pattern: string): boolean {
  if (pattern.startsWith("./")) return isWithinFootprint(file, pattern.slice(2));
  if (isWithinFootprint(file, pattern)) return true;
  if (pattern.startsWith("**/")) return false;
  return isWithinFootprint(file, `**/${pattern}`);
}
