// Git/gh no ambiente de um run — tudo process-scoped, nada escrito no host.
//
// Existia só dentro do goose (`withGitCredentials`); virou módulo próprio
// quando o isolamento do HOME do Cursor passou a quebrar os symlinks de
// `~/.gitconfig` / `~/.config/gh`: sem os arquivos do host, o agent perde a
// credencial que o `gh`/credential helper dava de graça, e a única fonte de
// auth que sobra é esta aqui.
import { join } from "node:path";

/**
 * Auth HTTPS pro `git` puro (clone/push via shell) — o MCP GitHub oficial usa
 * `GITHUB_TOKEN`, mas o `git` não lê env nenhuma pra credencial. Reescrever a
 * URL via `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (git ≥ 2.31) resolve SÓ no env
 * do processo do harness — nunca `git config --global`, então o token não toca
 * o disco do host. Serve igual pra PAT e pra installation token de App (os dois
 * autenticam como `x-access-token`).
 */
export function withGitHttpsInsteadOf(env: Record<string, string>, token: string | undefined): void {
  if (!token) return;
  const base = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env[`GIT_CONFIG_KEY_${base}`] = `url.https://x-access-token:${token}@github.com/.insteadOf`;
  env[`GIT_CONFIG_VALUE_${base}`] = "https://github.com/";
  env.GIT_CONFIG_COUNT = String(base + 1);
}

/**
 * Identidade de commit do run (modo GitHub App). Vai em `GIT_AUTHOR_*`/
 * `GIT_COMMITTER_*` em vez de `user.name`/`user.email` justamente porque env
 * ganha do `.gitconfig` sem precisar reescrever config nenhuma — e some junto
 * com o processo.
 */
export function withGitCommitterIdentity(
  env: Record<string, string>,
  identity: { name: string; email: string } | null | undefined
): void {
  if (!identity) return;
  env.GIT_AUTHOR_NAME = identity.name;
  env.GIT_AUTHOR_EMAIL = identity.email;
  env.GIT_COMMITTER_NAME = identity.name;
  env.GIT_COMMITTER_EMAIL = identity.email;
}

/**
 * Aponta o `gh` CLI pro HOME isolado do run. Sem isto, um `gh auth login` do
 * agent reescreve o `~/.config/gh/hosts.yml` da pessoa que roda o daemon — foi
 * o que motivou o isolamento. O `gh` já pega o token por `GH_TOKEN`/
 * `GITHUB_TOKEN` do env, então o diretório vazio não custa auth nenhuma.
 */
export function applyGhIsolation(env: Record<string, string>, homeDir: string): void {
  env.GH_CONFIG_DIR = join(homeDir, ".config", "gh");
  if (!env.GH_TOKEN && env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN;
}

/** Entradas do HOME real que NÃO podem virar symlink no HOME do run. */
export const HOST_GIT_ENTRIES_TO_ISOLATE = [".gitconfig", ".git-credentials", ".config"] as const;
