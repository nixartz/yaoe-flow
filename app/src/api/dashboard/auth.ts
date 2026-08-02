import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody } from "../shared/schemas";
import {
  setupStatusResponse,
  setupBody,
  loginBody,
  loginResponse,
  meResponse,
} from "./auth.schema";
import {
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  resolveSessionUser,
  loginThrottled,
  findByUsername,
  toSafeUser,
  touchLastLogin,
  verifyPassword,
  countUsers,
} from "../../dashboard/auth";
import { createFirstAdmin, UserError } from "../../db/users";
import { config } from "../../config";
import { log, errFields } from "../../logger";

export const authRoutes = new Hono();

authRoutes.get(
  "/setup-status",
  describeRoute({
    tags: ["Auth"],
    summary: "Estado do setup (first-access)",
    responses: { 200: jsonContent(setupStatusResponse, "Setup status") },
  }),
  (c) => c.json({ needsSetup: countUsers() === 0 })
);

authRoutes.post(
  "/setup",
  describeRoute({
    tags: ["Auth"],
    summary: "Cria o primeiro admin (first-access)",
    responses: {
      200: jsonContent(loginResponse, "Admin criado"),
      400: jsonContent(errorBody, "Validação falhou"),
      409: jsonContent(errorBody, "Setup já concluído"),
      500: jsonContent(errorBody, "Erro interno"),
    },
  }),
  validator("json", setupBody),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const user = await createFirstAdmin({
        name: body.name,
        email: typeof body.email === "string" ? body.email : null,
        username: body.username,
        password: body.password,
      });
      log.dashboard.info({ user: user.username }, "first-access: admin inicial criado");
      const token = await issueToken(user.id);
      setSessionCookie(c, token);
      return c.json({ ok: true as const, user });
    } catch (e) {
      if (e instanceof UserError) return c.json({ error: e.message }, e.status as 400);
      log.dashboard.error(errFields(e), "first-access setup failed");
      return c.json({ error: "falha ao criar o usuário inicial" }, 500);
    }
  }
);

authRoutes.post(
  "/login",
  describeRoute({
    tags: ["Auth"],
    summary: "Login na dashboard",
    responses: {
      200: jsonContent(loginResponse, "Login OK"),
      401: jsonContent(errorBody, "Credenciais inválidas"),
      403: jsonContent(errorBody, "Usuário inativo"),
      429: jsonContent(errorBody, "Muitas tentativas"),
      500: jsonContent(errorBody, "Auth não configurada"),
    },
  }),
  validator("json", loginBody),
  async (c) => {
    const ip = c.req.header("x-forwarded-for") ?? "local";
    if (loginThrottled(ip)) {
      log.dashboard.warn({ ip }, "dashboard login throttled");
      return c.json({ error: "too many attempts, try again in a minute" }, 429);
    }

    if (!config.dashboard.sessionSecret) {
      log.dashboard.error("dashboard login attempted but DASHBOARD_SESSION_SECRET not configured");
      return c.json({ error: "dashboard auth not configured (DASHBOARD_SESSION_SECRET)" }, 500);
    }

    const body = c.req.valid("json");
    // aceita `username` (novo) e `user` (nome antigo do payload) — mesma coisa
    const username =
      typeof body.username === "string"
        ? body.username
        : typeof body.user === "string"
          ? body.user
          : "";
    const password = typeof body.password === "string" ? body.password : "";

    const row = findByUsername(username);
    const ok = row ? await verifyPassword(password, row.passwordHash) : false;
    if (!row || !ok) {
      log.dashboard.warn({ ip }, "dashboard login failed");
      return c.json({ error: "credenciais inválidas" }, 401);
    }
    if (row.status !== "active") {
      log.dashboard.warn({ ip, user: row.username }, "dashboard login rejected: user inactive");
      return c.json({ error: "usuário inativo" }, 403);
    }

    touchLastLogin(row.id);
    setSessionCookie(c, await issueToken(row.id));
    log.dashboard.info({ user: row.username }, "dashboard login ok");
    return c.json({ ok: true as const, user: toSafeUser(row) });
  }
);

authRoutes.post(
  "/logout",
  describeRoute({
    tags: ["Auth"],
    summary: "Logout da dashboard",
    responses: { 200: jsonContent(okBody, "Logout OK") },
  }),
  (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true as const });
  }
);

authRoutes.get(
  "/me",
  describeRoute({
    tags: ["Auth"],
    summary: "Usuário da sessão atual",
    responses: { 200: jsonContent(meResponse, "Sessão atual") },
  }),
  async (c) => {
    const user = await resolveSessionUser(c);
    if (!user) return c.json({ authenticated: false as const });
    return c.json({ authenticated: true as const, user });
  }
);
