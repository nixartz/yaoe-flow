// Atribuição/co-autoria nos commits e PRs gerados pelos agentes ACP.
// Cada CLI tem o próprio mecanismo (docs oficiais):
//   Cursor      → ~/.cursor/cli-config.json  attribution.attributeCommitsToAgent / attributePRsToAgent
//   Claude Code → ~/.claude/settings.json   attribution.{commit,pr,sessionUrl}
//   Codex       → ~/.codex/config.toml      commit_attribution ("" desliga)
//
// Aplicamos no HOME/config dir do RUN (nunca no do host) pra o flag do
// orquestrador valer sem sobrescrever a preferência pessoal do operador.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Espelha entradas de um dir como symlink, pulando `skip`. */
export function mirrorDirExcept(realDir: string, targetDir: string, skip: readonly string[]): void {
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(realDir)) return;
  for (const entry of readdirSync(realDir)) {
    if (skip.includes(entry)) continue;
    try {
      symlinkSync(join(realDir, entry), join(targetDir, entry));
    } catch {
      /* entrada ilegível/sem permissão */
    }
  }
}

/**
 * Cursor CLI (`cli-config.json`):
 * https://cursor.com/docs/cli/reference/configuration
 * `attribution.attributeCommitsToAgent` / `attributePRsToAgent` (default true).
 */
export function writeCursorCliAttribution(cursorDir: string, enabled: boolean): void {
  mkdirSync(cursorDir, { recursive: true });
  const path = join(cursorDir, "cli-config.json");
  const existing = readJsonObject(path);
  const prevAttr =
    existing.attribution && typeof existing.attribution === "object" && !Array.isArray(existing.attribution)
      ? (existing.attribution as Record<string, unknown>)
      : {};
  const next = {
    version: typeof existing.version === "number" ? existing.version : 1,
    editor:
      existing.editor && typeof existing.editor === "object"
        ? existing.editor
        : { vimMode: false },
    permissions:
      existing.permissions && typeof existing.permissions === "object"
        ? existing.permissions
        : { allow: [] as string[], deny: [] as string[] },
    ...existing,
    attribution: {
      ...prevAttr,
      attributeCommitsToAgent: enabled,
      attributePRsToAgent: enabled,
    },
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Claude Code (`settings.json` sob CLAUDE_CONFIG_DIR):
 * https://code.claude.com/docs/en/settings#attribution-settings
 * `attribution.commit`/`pr` vazios + `sessionUrl: false` escondem tudo.
 */
export function writeClaudeCodeAttribution(configDir: string, enabled: boolean): void {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, "settings.json");
  const existing = readJsonObject(path);
  const next: Record<string, unknown> = { ...existing };
  if (enabled) {
    // Força o default (co-autoria ligada). Removemos um disable prévio do host.
    delete next.includeCoAuthoredBy;
    next.attribution = {
      commit: "Co-Authored-By: Claude <noreply@anthropic.com>",
      pr: "Generated with Claude Code",
      sessionUrl: true,
    };
  } else {
    next.includeCoAuthoredBy = false;
    next.attribution = { commit: "", pr: "", sessionUrl: false };
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Codex (`config.toml` sob CODEX_HOME):
 * `commit_attribution = ""` desliga; string custom / omitido = trailer padrão.
 * Reescreve só a chave — o resto do TOML do host (se houver cópia) permanece.
 */
export function writeCodexCommitAttribution(codexHome: string, enabled: boolean): void {
  mkdirSync(codexHome, { recursive: true });
  const path = join(codexHome, "config.toml");
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch {
    body = "";
  }
  const without = body
    .split("\n")
    .filter((line) => !/^\s*commit_attribution\s*=/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  // Habilitado: não força trailer custom — o default do Codex basta.
  // Desabilitado: string vazia (docs oficiais).
  const line = enabled ? "" : 'commit_attribution = ""';
  const next = [without, line].filter((s) => s.length > 0).join("\n\n") + "\n";
  writeFileSync(path, next);
}

export function hostHome(env: Record<string, string>): string {
  return env.HOME || process.env.HOME || homedir();
}
