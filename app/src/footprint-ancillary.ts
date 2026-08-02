/**
 * Paths ancillary (protocolo §8.1): colateral esperado de quase qualquer mudança.
 * Usado pelo scope-check e pelo matcher de colisão — módulo isolado pra evitar
 * ciclo dag ↔ scope.
 */
export function isAncillaryScopePath(file: string): boolean {
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

  return false;
}
