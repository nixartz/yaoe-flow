// Usuários da dashboard (§5.3, D7): CRUD simples sobre a tabela `users`.
// Senha: argon2id via Bun.password. Sem hard-delete — inativar (status) é o
// caminho; a guarda de "último admin ativo" vive aqui pra valer em qualquer
// chamador (API, seed, testes).
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { appDb } from "./index";
import { users } from "./schema";

export type UserRow = typeof users.$inferSelect;

/** Shape que sai pra API — NUNCA inclui passwordHash. */
export interface SafeUser {
  id: string;
  name: string;
  email: string | null;
  username: string;
  status: "active" | "inactive";
  type: "administrator";
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Política única (docs/daemon-binary.md §5 + dashboard first-access). */
export const MIN_PASSWORD_LENGTH = 10;

export function toSafeUser(row: UserRow): SafeUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    status: row.status as SafeUser["status"],
    type: row.type as SafeUser["type"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

function validateUsername(username: string): void {
  if (!/^[a-zA-Z0-9._@-]{2,64}$/.test(username)) {
    throw new UserError("username inválido (2–64 caracteres: letras, números, ponto, hífen, _, @)");
  }
}

function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError(`senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
}

export function countUsers(): number {
  const { sqlite } = appDb();
  const row = sqlite.query(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
  return row.c;
}

export function findByUsername(username: string): UserRow | undefined {
  const { orm } = appDb();
  return orm.select().from(users).where(eq(users.username, username)).get();
}

export function findById(id: string): UserRow | undefined {
  const { orm } = appDb();
  return orm.select().from(users).where(eq(users.id, id)).get();
}

export function listUsers(): SafeUser[] {
  const { orm } = appDb();
  return orm.select().from(users).all().map(toSafeUser);
}

export interface CreateUserInput {
  name: string;
  email?: string | null;
  username: string;
  password: string;
}

export async function createUser(input: CreateUserInput): Promise<SafeUser> {
  validateUsername(input.username);
  validatePassword(input.password);
  if (!input.name?.trim()) throw new UserError("nome é obrigatório");

  const { orm } = appDb();
  const now = Date.now();
  const row: typeof users.$inferInsert = {
    id: randomUUID(),
    name: input.name.trim(),
    email: input.email?.trim() || null,
    username: input.username.trim(),
    passwordHash: await hashPassword(input.password),
    status: "active",
    type: "administrator",
    createdAt: now,
    updatedAt: now,
  };
  try {
    orm.insert(users).values(row).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new UserError("username ou e-mail já em uso", 409);
    throw e;
  }
  return toSafeUser({ ...row, email: row.email ?? null, lastLoginAt: null } as UserRow);
}

/**
 * Cria o PRIMEIRO admin (first-access §5.3) à prova de corrida: transação
 * IMMEDIATE + re-checagem de tabela vazia dentro dela — duas submissões
 * concorrentes nunca criam dois admins.
 */
export async function createFirstAdmin(input: CreateUserInput): Promise<SafeUser> {
  validateUsername(input.username);
  validatePassword(input.password);
  if (!input.name?.trim()) throw new UserError("nome é obrigatório");

  const { sqlite } = appDb();
  const passwordHash = await hashPassword(input.password);
  const now = Date.now();
  const id = randomUUID();

  const insert = sqlite.transaction(() => {
    const row = sqlite.query(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
    if (row.c > 0) throw new UserError("setup já foi concluído — já existe usuário cadastrado", 409);
    sqlite
      .query(
        `INSERT INTO users (id, name, email, username, password_hash, status, type, created_at, updated_at)
         VALUES ($id, $name, $email, $username, $hash, 'active', 'administrator', $now, $now)`
      )
      .run({
        $id: id,
        $name: input.name.trim(),
        $email: input.email?.trim() || null,
        $username: input.username.trim(),
        $hash: passwordHash,
        $now: now,
      });
  });
  insert.immediate();

  const created = findById(id);
  if (!created) throw new UserError("falha ao criar usuário", 500);
  return toSafeUser(created);
}

export interface UpdateUserInput {
  name?: string;
  email?: string | null;
  status?: "active" | "inactive";
  password?: string;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<SafeUser> {
  const { orm } = appDb();
  const existing = findById(id);
  if (!existing) throw new UserError("usuário não encontrado", 404);

  if (input.status === "inactive" && existing.status === "active") {
    // Não permitir inativar o último admin ativo (§5.3).
    const others = orm
      .select()
      .from(users)
      .where(and(eq(users.status, "active"), ne(users.id, id)))
      .all();
    if (others.length === 0) throw new UserError("não é possível inativar o último administrador ativo", 409);
  }
  if (input.status && input.status !== "active" && input.status !== "inactive") {
    throw new UserError("status deve ser active ou inactive");
  }

  const set: Partial<typeof users.$inferInsert> = { updatedAt: Date.now() };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new UserError("nome é obrigatório");
    set.name = input.name.trim();
  }
  if (input.email !== undefined) set.email = input.email?.trim() || null;
  if (input.status !== undefined) set.status = input.status;
  if (input.password !== undefined) {
    validatePassword(input.password);
    set.passwordHash = await hashPassword(input.password);
  }

  try {
    orm.update(users).set(set).where(eq(users.id, id)).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new UserError("e-mail já em uso", 409);
    throw e;
  }
  return toSafeUser(findById(id)!);
}

export async function changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = findById(id);
  if (!user) throw new UserError("usuário não encontrado", 404);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new UserError("senha atual incorreta", 403);
  }
  validatePassword(newPassword);
  const { orm } = appDb();
  orm.update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: Date.now() }).where(eq(users.id, id)).run();
}

export function touchLastLogin(id: string): void {
  const { orm } = appDb();
  orm.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, id)).run();
}
