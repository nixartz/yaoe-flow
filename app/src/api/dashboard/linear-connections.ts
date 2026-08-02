import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody, idParam, looseObject } from "../shared/schemas";
import { probeBody, probeGithubBody, probeGithubAppBody, createConnectionBody, updateConnectionBody } from "./linear-connections.schema";
import {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  connectionPublicView,
  decryptApiKey,
  normalizePrivateKeyPem,
  parseGithubAuthMode,
  toContext,
  LinearConnectionError,
  type GithubAuthInput,
} from "../../db/linearConnections";
import { authUser } from "../../dashboard/auth";
import { log } from "../../logger";
import { createWebhook, listOrganizations, listTeams, fetchViewer } from "../../cli/setup/linearAdmin";
import { config } from "../../config";
import { probeGithubToken } from "../../github";
import { fetchAppMetadata, listAppInstallations, mintInstallationToken, resolveGithubAuth } from "../../githubAuth";

export const linearConnectionsRoutes = new Hono();

/** `null` = limpar; `undefined` = manter (campo ausente no PATCH). */
function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * Campos de auth GitHub do body. Aceita o modo como `"pat"`/`"app"`/`null`
 * (`null` = voltar pro GITHUB_TOKEN global); qualquer outra coisa é ignorada,
 * pra um body malformado não derrubar o modo silenciosamente.
 */
function githubAuthFromBody(body: Record<string, unknown>): GithubAuthInput {
  const raw = body.githubAuthMode;
  return {
    githubAuthMode: raw === undefined ? undefined : raw === null ? null : (parseGithubAuthMode(raw) ?? undefined),
    githubToken: nullableString(body.githubToken),
    githubAppId: nullableString(body.githubAppId),
    githubInstallationId: nullableString(body.githubInstallationId),
    githubAppPrivateKey: nullableString(body.githubAppPrivateKey),
  };
}

function webhookUrlHint(): string {
  return `http://<sua-url-pública>:${config.port}/webhook/linear`;
}

function probePayload(viewer: Awaited<ReturnType<typeof fetchViewer>>, orgs: Awaited<ReturnType<typeof listOrganizations>>, teams: Awaited<ReturnType<typeof listTeams>>) {
  return {
    ok: true as const,
    viewer,
    organizations: orgs.map((o) => ({ id: o.id, urlKey: o.urlKey, name: o.name })),
    organization: orgs[0] ? { id: orgs[0].id, urlKey: orgs[0].urlKey, name: orgs[0].name } : undefined,
    teams: teams.map((t) => ({ id: t.id, key: t.key, name: t.name })),
  };
}

linearConnectionsRoutes.get(
  "/",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Lista connections",
    responses: { 200: jsonContent(looseObject, "Connections") },
  }),
  (c) => {
    return c.json({
      connections: listConnections().map(connectionPublicView),
      webhookUrl: webhookUrlHint(),
      legacyFallbackActive: listConnections().length === 0 && Boolean(config.linear.apiKey),
    });
  }
);

linearConnectionsRoutes.post(
  "/probe",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Testa API key antes de salvar",
    responses: {
      200: jsonContent(looseObject, "Probe OK"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("json", probeBody),
  async (c) => {
    const apiKey = c.req.valid("json").apiKey.trim();
    if (!apiKey) return c.json({ error: "apiKey é obrigatória" }, 400);
    try {
      const viewer = await fetchViewer(apiKey);
      const orgs = await listOrganizations(apiKey);
      const teams = await listTeams(apiKey);
      return c.json(probePayload(viewer, orgs, teams));
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
);

linearConnectionsRoutes.post(
  "/probe-github",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Valida PAT/bot GitHub",
    responses: {
      200: jsonContent(looseObject, "Probe OK"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("json", probeGithubBody),
  async (c) => {
    const token = c.req.valid("json").token.trim();
    if (!token) return c.json({ error: "token é obrigatório" }, 400);
    try {
      const user = await probeGithubToken(token);
      return c.json({ ok: true, user });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
);

linearConnectionsRoutes.post(
  "/probe-github-app",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Valida credenciais de GitHub App",
    responses: {
      200: jsonContent(looseObject, "Probe OK"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("json", probeGithubAppBody),
  async (c) => {
    const body = c.req.valid("json");
    const appId = body.appId.trim();
    const privateKeyRaw = body.privateKey;
    const installationId = (body.installationId ?? "").trim();
    if (!appId) return c.json({ error: "appId é obrigatório" }, 400);
    if (!privateKeyRaw.trim()) return c.json({ error: "privateKey (PEM) é obrigatória" }, 400);

    const privateKey = normalizePrivateKeyPem(privateKeyRaw);
    try {
      const app = await fetchAppMetadata(appId, privateKey);
      const installations = await listAppInstallations(appId, privateKey);
      if (!installationId) {
        return c.json({ ok: true, app, installations });
      }
      const minted = await mintInstallationToken(appId, installationId, privateKey);
      const account = installations.find((i) => String(i.id) === installationId)?.account ?? null;
      return c.json({
        ok: true,
        app,
        installations,
        installation: { id: installationId, account, expiresAt: minted.expiresAt },
      });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
);

linearConnectionsRoutes.post(
  "/",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Cria connection",
    responses: {
      200: jsonContent(looseObject, "Connection criada"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("json", createConnectionBody),
  async (c) => {
    const body = c.req.valid("json") as Record<string, unknown>;
    try {
      const apiKey = String(body.apiKey ?? "").trim();
      if (!apiKey) return c.json({ error: "apiKey é obrigatória" }, 400);

      const organizationId = typeof body.organizationId === "string" ? (body.organizationId as string).trim() : "";
      if (!organizationId) {
        return c.json({ error: "organizationId é obrigatório — teste a API key e selecione a organização" }, 400);
      }
      let organizationKey =
        typeof body.organizationKey === "string" ? (body.organizationKey as string).trim() : null;
      const orgs = await listOrganizations(apiKey);
      const matched = orgs.find((o) => o.id === organizationId);
      if (!matched) {
        return c.json({ error: "organização selecionada não corresponde à API key testada" }, 400);
      }
      organizationKey = organizationKey || matched.urlKey;

      const webhookSecret =
        (typeof body.webhookSecret === "string" && (body.webhookSecret as string).trim()) ||
        randomBytes(32).toString("hex");

      const row = createConnection({
        name: String(body.name ?? ""),
        organizationId,
        organizationKey,
        apiKey,
        webhookSecret,
        teamId: typeof body.teamId === "string" ? body.teamId as string : null,
        teamKey: typeof body.teamKey === "string" ? body.teamKey as string : null,
        ...githubAuthFromBody(body),
        enabled: body.enabled !== false,
        updatedBy: authUser(c).id,
      });
      log.dashboard.info(
        { connectionId: row.id, name: row.name, organizationId: row.organizationId, by: authUser(c).username },
        "linear connection created"
      );
      return c.json({
        ok: true,
        connection: connectionPublicView(row),
        webhookSecret,
      });
    } catch (e) {
      if (e instanceof LinearConnectionError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

linearConnectionsRoutes.get(
  "/:id",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Detalhe da connection",
    responses: {
      200: jsonContent(looseObject, "Connection"),
      404: jsonContent(errorBody, "Não encontrada"),
    },
  }),
  validator("param", idParam),
  (c) => {
    const row = getConnection(c.req.valid("param").id);
    if (!row) return c.json({ error: "connection não encontrada" }, 404);
    return c.json({ connection: connectionPublicView(row) });
  }
);

linearConnectionsRoutes.patch(
  "/:id",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Atualiza connection",
    responses: {
      200: jsonContent(looseObject, "Atualizada"),
      400: jsonContent(errorBody, "Erro"),
      404: jsonContent(errorBody, "Não encontrada"),
    },
  }),
  validator("param", idParam),
  validator("json", updateConnectionBody),
  async (c) => {
    const body = c.req.valid("json") as Record<string, unknown>;
    try {
      const id = c.req.valid("param").id;
      const existing = getConnection(id);
      if (!existing) return c.json({ error: "connection não encontrada" }, 404);

      const newApiKey = typeof body.apiKey === "string" && (body.apiKey as string).trim() ? (body.apiKey as string).trim() : undefined;
      const organizationId =
        typeof body.organizationId === "string" ? (body.organizationId as string).trim() : undefined;

      if (organizationId !== undefined || newApiKey) {
        if (!organizationId) {
          return c.json({ error: "organizationId é obrigatório — teste a API key e selecione a organização" }, 400);
        }
        const apiKeyToValidate = newApiKey ?? decryptApiKey(existing);
        const orgs = await listOrganizations(apiKeyToValidate);
        const matched = orgs.find((o) => o.id === organizationId);
        if (!matched) {
          return c.json({ error: "organização selecionada não corresponde à API key testada" }, 400);
        }
        if (typeof body.organizationKey !== "string" || !(body.organizationKey as string).trim()) {
          body.organizationKey = matched.urlKey;
        }
      }

      const row = updateConnection(id, {
        name: typeof body.name === "string" ? body.name as string : undefined,
        organizationId,
        organizationKey:
          body.organizationKey === null || typeof body.organizationKey === "string"
            ? (body.organizationKey as string | null)
            : undefined,
        apiKey: newApiKey,
        webhookSecret:
          typeof body.webhookSecret === "string" && (body.webhookSecret as string).trim() ? body.webhookSecret as string : undefined,
        teamId:
          body.teamId === null || typeof body.teamId === "string" ? (body.teamId as string | null) : undefined,
        teamKey:
          body.teamKey === null || typeof body.teamKey === "string" ? (body.teamKey as string | null) : undefined,
        ...githubAuthFromBody(body),
        enabled: typeof body.enabled === "boolean" ? body.enabled as boolean : undefined,
        updatedBy: authUser(c).id,
      });
      return c.json({ ok: true, connection: connectionPublicView(row) });
    } catch (e) {
      if (e instanceof LinearConnectionError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

linearConnectionsRoutes.delete(
  "/:id",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Remove connection",
    responses: {
      200: jsonContent(okBody, "Removida"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  (c) => {
    try {
      deleteConnection(c.req.valid("param").id);
      return c.json({ ok: true as const });
    } catch (e) {
      if (e instanceof LinearConnectionError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

linearConnectionsRoutes.post(
  "/:id/test",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Testa API key salva (viewer + organizations + teams)",
    responses: {
      200: jsonContent(looseObject, "Teste OK"),
      400: jsonContent(errorBody, "Erro"),
      404: jsonContent(errorBody, "Não encontrada"),
    },
  }),
  validator("param", idParam),
  async (c) => {
    const row = getConnection(c.req.valid("param").id);
    if (!row) return c.json({ error: "connection não encontrada" }, 404);
    try {
      const apiKey = decryptApiKey(row);
      const viewer = await fetchViewer(apiKey);
      const orgs = await listOrganizations(apiKey);
      const teams = await listTeams(apiKey);
      return c.json(probePayload(viewer, orgs, teams));
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
);

linearConnectionsRoutes.post(
  "/:id/test-github",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Testa credencial GitHub salva (resolve + probe)",
    responses: {
      200: jsonContent(looseObject, "Teste OK"),
      400: jsonContent(errorBody, "Erro"),
      404: jsonContent(errorBody, "Não encontrada"),
    },
  }),
  validator("param", idParam),
  async (c) => {
    const row = getConnection(c.req.valid("param").id);
    if (!row) return c.json({ error: "connection não encontrada" }, 404);
    try {
      const auth = await resolveGithubAuth(toContext(row));
      if (!auth.token) {
        return c.json({ ok: false, error: "nenhuma credencial GitHub — nem na connection nem em GITHUB_TOKEN global" }, 400);
      }
      const user = await probeGithubToken(auth.token).catch(() => null);
      return c.json({ ok: true, source: auth.source, user, committer: auth.committer });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
);

linearConnectionsRoutes.post(
  "/:id/rotate-webhook-secret",
  describeRoute({
    tags: ["LinearConnections"],
    summary: "Rotaciona webhook secret",
    responses: {
      200: jsonContent(looseObject, "Secret rotacionado"),
      400: jsonContent(errorBody, "Erro"),
      404: jsonContent(errorBody, "Não encontrada"),
    },
  }),
  validator("param", idParam),
  async (c) => {
    const row = getConnection(c.req.valid("param").id);
    if (!row) return c.json({ error: "connection não encontrada" }, 404);
    const secret = randomBytes(32).toString("hex");
    try {
      const updated = updateConnection(row.id, { webhookSecret: secret, updatedBy: authUser(c).id });
      let webhookCreated = false;
      if (updated.teamId) {
        try {
          const base = `http://localhost:${config.port}`;
          await createWebhook(decryptApiKey(updated), updated.teamId, `${base}/webhook/linear`, secret);
          webhookCreated = true;
        } catch (e) {
          log.dashboard.warn(
            { connectionId: row.id, error: e instanceof Error ? e.message : String(e) },
            "rotate: createWebhook no Linear falhou — secret só no banco"
          );
        }
      }
      return c.json({
        ok: true,
        connection: connectionPublicView(updated),
        webhookSecret: secret,
        webhookCreated,
      });
    } catch (e) {
      if (e instanceof LinearConnectionError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);
