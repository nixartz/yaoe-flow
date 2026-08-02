// Parser de linha do config.env (docs/daemon-binary.md §4/§5 Passo 1) — não
// testamos loadConfigEnvFile()/yaoeHome aqui de propósito: eles
// resolvem uma vez no import de config/bootstrap.ts (módulo ESM singleton,
// já avaliado antes deste teste rodar) e escrever em YAOE_HOME real
// tocaria o $HOME de quem roda a suíte — parseEnvLine é a parte pura/segura.
import { describe, expect, test } from "bun:test";
import { parseEnvLine } from "../src/config/bootstrap";

describe("parseEnvLine (config.env)", () => {
  test("KEY=VALUE simples", () => {
    expect(parseEnvLine("APP_ENCRYPTION_KEY=abc123")).toEqual(["APP_ENCRYPTION_KEY", "abc123"]);
  });

  test("ignora linha vazia", () => {
    expect(parseEnvLine("")).toBeNull();
    expect(parseEnvLine("   ")).toBeNull();
  });

  test("ignora comentário", () => {
    expect(parseEnvLine("# comentário")).toBeNull();
    expect(parseEnvLine("  # comentário indentado")).toBeNull();
  });

  test("ignora linha sem '='", () => {
    expect(parseEnvLine("sem igual aqui")).toBeNull();
  });

  test("remove aspas duplas do valor", () => {
    expect(parseEnvLine('HOST="0.0.0.0"')).toEqual(["HOST", "0.0.0.0"]);
  });

  test("remove aspas simples do valor", () => {
    expect(parseEnvLine("HOST='0.0.0.0'")).toEqual(["HOST", "0.0.0.0"]);
  });

  test("trima espaços ao redor de chave e valor", () => {
    expect(parseEnvLine("  PORT = 4790  ")).toEqual(["PORT", "4790"]);
  });

  test("valor vazio é válido (KEY=)", () => {
    expect(parseEnvLine("DASHBOARD_STATIC_DIR=")).toEqual(["DASHBOARD_STATIC_DIR", ""]);
  });

  test("valor com '=' extra preserva o restante", () => {
    expect(parseEnvLine("VALKEY_URL=redis://user:pass@host:6379?opt=1")).toEqual([
      "VALKEY_URL",
      "redis://user:pass@host:6379?opt=1",
    ]);
  });

  test("linha só com espaço antes do '#' ainda é comentário", () => {
    expect(parseEnvLine("   # nada")).toBeNull();
  });
});
