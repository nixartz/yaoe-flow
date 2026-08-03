// Autenticação da dashboard (§5.3): sessão JWT + cookie httpOnly.
// Rotas HTTP vivem em api/dashboard/auth.ts — aqui só helpers de sessão/seed.
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { config } from "../config";
import { log, errFields } from "../logger";
import {
  countUsers,
  createUser,
  findById,
  findByUsername,
  toSafeUser,
  touchLastLogin,
  verifyPassword,
  type SafeUser,
} from "../db/users";

export const SESSION_COOKIE = "dashboard_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export function loginThrottled(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > MAX_ATTEMPTS;
}

/**
 * Seed do primeiro admin (§5.3), chamado no boot com o banco pronto:
 *  • tabela vazia + DASHBOARD_USER/PASSWORD no ambiente → cria o admin;
 *  • tabela populada + ENVs presentes → warning de que são ignoradas;
 *  • tabela vazia sem ENVs → modo first-access.
 */
export async function seedAdminFromEnv(): Promise<void> {
  const envUser = config.dashboard.user;
  const envPassword = config.dashboard.password;
  const empty = countUsers() === 0;

  if (!empty) {
    if (envUser || envPassword) {
      log.dashboard.warn(
        "DASHBOARD_USER/DASHBOARD_PASSWORD are set but IGNORED (deprecated): users already exist in the database — manage them on the Users screen and remove the ENVs"
      );
    }
    return;
  }

  if (envUser && envPassword) {
    try {
      await createUser({ name: envUser, username: envUser, password: envPassword, email: null });
      log.dashboard.warn(
        { user: envUser },
        "first admin created from DASHBOARD_USER/DASHBOARD_PASSWORD (DEPRECATED — ignored after this seed; remove them from the environment and manage users on the Users screen)"
      );
    } catch (e) {
      log.dashboard.error(errFields(e), "failed to seed the admin via DASHBOARD_USER/DASHBOARD_PASSWORD");
    }
  } else {
    log.dashboard.info(
      "no user registered — dashboard in first-access mode (setup form on first access)"
    );
  }
}

export async function issueToken(userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return sign({ sub: userId, exp }, config.dashboard.sessionSecret);
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function resolveSessionUser(c: Context): Promise<SafeUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !config.dashboard.sessionSecret) return null;
  try {
    const payload = await verify(token, config.dashboard.sessionSecret, "HS256");
    const id = typeof payload.sub === "string" ? payload.sub : "";
    if (!id) return null;
    const row = findById(id);
    if (!row || row.status !== "active") return null;
    return toSafeUser(row);
  } catch {
    return null;
  }
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const user = await resolveSessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("authUser", user);
  await next();
}

/** Usuário autenticado do request (setado por requireAuth). */
export function authUser(c: Context): SafeUser {
  return c.get("authUser") as SafeUser;
}

// Re-exports úteis pras rotas de auth
export { findByUsername, toSafeUser, touchLastLogin, verifyPassword, countUsers };
