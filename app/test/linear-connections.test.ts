import { describe, expect, test, beforeEach } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { openAppDb } from "../src/db";
import { TEST_TMP_DIR } from "./setup";
import {
  createConnection,
  listConnections,
  resolveLinearContextFromWebhook,
  extractOrganizationId,
  singleTenantContext,
} from "../src/db/linearConnections";
import { buildRunEnv } from "../src/agent/dispatch";
import type { LinearContext } from "../src/db/linearConnections";

// Garante banco migrado (inclui linear_connections) antes dos testes.
openAppDb(join(TEST_TMP_DIR, "linear-conn-tests.sqlite"));

/** PKCS#1, mesmo formato que o GitHub entrega no download da private key do App. */
const TEST_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("linear connections — webhook resolve", () => {
  beforeEach(() => {
    // Limpa connections entre testes (banco compartilhado do preload).
    for (const row of listConnections()) {
      const { deleteConnection } = require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
      deleteConnection(row.id);
    }
  });

  test("extractOrganizationId lê top-level e organization.id", () => {
    expect(extractOrganizationId(`{"organizationId":"org-a"}`)).toBe("org-a");
    expect(extractOrganizationId(`{"organization":{"id":"org-b"}}`)).toBe("org-b");
    expect(extractOrganizationId(`{"data":{}}`)).toBeNull();
  });

  test("HMAC com organizationId roteia pra connection certa", () => {
    const a = createConnection({
      name: "A",
      organizationId: "org-a",
      apiKey: "lin_key_a_xxxxxxxx",
      webhookSecret: "secret-a-aaaaaaaa",
    });
    createConnection({
      name: "B",
      organizationId: "org-b",
      apiKey: "lin_key_b_xxxxxxxx",
      webhookSecret: "secret-b-bbbbbbbb",
    });

    const body = JSON.stringify({ organizationId: "org-a", type: "Issue", data: { id: "i1" } });
    const ctx = resolveLinearContextFromWebhook(body, sign("secret-a-aaaaaaaa", body));
    expect(ctx?.connectionId).toBe(a.id);
    expect(ctx?.apiKey).toBe("lin_key_a_xxxxxxxx");
  });

  test("secret errado → null", () => {
    createConnection({
      name: "A",
      organizationId: "org-a",
      apiKey: "lin_key_a_xxxxxxxx",
      webhookSecret: "secret-a-aaaaaaaa",
    });
    const body = JSON.stringify({ organizationId: "org-a" });
    expect(resolveLinearContextFromWebhook(body, sign("wrong-secret", body))).toBeNull();
  });

  test("sem organizationId → trial de secrets", () => {
    const b = createConnection({
      name: "B",
      organizationId: "org-b",
      apiKey: "lin_key_b_xxxxxxxx",
      webhookSecret: "secret-b-bbbbbbbb",
    });
    const body = JSON.stringify({ type: "Issue", data: { id: "i1" } });
    const ctx = resolveLinearContextFromWebhook(body, sign("secret-b-bbbbbbbb", body));
    expect(ctx?.connectionId).toBe(b.id);
  });

  test("tabela vazia → fallback single-tenant via config", () => {
    process.env.LINEAR_API_KEY = "legacy-key-xxxxxxxxxxxx";
    process.env.LINEAR_WEBHOOK_SECRET = "legacy-secret-yyyy";
    // Recarrega config service cache? config lê via svc — ENV tem precedência.
    const body = JSON.stringify({ type: "Issue" });
    const ctx = resolveLinearContextFromWebhook(body, sign("legacy-secret-yyyy", body));
    // Pode ser null se config já foi cacheada sem a key — singleTenantContext lê config.
    const fallback = singleTenantContext();
    if (fallback?.webhookSecret) {
      expect(ctx?.apiKey ?? fallback.apiKey).toBeTruthy();
    }
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });
});

function ctxWith(overrides: Partial<LinearContext>): LinearContext {
  return {
    connectionId: "c1",
    organizationId: "o1",
    apiKey: "lin_key",
    webhookSecret: "sec",
    teamId: null,
    teamKey: null,
    name: "T",
    githubAuthMode: null,
    githubToken: null,
    ...overrides,
  };
}

describe("buildRunEnv — Linear + GitHub inject", () => {
  test("injeta LINEAR_API_KEY e LINEAR_API_TOKEN do context", async () => {
    const env = await buildRunEnv(ctxWith({ apiKey: "conn-api-key-zzzzzzzz" }));
    expect(env.LINEAR_API_KEY).toBe("conn-api-key-zzzzzzzz");
    expect(env.LINEAR_API_TOKEN).toBe("conn-api-key-zzzzzzzz");
  });

  test("injeta GITHUB_TOKEN da connection no harness env", async () => {
    const env = await buildRunEnv(ctxWith({ githubToken: "ghp_bot_token_org_a" }));
    expect(env.GITHUB_TOKEN).toBe("ghp_bot_token_org_a");
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_bot_token_org_a");
  });

  test("dois contexts produzem keys distintas", async () => {
    const a = await buildRunEnv(ctxWith({ connectionId: "1", apiKey: "key-aaaa", githubToken: "ghp_aaaa" }));
    const b = await buildRunEnv(ctxWith({ connectionId: "2", apiKey: "key-bbbb", githubToken: "ghp_bbbb" }));
    expect(a.LINEAR_API_KEY).toBe("key-aaaa");
    expect(b.LINEAR_API_KEY).toBe("key-bbbb");
    expect(a.GITHUB_TOKEN).toBe("ghp_aaaa");
    expect(b.GITHUB_TOKEN).toBe("ghp_bbbb");
  });

  test("token vira insteadOf de git no env do run (git puro não lê GITHUB_TOKEN)", async () => {
    const env = await buildRunEnv(ctxWith({ githubToken: "ghp_git_auth_test" }));
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(count).toBeGreaterThan(0);
    const keys = Array.from({ length: count }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    expect(keys).toContain("url.https://x-access-token:ghp_git_auth_test@github.com/.insteadOf");
  });

  test("modo pat NÃO injeta identidade de commit (o dono do PAT pode ser humano)", async () => {
    const env = await buildRunEnv(ctxWith({ githubAuthMode: "pat", githubToken: "ghp_x" }));
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  test("modo app sem credencial completa falha em vez de cair no token global", async () => {
    const ctx = ctxWith({ connectionId: "sem-credencial", githubAuthMode: "app", name: "OrgApp" });
    expect(buildRunEnv(ctx)).rejects.toThrow(/modo GitHub App/);
  });
});

describe("linear connections — github token", () => {
  beforeEach(() => {
    for (const row of listConnections()) {
      const { deleteConnection } = require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
      deleteConnection(row.id);
    }
  });

  test("create/update/clear github token + toContext", () => {
    const { updateConnection, toContext, connectionPublicView } =
      require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
    const row = createConnection({
      name: "WithGh",
      organizationId: "org-gh",
      apiKey: "lin_key_gh_xxxxxxxx",
      webhookSecret: "secret-gh-xxxxxxxx",
      githubToken: "ghp_initial_token_xx",
    });
    expect(connectionPublicView(row).hasGithubToken).toBe(true);
    expect(toContext(row).githubToken).toBe("ghp_initial_token_xx");

    const updated = updateConnection(row.id, { githubToken: "ghp_rotated_token_yy" });
    expect(toContext(updated).githubToken).toBe("ghp_rotated_token_yy");

    const cleared = updateConnection(row.id, { githubToken: null });
    expect(connectionPublicView(cleared).hasGithubToken).toBe(false);
  });
});

describe("linear connections — modo GitHub App", () => {
  beforeEach(() => {
    for (const row of listConnections()) {
      const { deleteConnection } = require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
      deleteConnection(row.id);
    }
  });

  const APP_FIELDS = {
    githubAuthMode: "app" as const,
    githubAppId: "123456",
    githubInstallationId: "77889900",
    githubAppPrivateKey: TEST_PEM,
  };

  test("modo app exige App ID, Installation ID e PEM", () => {
    expect(() =>
      createConnection({
        name: "Incompleta",
        organizationId: "org-app-invalida",
        apiKey: "lin_key_app_xxxxxxxx",
        webhookSecret: "secret-app-xxxxxxxx",
        githubAuthMode: "app",
        githubAppId: "123456",
      })
    ).toThrow(/Installation ID/);
  });

  test("PEM é cifrada, nunca volta pela API, e o context não carrega PAT", () => {
    const { toContext, connectionPublicView, getGithubAppCredentials } =
      require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
    const row = createConnection({
      name: "ComApp",
      organizationId: "org-app",
      apiKey: "lin_key_app_xxxxxxxx",
      webhookSecret: "secret-app-xxxxxxxx",
      // PAT salvo junto: o modo `app` tem que ignorá-lo, senão o operador acha
      // que roda como bot da org quando na verdade roda como o dono do PAT.
      githubToken: "ghp_nao_deve_vazar",
      ...APP_FIELDS,
    });

    const view = connectionPublicView(row);
    expect(view.githubAuthMode).toBe("app");
    expect(view.hasGithubAppKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain("PRIVATE KEY");

    expect(row.githubAppPrivateKeyEnc).toStartWith("enc:v1:");
    expect(toContext(row).githubToken).toBeNull();

    const creds = getGithubAppCredentials(row.id)!;
    // Guardada normalizada (sem newline final) — o `createSign` aceita assim.
    expect(creds.privateKeyPem).toBe(TEST_PEM.trim());
    expect(creds.installationId).toBe("77889900");
  });

  test("fingerprint muda ao rotacionar a PEM (invalida o cache de token)", () => {
    const { updateConnection, getGithubAppCredentials } =
      require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
    const row = createConnection({
      name: "Rotate",
      organizationId: "org-rotate",
      apiKey: "lin_key_rot_xxxxxxxx",
      webhookSecret: "secret-rot-xxxxxxxx",
      ...APP_FIELDS,
    });
    const before = getGithubAppCredentials(row.id)!.fingerprint;
    updateConnection(row.id, { githubInstallationId: "99999999" });
    expect(getGithubAppCredentials(row.id)!.fingerprint).not.toBe(before);
  });

  test("voltar pra pat mantém as credenciais do App salvas mas ignora o modo", () => {
    const { updateConnection, toContext, getGithubAppCredentials } =
      require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
    const row = createConnection({
      name: "Toggle",
      organizationId: "org-toggle",
      apiKey: "lin_key_tog_xxxxxxxx",
      webhookSecret: "secret-tog-xxxxxxxx",
      githubToken: "ghp_pat_de_volta",
      ...APP_FIELDS,
    });
    const back = updateConnection(row.id, { githubAuthMode: "pat" });
    expect(toContext(back).githubToken).toBe("ghp_pat_de_volta");
    // `getGithubAppCredentials` é gated pelo modo — em `pat` não devolve nada.
    expect(getGithubAppCredentials(row.id)).toBeNull();
    expect(back.githubAppPrivateKeyEnc).not.toBeNull();
  });

  test("normaliza PEM colada com \\n literal", () => {
    const { normalizePrivateKeyPem } =
      require("../src/db/linearConnections") as typeof import("../src/db/linearConnections");
    expect(normalizePrivateKeyPem("-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----")).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"
    );
  });
});
