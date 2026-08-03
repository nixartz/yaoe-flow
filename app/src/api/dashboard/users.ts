import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { jsonContent } from "../shared/openapi";
import { errorBody, okBody, idParam, looseObject } from "../shared/schemas";
import { createUserBody, updateUserBody, changePasswordBody } from "./users.schema";
import * as usersRepo from "../../db/users";
import { UserError } from "../../db/users";
import { authUser } from "../../dashboard/auth";
import { log } from "../../logger";

export const usersRoutes = new Hono();

usersRoutes.get(
  "/users",
  describeRoute({
    tags: ["Users"],
    summary: "List users",
    responses: { 200: jsonContent(looseObject, "Usuários") },
  }),
  (c) => c.json({ users: usersRepo.listUsers() })
);

usersRoutes.post(
  "/users",
  describeRoute({
    tags: ["Users"],
    summary: "Create user",
    responses: {
      200: jsonContent(okBody.extend({ user: looseObject }), "Criado"),
      400: jsonContent(errorBody, "Erro de validação"),
    },
  }),
  validator("json", createUserBody),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const user = await usersRepo.createUser({
        name: body.name,
        email: body.email ?? null,
        username: body.username,
        password: body.password,
      });
      log.dashboard.info({ user: user.username, by: authUser(c).username }, "user created via dashboard");
      return c.json({ ok: true as const, user });
    } catch (e) {
      if (e instanceof UserError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

usersRoutes.patch(
  "/users/:id",
  describeRoute({
    tags: ["Users"],
    summary: "Update user",
    responses: {
      200: jsonContent(okBody.extend({ user: looseObject }), "Atualizado"),
      400: jsonContent(errorBody, "Erro"),
    },
  }),
  validator("param", idParam),
  validator("json", updateUserBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const user = await usersRepo.updateUser(id, {
        name: body.name,
        email: body.email,
        status: body.status,
        password: body.password,
      });
      log.dashboard.info({ user: user.username, by: authUser(c).username }, "user updated via dashboard");
      return c.json({ ok: true as const, user });
    } catch (e) {
      if (e instanceof UserError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);

usersRoutes.post(
  "/profile/password",
  describeRoute({
    tags: ["Users"],
    summary: "Change your own password (requires the current password)",
    responses: {
      200: jsonContent(okBody, "Senha alterada"),
      400: jsonContent(errorBody, "Erro de validação"),
    },
  }),
  validator("json", changePasswordBody),
  async (c) => {
    const body = c.req.valid("json");
    try {
      await usersRepo.changeOwnPassword(authUser(c).id, body.currentPassword, body.newPassword);
      return c.json({ ok: true as const });
    } catch (e) {
      if (e instanceof UserError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  }
);
