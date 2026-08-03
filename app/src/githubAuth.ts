// Resolução de credencial GitHub por Linear connection — o ponto ÚNICO por onde
// passam os dois modos (D4 da spec `github-app-and-harness-isolation`):
//
//   pat / legado → PAT da row (ou GITHUB_TOKEN global), string estável
//   app          → JWT RS256 assinado com a PEM → installation access token
//                   (~1h de validade) → cache em memória por connection
//
// Todo mundo (buildRunEnv, scope-check, comentário em PR) chama daqui: nenhum
// call site precisa saber em que modo a connection está, e a PEM nunca sai do
// processo nem entra no env de um child.
import { createSign } from "node:crypto";
import { config } from "./config";
import { log, errFields } from "./logger";
import { getGithubAppCredentials, type GithubAppCredentials, type LinearContext } from "./db/linearConnections";

const API = "https://api.github.com";

/** Renova com folga: token de ~1h usado a 5 min do fim é token que expira no meio do run. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class GithubAuthError extends Error {}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Chave = fingerprint das credenciais → rotacionar a PEM invalida sozinho. */
const tokenCache = new Map<string, CachedToken>();
const identityCache = new Map<string, GithubCommitterIdentity>();

export function clearGithubAuthCache(): void {
  tokenCache.clear();
  identityCache.clear();
}

function githubHeaders(bearer: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${bearer}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * JWT de App (RS256). `iat` recuado 60s absorve clock skew entre este host e o
 * GitHub; `exp` fica em +8min porque o teto do GitHub é 10min CONTADOS A PARTIR
 * DO `iat` — com o recuo, pedir 10 estoura.
 */
export function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: appId,
  })}`;
  try {
    const signature = createSign("RSA-SHA256").update(data).sign(privateKeyPem);
    return `${data}.${signature.toString("base64url")}`;
  } catch (e) {
    // O erro cru do OpenSSL ("error:1E08010C:DECODER routines") não ajuda
    // ninguém a descobrir que colou a chave errada.
    throw new GithubAuthError(
      `private key do GitHub App inválida — cole o conteúdo do .pem baixado no GitHub (${
        e instanceof Error ? e.message : String(e)
      })`
    );
  }
}

export interface MintedToken {
  token: string;
  /** ISO 8601 devolvido pelo GitHub (~1h à frente). */
  expiresAt: string;
}

/** POST /app/installations/{id}/access_tokens — server-to-server, sem Client ID/Secret. */
export async function mintInstallationToken(
  appId: string,
  installationId: string,
  privateKeyPem: string
): Promise<MintedToken> {
  const jwt = signAppJwt(appId, privateKeyPem);
  const res = await fetch(`${API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(jwt),
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new GithubAuthError(`GitHub installation token ${res.status}: ${body}`);
  }
  const parsed = JSON.parse(body) as { token?: string; expires_at?: string };
  if (!parsed.token) throw new GithubAuthError("GitHub devolveu installation token vazio");
  return { token: parsed.token, expiresAt: parsed.expires_at ?? new Date(Date.now() + 3_600_000).toISOString() };
}

export interface AppInstallation {
  id: number;
  account: string | null;
  accountType: string | null;
}

/** GET /app/installations — alimenta o select de Installation ID na dashboard. */
export async function listAppInstallations(appId: string, privateKeyPem: string): Promise<AppInstallation[]> {
  const jwt = signAppJwt(appId, privateKeyPem);
  const res = await fetch(`${API}/app/installations?per_page=100`, {
    headers: githubHeaders(jwt),
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new GithubAuthError(`GitHub /app/installations ${res.status}: ${body}`);
  const rows = JSON.parse(body) as {
    id: number;
    account?: { login?: string; type?: string } | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    account: r.account?.login ?? null,
    accountType: r.account?.type ?? null,
  }));
}

export interface AppMetadata {
  id: number;
  slug: string;
  name: string;
}

/** GET /app — identidade do App (usada pro slug do committer e pro probe). */
export async function fetchAppMetadata(appId: string, privateKeyPem: string): Promise<AppMetadata> {
  const jwt = signAppJwt(appId, privateKeyPem);
  const res = await fetch(`${API}/app`, {
    headers: githubHeaders(jwt),
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new GithubAuthError(`GitHub /app ${res.status}: ${body}`);
  const app = JSON.parse(body) as { id: number; slug: string; name: string };
  return { id: app.id, slug: app.slug, name: app.name };
}

export interface GithubCommitterIdentity {
  name: string;
  email: string;
}

/**
 * Identidade de commit do bot do App.
 *
 * O e-mail TEM que ser `<id-do-usuário-bot>+<slug>[bot]@users.noreply.github.com`
 * pra que o GitHub linke o commit ao perfil do bot (avatar + "verified" na
 * timeline). O número é o id da CONTA `<slug>[bot]` (`GET /users/...`), NÃO o
 * App ID — é a confusão clássica, e com o número errado o commit fica órfão
 * (aparece o nome, sem link nem avatar). O nome exibido é livre; usamos
 * `<slug>[bot]` pela mesma convenção do `github-actions[bot]`.
 */
async function fetchCommitterIdentity(
  creds: GithubAppCredentials,
  installationToken: string
): Promise<GithubCommitterIdentity> {
  const app = await fetchAppMetadata(creds.appId, creds.privateKeyPem);
  const login = `${app.slug}[bot]`;
  const res = await fetch(`${API}/users/${encodeURIComponent(login)}`, {
    headers: githubHeaders(installationToken),
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  if (!res.ok) throw new GithubAuthError(`GitHub /users/${login} ${res.status}: ${await res.text()}`);
  const user = (await res.json()) as { id: number };
  return { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
}

export interface ResolvedGithubAuth {
  token: string;
  /** `"pat"` | `"app"` | `"global"` — só pra log/diagnóstico. */
  source: "pat" | "app" | "global";
  /**
   * Identidade a injetar em `GIT_AUTHOR_*`/`GIT_COMMITTER_*` — só no modo `app`
   * (num PAT o dono pode ser uma pessoa; forçar identidade seria mentir sobre
   * quem assinou o commit).
   */
  committer: GithubCommitterIdentity | null;
}

async function resolveAppToken(creds: GithubAppCredentials): Promise<string> {
  const cached = tokenCache.get(creds.fingerprint);
  if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) return cached.token;

  const minted = await mintInstallationToken(creds.appId, creds.installationId, creds.privateKeyPem);
  const expiresAt = Date.parse(minted.expiresAt);
  tokenCache.set(creds.fingerprint, {
    token: minted.token,
    expiresAt: Number.isNaN(expiresAt) ? Date.now() + 3_600_000 : expiresAt,
  });
  log.github.info(
    { operation: "mintInstallationToken", connectionId: creds.connectionId, appId: creds.appId, expiresAt: minted.expiresAt },
    "GitHub App installation token mintado"
  );
  return minted.token;
}

/**
 * Credencial efetiva da connection. No modo `app` FALHA em vez de cair no
 * GITHUB_TOKEN global: silenciar aqui faria o run rodar como outra identidade
 * sem ninguém perceber.
 */
export async function resolveGithubAuth(ctx: LinearContext | null | undefined): Promise<ResolvedGithubAuth> {
  if (ctx?.githubAuthMode === "app") {
    const creds = getGithubAppCredentials(ctx.connectionId);
    if (!creds) {
      throw new GithubAuthError(
        `connection "${ctx.name}" está em modo GitHub App mas sem App ID / Installation ID / Private Key completos`
      );
    }
    const token = await resolveAppToken(creds);

    let committer = identityCache.get(creds.fingerprint) ?? null;
    if (!committer) {
      try {
        committer = await fetchCommitterIdentity(creds, token);
        identityCache.set(creds.fingerprint, committer);
      } catch (e) {
        // Without identity the push still works (the token is what authenticates)
        // — commits just end up without a link to the bot's profile. Not worth failing the run.
        log.github.warn(
          { connectionId: ctx.connectionId, appId: creds.appId, ...errFields(e) },
          "could not resolve the App's commit identity — commits will go out without bot attribution"
        );
      }
    }
    return { token, source: "app", committer };
  }

  const token = (ctx?.githubToken || config.github.token || "").trim();
  return { token, source: ctx?.githubToken ? "pat" : "global", committer: null };
}

/** Atalho pros call sites que só precisam do token (scope-check, comentário em PR). */
export async function resolveGithubAccessToken(ctx: LinearContext | null | undefined): Promise<string> {
  return (await resolveGithubAuth(ctx)).token;
}
