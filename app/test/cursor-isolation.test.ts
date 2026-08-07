// O critério de aceite do isolamento: depois de um run Cursor, o `~/.gitconfig`
// e o `gh auth` de quem roda o daemon têm que estar intactos. Aqui isso é
// verificado de verdade contra o filesystem — um HOME falso faz de host, e o
// teste ESCREVE no HOME isolado pra provar que a escrita não vaza.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_TMP_DIR } from "./setup";
import { isolatedCursorHome } from "../src/agent/harness/cursor";

const GITCONFIG = "[user]\n\tname = Pessoa Real\n\temail = pessoa@exemplo.com\n";
const GH_HOSTS = "github.com:\n  oauth_token: gho_token_pessoal\n";

/** HOME de mentira com o que o isolamento precisa tratar. */
function fakeHostHome(): string {
  const home = mkdtempSync(join(TEST_TMP_DIR, "fake-home-"));
  writeFileSync(join(home, ".gitconfig"), GITCONFIG);
  writeFileSync(join(home, ".git-credentials"), "https://user:senha@github.com\n");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), GH_HOSTS);
  mkdirSync(join(home, ".config", "outra-tool"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { pessoal: {} } }));
  writeFileSync(join(home, ".cursor", "sessions.json"), "{}");
  mkdirSync(join(home, "Library"), { recursive: true });
  return home;
}

function prepare(realHome: string) {
  const cwd = join(mkdtempSync(join(TEST_TMP_DIR, "run-ws-")), "run-1");
  mkdirSync(cwd, { recursive: true });
  return isolatedCursorHome(
    { runId: "run-1", cwd, settings: {}, env: { HOME: realHome } },
    { HOME: realHome, GITHUB_TOKEN: "ghs_token_do_run" }
  );
}

describe("Cursor — HOME isolado não vaza pro host", () => {
  test("git/gh do host ficam intactos mesmo com o agent escrevendo neles", () => {
    const realHome = fakeHostHome();
    const prep = prepare(realHome);
    const isolated = prep.env!.HOME!;
    expect(isolated).not.toBe(realHome);

    // .gitconfig é CÓPIA (não symlink): a identidade continua disponível pro
    // commit, mas `git config --global` do agent morre com o run.
    const isolatedGitconfig = join(isolated, ".gitconfig");
    expect(lstatSync(isolatedGitconfig).isSymbolicLink()).toBe(false);
    expect(readFileSync(isolatedGitconfig, "utf8")).toBe(GITCONFIG);
    writeFileSync(isolatedGitconfig, "[user]\n\tname = Agent Malandro\n");
    expect(readFileSync(join(realHome, ".gitconfig"), "utf8")).toBe(GITCONFIG);

    // `gh` aponta pro dir do run (vazio) — um `gh auth login` escreve aqui.
    const ghDir = join(isolated, ".config", "gh");
    expect(prep.env!.GH_CONFIG_DIR).toBe(ghDir);
    expect(lstatSync(ghDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(ghDir, "hosts.yml"))).toBe(false);
    writeFileSync(join(ghDir, "hosts.yml"), "github.com:\n  oauth_token: gho_do_agent\n");
    expect(readFileSync(join(realHome, ".config", "gh", "hosts.yml"), "utf8")).toBe(GH_HOSTS);

    // Credencial em disco do host não é exposta — a do run vem do env.
    expect(existsSync(join(isolated, ".git-credentials"))).toBe(false);
    expect(prep.env!.GH_TOKEN).toBe("ghs_token_do_run");

    prep.cleanup?.();
    expect(existsSync(isolated)).toBe(false);
    // Cleanup não segue symlink: o host continua inteiro.
    expect(readFileSync(join(realHome, ".gitconfig"), "utf8")).toBe(GITCONFIG);
    expect(existsSync(join(realHome, ".git-credentials"))).toBe(true);
    expect(existsSync(join(realHome, ".cursor", "sessions.json"))).toBe(true);
    rmSync(realHome, { recursive: true, force: true });
  });

  test("mantém o resto do HOME e do ~/.cursor, zerando só o mcp.json", () => {
    const realHome = fakeHostHome();
    const prep = prepare(realHome);
    const isolated = prep.env!.HOME!;

    // Library (keychain do Cursor) e o resto do .cursor seguem espelhados —
    // sem isso o `authenticate` do cursor-agent quebra.
    expect(existsSync(join(isolated, "Library"))).toBe(true);
    expect(existsSync(join(isolated, ".cursor", "sessions.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(isolated, ".cursor", "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });

    // O que estava em .config fora do `gh` continua acessível.
    expect(existsSync(join(isolated, ".config", "outra-tool"))).toBe(true);

    // Sem API key nos args padrão do prepare (a key entra via buildEnv + --api-key).
    expect(prep.args).toEqual(["acp"]);

    prep.cleanup?.();
    rmSync(realHome, { recursive: true, force: true });
  });

  test("com CURSOR_API_KEY nos args, passa --api-key antes de acp", () => {
    const realHome = fakeHostHome();
    const cwd = join(mkdtempSync(join(TEST_TMP_DIR, "run-ws-")), "run-1");
    mkdirSync(cwd, { recursive: true });
    const prep = isolatedCursorHome(
      { runId: "run-1", cwd, settings: {}, env: { HOME: realHome, CURSOR_API_KEY: "key_test" } },
      { HOME: realHome, CURSOR_API_KEY: "key_test" }
    );
    expect(prep.args).toEqual(["--api-key", "key_test", "acp"]);
    prep.cleanup?.();
    rmSync(realHome, { recursive: true, force: true });
  });
});
