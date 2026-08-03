// CRUD + resolução de contexto Linear multi-workspace.
// Secrets cifrados at-rest (api_key_enc / webhook_secret_enc); plaintext só
// vive em memória no LinearContext passado ao client/dispatch — nunca logado.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { appDb } from "./index";
import { linearConnections } from "./schema";
import { decryptSecret, encryptSecret } from "./secrets";
import { config } from "../config";
import { log, errFields } from "../logger";

export type ConnectionRow = typeof linearConnections.$inferSelect;

/** Id sintético do fallback single-tenant (D6) — locks ficam em `orch:*` legado. */
export const DEFAULT_CONNECTION_ID = "default";

/**
 * `pat` = PAT/bot da row (comportamento original); `app` = GitHub App
 * (installation token mintado por run). `null` = legado — mesmo resolve do
 * `pat`, mantido pra não mudar connections criadas antes da coluna existir.
 */
export type GithubAuthMode = "pat" | "app";

export function parseGithubAuthMode(value: unknown): GithubAuthMode | null {
  return value === "pat" || value === "app" ? value : null;
}

export interface LinearContext {
  connectionId: string;
  organizationId: string;
  apiKey: string;
  webhookSecret: string;
  teamId: string | null;
  teamKey: string | null;
  name: string;
  /** Modo de auth GitHub; `null` = legado (PAT da row → GITHUB_TOKEN global). */
  githubAuthMode: GithubAuthMode | null;
  /**
   * PAT **desta connection**, ou `null` — o fallback pro `GITHUB_TOKEN` global
   * NÃO é aplicado aqui, e sim no `githubAuth.resolveGithubAuth`. Embutir o
   * global neste campo faria o resolver reportar `source: "pat"` para uma
   * connection sem credencial própria, mentindo no log do tick e no botão
   * "testar credencial" sobre qual token o run está usando.
   * SEMPRE `null` no modo `app`: lá o token é mintado por run, vale ~1h e nunca
   * fica no context. A PEM também não entra aqui — decriptada só no mint.
   */
  githubToken: string | null;
}

/** Credenciais do GitHub App de uma connection (PEM em claro, uso efêmero). */
export interface GithubAppCredentials {
  connectionId: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  /** Muda quando qualquer credencial é rotacionada — chave do cache de token. */
  fingerprint: string;
}

export class LinearConnectionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function decryptApiKey(row: ConnectionRow): string {
  return decryptSecret(row.apiKeyEnc);
}

export function decryptWebhookSecret(row: ConnectionRow): string {
  return decryptSecret(row.webhookSecretEnc);
}

export function decryptGithubToken(row: ConnectionRow): string | null {
  if (!row.githubTokenEnc) return null;
  try {
    const v = decryptSecret(row.githubTokenEnc).trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * PEM do App decriptada + fingerprint das credenciais. Retorna `null` quando a
 * connection não está em modo `app` ou está com campo faltando — quem chama
 * (githubAuth) transforma isso em erro claro, sem cair no token global.
 */
export function getGithubAppCredentials(connectionId: string): GithubAppCredentials | null {
  const row = getConnection(connectionId);
  if (!row || row.githubAuthMode !== "app") return null;
  const appId = row.githubAppId?.trim();
  const installationId = row.githubInstallationId?.trim();
  const pemEnc = row.githubAppPrivateKeyEnc;
  if (!appId || !installationId || !pemEnc) return null;
  let privateKeyPem: string;
  try {
    privateKeyPem = decryptSecret(pemEnc);
  } catch {
    return null;
  }
  return {
    connectionId,
    appId,
    installationId,
    privateKeyPem,
    // Deriva do CIFRADO (muda a cada re-encrypt) — rotacionar a PEM invalida o
    // cache de token sozinho, sem precisar de invalidação explícita no update.
    fingerprint: createHash("sha256")
      .update(`${appId}\n${installationId}\n${pemEnc}`)
      .digest("hex")
      .slice(0, 16),
  };
}

export function toContext(row: ConnectionRow): LinearContext {
  const mode = parseGithubAuthMode(row.githubAuthMode);
  const fromRow = decryptGithubToken(row);
  return {
    connectionId: row.id,
    organizationId: row.organizationId,
    apiKey: decryptApiKey(row),
    webhookSecret: decryptWebhookSecret(row),
    teamId: row.teamId,
    teamKey: row.teamKey,
    name: row.name,
    githubAuthMode: mode,
    // Modo app: nada de PAT no context — o token vem do mint, por run.
    githubToken: mode === "app" ? null : fromRow,
  };
}

/** Fallback D6: settings/ENV LINEAR_* quando a tabela ainda está vazia. */
export function singleTenantContext(): LinearContext | null {
  const apiKey = config.linear.apiKey;
  if (!apiKey) return null;
  return {
    connectionId: DEFAULT_CONNECTION_ID,
    organizationId: "",
    apiKey,
    webhookSecret: config.linear.webhookSecret,
    teamId: config.linear.teamId || null,
    teamKey: config.linear.teamKey || null,
    name: "Default",
    // Sem row no banco não há como configurar App nem PAT próprio — o
    // `GITHUB_TOKEN` global entra no resolveGithubAuth, como em toContext.
    githubAuthMode: null,
    githubToken: null,
  };
}

export function listConnections(opts?: { enabled?: boolean }): ConnectionRow[] {
  const rows = appDb().orm.select().from(linearConnections).all();
  if (opts?.enabled === true) return rows.filter((r) => r.enabled === 1);
  if (opts?.enabled === false) return rows.filter((r) => r.enabled === 0);
  return rows;
}

export function getConnection(id: string): ConnectionRow | undefined {
  return appDb().orm.select().from(linearConnections).where(eq(linearConnections.id, id)).get();
}

export function getByOrganizationId(organizationId: string): ConnectionRow | undefined {
  return appDb()
    .orm.select()
    .from(linearConnections)
    .where(eq(linearConnections.organizationId, organizationId))
    .get();
}

/**
 * Normaliza PEM colada na UI: CRLF e `\n` literais (o que sai de um `.env` ou
 * de um JSON copiado) viram quebra de linha de verdade, senão o `createSign`
 * rejeita a chave com um erro que não diz nada.
 */
export function normalizePrivateKeyPem(pem: string): string {
  return pem.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

/** Campos de auth GitHub compartilhados por create e update. */
export interface GithubAuthInput {
  /** `"pat"` | `"app"` | `null` = limpar (volta ao GITHUB_TOKEN global). */
  githubAuthMode?: GithubAuthMode | null;
  /** PAT/bot GitHub desta connection; omitido = só fallback global. */
  githubToken?: string | null;
  githubAppId?: string | null;
  githubInstallationId?: string | null;
  /** PEM em claro — cifrada aqui, nunca devolvida pela API. */
  githubAppPrivateKey?: string | null;
}

export interface CreateConnectionInput extends GithubAuthInput {
  name: string;
  organizationId: string;
  organizationKey?: string | null;
  apiKey: string;
  webhookSecret: string;
  teamId?: string | null;
  teamKey?: string | null;
  enabled?: boolean;
  updatedBy?: string | null;
}

/**
 * Modo `app` sem credencial completa não pode ser salvo: o dispatch se recusa a
 * cair no token global nesse modo (senão o operador acha que está rodando como
 * bot da org quando não está), então a validação tem que ser no save.
 */
function assertAppFields(
  mode: GithubAuthMode | null,
  fields: { appId: string | null; installationId: string | null; hasKey: boolean }
): void {
  if (mode !== "app") return;
  const missing: string[] = [];
  if (!fields.appId) missing.push("App ID");
  if (!fields.installationId) missing.push("Installation ID");
  if (!fields.hasKey) missing.push("Private Key (PEM)");
  if (missing.length > 0) {
    throw new LinearConnectionError(`modo GitHub App exige: ${missing.join(", ")}`);
  }
}

export function createConnection(input: CreateConnectionInput): ConnectionRow {
  if (!input.name?.trim()) throw new LinearConnectionError("nome é obrigatório");
  if (!input.organizationId?.trim()) throw new LinearConnectionError("organizationId é obrigatório");
  if (!input.apiKey?.trim()) throw new LinearConnectionError("apiKey é obrigatória");
  if (!input.webhookSecret?.trim()) throw new LinearConnectionError("webhookSecret é obrigatório");

  const existing = getByOrganizationId(input.organizationId.trim());
  if (existing) throw new LinearConnectionError("já existe connection para esta organizationId", 409);

  const now = Date.now();
  const gh = input.githubToken?.trim() || null;
  const mode = input.githubAuthMode ?? null;
  const appId = input.githubAppId?.trim() || null;
  const installationId = input.githubInstallationId?.trim() || null;
  const pem = input.githubAppPrivateKey ? normalizePrivateKeyPem(input.githubAppPrivateKey) : null;
  assertAppFields(mode, { appId, installationId, hasKey: Boolean(pem) });

  const row: typeof linearConnections.$inferInsert = {
    id: randomUUID(),
    name: input.name.trim(),
    organizationId: input.organizationId.trim(),
    organizationKey: input.organizationKey?.trim() || null,
    apiKeyEnc: encryptSecret(input.apiKey.trim()),
    webhookSecretEnc: encryptSecret(input.webhookSecret.trim()),
    githubTokenEnc: gh ? encryptSecret(gh) : null,
    githubAuthMode: mode,
    githubAppId: appId,
    githubInstallationId: installationId,
    githubAppPrivateKeyEnc: pem ? encryptSecret(pem) : null,
    teamId: input.teamId?.trim() || null,
    teamKey: input.teamKey?.trim() || null,
    enabled: input.enabled === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
    updatedBy: input.updatedBy ?? null,
  };
  appDb().orm.insert(linearConnections).values(row).run();
  return getConnection(row.id)!;
}

/**
 * Em todo campo de secret: string = setar; `null` = limpar; `undefined` = não
 * alterar (a UI nunca recebe o valor atual de volta, então "não mandar" tem que
 * significar "manter").
 */
export interface UpdateConnectionInput extends GithubAuthInput {
  name?: string;
  organizationId?: string;
  organizationKey?: string | null;
  apiKey?: string;
  webhookSecret?: string;
  teamId?: string | null;
  teamKey?: string | null;
  enabled?: boolean;
  updatedBy?: string | null;
}

export function updateConnection(id: string, input: UpdateConnectionInput): ConnectionRow {
  const existing = getConnection(id);
  if (!existing) throw new LinearConnectionError("connection não encontrada", 404);

  const set: Partial<typeof linearConnections.$inferInsert> = {
    updatedAt: Date.now(),
    updatedBy: input.updatedBy ?? existing.updatedBy,
  };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new LinearConnectionError("nome é obrigatório");
    set.name = input.name.trim();
  }
  if (input.organizationId !== undefined) {
    const orgId = input.organizationId.trim();
    if (!orgId) throw new LinearConnectionError("organizationId é obrigatório");
    const clash = getByOrganizationId(orgId);
    if (clash && clash.id !== id) {
      throw new LinearConnectionError("já existe connection para esta organizationId", 409);
    }
    set.organizationId = orgId;
  }
  if (input.organizationKey !== undefined) set.organizationKey = input.organizationKey?.trim() || null;
  if (input.apiKey !== undefined) {
    if (!input.apiKey.trim()) throw new LinearConnectionError("apiKey não pode ser vazia");
    set.apiKeyEnc = encryptSecret(input.apiKey.trim());
  }
  if (input.webhookSecret !== undefined) {
    if (!input.webhookSecret.trim()) throw new LinearConnectionError("webhookSecret não pode ser vazio");
    set.webhookSecretEnc = encryptSecret(input.webhookSecret.trim());
  }
  if (input.githubToken !== undefined) {
    const gh = input.githubToken?.trim() || null;
    set.githubTokenEnc = gh ? encryptSecret(gh) : null;
  }
  if (input.githubAppId !== undefined) set.githubAppId = input.githubAppId?.trim() || null;
  if (input.githubInstallationId !== undefined) {
    set.githubInstallationId = input.githubInstallationId?.trim() || null;
  }
  if (input.githubAppPrivateKey !== undefined) {
    const pem = input.githubAppPrivateKey ? normalizePrivateKeyPem(input.githubAppPrivateKey) : null;
    set.githubAppPrivateKeyEnc = pem ? encryptSecret(pem) : null;
  }
  if (input.githubAuthMode !== undefined) set.githubAuthMode = input.githubAuthMode;
  // Valida o modo contra o estado FINAL (campo não enviado = mantido), senão
  // salvar só o modo "app" numa connection já configurada seria rejeitado.
  const finalMode =
    input.githubAuthMode !== undefined ? input.githubAuthMode : parseGithubAuthMode(existing.githubAuthMode);
  assertAppFields(finalMode, {
    appId: (set.githubAppId !== undefined ? set.githubAppId : existing.githubAppId) || null,
    installationId:
      (set.githubInstallationId !== undefined ? set.githubInstallationId : existing.githubInstallationId) || null,
    hasKey: Boolean(
      set.githubAppPrivateKeyEnc !== undefined ? set.githubAppPrivateKeyEnc : existing.githubAppPrivateKeyEnc
    ),
  });
  if (input.teamId !== undefined) set.teamId = input.teamId?.trim() || null;
  if (input.teamKey !== undefined) set.teamKey = input.teamKey?.trim() || null;
  if (input.enabled !== undefined) set.enabled = input.enabled ? 1 : 0;

  appDb().orm.update(linearConnections).set(set).where(eq(linearConnections.id, id)).run();
  return getConnection(id)!;
}

export function setEnabled(id: string, enabled: boolean, updatedBy?: string | null): ConnectionRow {
  return updateConnection(id, { enabled, updatedBy });
}

export function deleteConnection(id: string): void {
  const existing = getConnection(id);
  if (!existing) throw new LinearConnectionError("connection não encontrada", 404);
  appDb().orm.delete(linearConnections).where(eq(linearConnections.id, id)).run();
}

/**
 * Contextos ativos pra tick/dispatch: rows enabled, ou fallback single-tenant
 * se a tabela estiver vazia (D6).
 */
export function resolveActiveContexts(): LinearContext[] {
  const enabled = listConnections({ enabled: true });
  if (enabled.length > 0) return enabled.map(toContext);
  const fallback = singleTenantContext();
  return fallback ? [fallback] : [];
}

export function resolveContextById(connectionId: string): LinearContext | null {
  if (connectionId === DEFAULT_CONNECTION_ID) return singleTenantContext();
  const row = getConnection(connectionId);
  if (!row || row.enabled !== 1) return null;
  return toContext(row);
}

function hmacHex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function signaturesMatch(expectedHex: string, provided: string): boolean {
  try {
    const a = Buffer.from(expectedHex, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return expectedHex === provided;
  }
}

/** Extrai organizationId do envelope Linear (top-level ou sob organization). */
export function extractOrganizationId(rawBody: string): string | null {
  try {
    const body = JSON.parse(rawBody) as {
      organizationId?: string;
      organization?: { id?: string };
    };
    if (typeof body.organizationId === "string" && body.organizationId) return body.organizationId;
    if (typeof body.organization?.id === "string" && body.organization.id) return body.organization.id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve connection a partir do webhook: org id → HMAC com secret da row;
 * sem org → trial dos secrets enabled; tabela vazia → config.linear (D6).
 * Retorna null se assinatura inválida / nenhuma connection casa.
 */
export function resolveLinearContextFromWebhook(
  rawBody: string,
  signatureHeader: string
): LinearContext | null {
  const enabled = listConnections({ enabled: true });

  if (enabled.length === 0) {
    const fallback = singleTenantContext();
    if (!fallback) return null;
    // Sem secret configurado: aceita (mesmo comportamento legado).
    if (!fallback.webhookSecret) return fallback;
    if (!signatureHeader) return null;
    const expected = hmacHex(fallback.webhookSecret, rawBody);
    return signaturesMatch(expected, signatureHeader) ? fallback : null;
  }

  const orgId = extractOrganizationId(rawBody);

  if (orgId) {
    const row = enabled.find((r) => r.organizationId === orgId);
    if (!row) {
      log.webhook.warn({ organizationId: orgId }, "webhook org sem connection cadastrada");
      return null;
    }
    const secret = decryptWebhookSecret(row);
    if (!signatureHeader || !signaturesMatch(hmacHex(secret, rawBody), signatureHeader)) {
      log.webhook.warn({ organizationId: orgId, connectionId: row.id }, "webhook signature mismatch");
      return null;
    }
    return toContext(row);
  }

  // Payload sem organizationId: trial de secrets (N pequeno).
  if (!signatureHeader) return null;
  for (const row of enabled) {
    const secret = decryptWebhookSecret(row);
    if (signaturesMatch(hmacHex(secret, rawBody), signatureHeader)) {
      log.webhook.debug({ connectionId: row.id }, "webhook matched via secret trial (sem organizationId)");
      return toContext(row);
    }
  }
  return null;
}

/**
 * Boot one-shot: se tabela vazia e LINEAR_API_KEY existe, cria connection
 * Default com org id via GraphQL. Falha de rede não derruba o boot.
 */
export async function maybeSeedDefaultConnection(): Promise<void> {
  try {
    if (listConnections().length > 0) return;
    const apiKey = config.linear.apiKey;
    if (!apiKey) return;

    const webhookSecret = config.linear.webhookSecret;
    if (!webhookSecret) {
      log.linear.warn("seed Default connection adiada: LINEAR_WEBHOOK_SECRET ausente");
      return;
    }

    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query: `{ organization { id urlKey } }` }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as {
      data?: { organization?: { id: string; urlKey: string } };
      errors?: unknown;
    };
    if (!res.ok || json.errors || !json.data?.organization?.id) {
      log.linear.warn({ status: res.status, errors: json.errors }, "seed Default connection: falha ao ler organization");
      return;
    }

    createConnection({
      name: "Default",
      organizationId: json.data.organization.id,
      organizationKey: json.data.organization.urlKey,
      apiKey,
      webhookSecret,
      teamId: config.linear.teamId || null,
      teamKey: config.linear.teamKey || null,
    });
    log.linear.info(
      { organizationId: json.data.organization.id, organizationKey: json.data.organization.urlKey },
      "Default connection created from legacy LINEAR_*"
    );
  } catch (e) {
    log.linear.warn({ ...errFields(e) }, "Default connection seed failed (non-fatal)");
  }
}

/** Máscara pra API — nunca devolve secret/key em claro. */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length < 12) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function connectionPublicView(row: ConnectionRow) {
  const gh = decryptGithubToken(row);
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    organizationKey: row.organizationKey,
    teamId: row.teamId,
    teamKey: row.teamKey,
    enabled: row.enabled === 1,
    apiKeyMasked: maskSecret(decryptApiKey(row)),
    webhookSecretMasked: maskSecret(decryptWebhookSecret(row)),
    githubTokenMasked: gh ? maskSecret(gh) : null,
    hasGithubToken: Boolean(gh),
    githubAuthMode: parseGithubAuthMode(row.githubAuthMode),
    githubAppId: row.githubAppId,
    githubInstallationId: row.githubInstallationId,
    // A PEM nunca sai daqui, nem mascarada — só o fato de existir.
    hasGithubAppKey: Boolean(row.githubAppPrivateKeyEnc),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
