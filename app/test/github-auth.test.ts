// Mint/cache do installation token do GitHub App. Sem rede: o `fetch` global é
// substituído por um stub que conta chamadas — é o que prova que o cache
// funciona e que o refresh dispara pela expiração, não pelo relógio de parede.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { openAppDb } from "../src/db";
import { TEST_TMP_DIR } from "./setup";
import { createConnection, listConnections, toContext } from "../src/db/linearConnections";
import { clearGithubAuthCache, resolveGithubAuth, signAppJwt } from "../src/githubAuth";

openAppDb(join(TEST_TMP_DIR, "github-auth-tests.sqlite"));

const { privateKey: PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const realFetch = globalThis.fetch;

interface StubState {
  mintCalls: number;
  /** Validade devolvida pelo GitHub no próximo mint. */
  expiresInMs: number;
  lastJwt: string | null;
  /** Simula App sem permissão de ler a conta bot (identidade indisponível). */
  failUserLookup?: boolean;
}

function installFetchStub(state: StubState): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = String(
      (init?.headers as Record<string, string> | undefined)?.Authorization ?? ""
    ).replace(/^Bearer /, "");

    if (url.endsWith("/access_tokens")) {
      state.mintCalls += 1;
      state.lastJwt = auth;
      return new Response(
        JSON.stringify({
          token: `ghs_installation_${state.mintCalls}`,
          expires_at: new Date(Date.now() + state.expiresInMs).toISOString(),
        }),
        { status: 201 }
      );
    }
    if (url.endsWith("/app")) {
      return new Response(JSON.stringify({ id: 123456, slug: "hermes-orch", name: "Hermes" }), { status: 200 });
    }
    if (url.includes("/users/")) {
      if (state.failUserLookup) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ id: 987654 }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function appConnection(name: string, organizationId: string) {
  return createConnection({
    name,
    organizationId,
    apiKey: "lin_key_gha_xxxxxxxx",
    webhookSecret: "secret-gha-xxxxxxxx",
    githubAuthMode: "app",
    githubAppId: "123456",
    githubInstallationId: "77889900",
    githubAppPrivateKey: PEM,
  });
}

describe("signAppJwt", () => {
  test("assina RS256 verificável e respeita o teto de 10 min do GitHub", () => {
    const jwt = signAppJwt("123456", PEM);
    const [headerB64, payloadB64, signatureB64] = jwt.split(".");

    expect(JSON.parse(Buffer.from(headerB64!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(payload.iss).toBe("123456");
    // `iat` recuado absorve clock skew; a JANELA (exp - iat) não pode passar de 600s.
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);

    const ok = createVerify("RSA-SHA256")
      .update(`${headerB64}.${payloadB64}`)
      .verify(PUBLIC_PEM, Buffer.from(signatureB64!, "base64url"));
    expect(ok).toBe(true);
  });

  test("PEM inválida vira erro legível, não erro cru do OpenSSL", () => {
    expect(() => signAppJwt("123456", "nao-sou-uma-chave")).toThrow(/private key do GitHub App inválida/);
  });
});

describe("resolveGithubAuth — modo app", () => {
  let state: StubState;

  beforeEach(() => {
    for (const row of listConnections()) {
      const { deleteConnection } = require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
      deleteConnection(row.id);
    }
    clearGithubAuthCache();
    state = { mintCalls: 0, expiresInMs: 60 * 60 * 1000, lastJwt: null };
    installFetchStub(state);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("minta o token e resolve a identidade de commit do bot", async () => {
    const row = appConnection("AppOrg", "org-app-mint");
    const auth = await resolveGithubAuth(toContext(row));

    expect(auth.source).toBe("app");
    expect(auth.token).toBe("ghs_installation_1");
    // O número do e-mail é o id da CONTA <slug>[bot] (987654 no stub), NÃO o App
    // ID (123456) — com o número errado o commit fica sem atribuição.
    expect(auth.committer).toEqual({
      name: "hermes-orch[bot]",
      email: "987654+hermes-orch[bot]@users.noreply.github.com",
    });
    expect(state.lastJwt?.split(".")).toHaveLength(3);
  });

  test("token válido vem do cache — não minta duas vezes", async () => {
    const ctx = toContext(appConnection("AppCache", "org-app-cache"));
    await resolveGithubAuth(ctx);
    await resolveGithubAuth(ctx);
    expect(state.mintCalls).toBe(1);
  });

  test("token perto de expirar é renovado antes do uso", async () => {
    // 2 min de validade < janela de folga de 5 min → todo resolve remina.
    state.expiresInMs = 2 * 60 * 1000;
    const ctx = toContext(appConnection("AppExpira", "org-app-expira"));
    const first = await resolveGithubAuth(ctx);
    const second = await resolveGithubAuth(ctx);
    expect(state.mintCalls).toBe(2);
    expect(second.token).not.toBe(first.token);
  });

  test("cache é por connection — orgs diferentes não compartilham token", async () => {
    const a = toContext(appConnection("OrgA", "org-a-app"));
    const b = toContext(appConnection("OrgB", "org-b-app"));
    const tokenA = (await resolveGithubAuth(a)).token;
    const tokenB = (await resolveGithubAuth(b)).token;
    expect(tokenA).not.toBe(tokenB);
    expect(state.mintCalls).toBe(2);
  });

  test("falha na identidade não derruba o resolve (o token é o que autentica)", async () => {
    state.failUserLookup = true;
    const auth = await resolveGithubAuth(toContext(appConnection("SemIdentidade", "org-sem-id")));
    expect(auth.token).toBe("ghs_installation_1");
    expect(auth.committer).toBeNull();
  });
});

describe("resolveGithubAuth — modo pat / global", () => {
  // Regressão: `toContext` embutia o GITHUB_TOKEN global no campo `githubToken`,
  // então uma connection SEM credencial própria era reportada como `source:
  // "pat"` no log do tick e no botão "testar credencial" — mentindo sobre qual
  // token o run usa. O fallback global mora só aqui, no resolver.
  test("connection sem PAT próprio reporta source global, não pat", async () => {
    const row = createConnection({
      name: "SemPat",
      organizationId: "org-sem-pat",
      apiKey: "lin_key_sp_xxxxxxxx",
      webhookSecret: "secret-sp-xxxxxxxx",
    });
    // O `githubToken` do context tem que vir vazio (o global entra só no
    // resolver); se voltasse preenchido, o source viria "pat" e o operador
    // veria "PAT" onde na verdade roda o token global.
    expect(toContext(row).githubToken).toBeNull();
    expect((await resolveGithubAuth(toContext(row))).source).toBe("global");
  });

  test("pat não vai à rede e não injeta identidade", async () => {
    const auth = await resolveGithubAuth({
      connectionId: "c-pat",
      organizationId: "o",
      apiKey: "k",
      webhookSecret: "s",
      teamId: null,
      teamKey: null,
      name: "PatOrg",
      githubAuthMode: "pat",
      githubToken: "ghp_pat_direto",
    });
    expect(auth).toEqual({ token: "ghp_pat_direto", source: "pat", committer: null });
  });
});
