// §9.3: argon2id, first-access à prova de corrida (2ª criação falha), guarda
// do último admin ativo, troca de senha exigindo a atual.
import { describe, expect, test } from "bun:test";
import {
  createFirstAdmin,
  createUser,
  updateUser,
  changeOwnPassword,
  findByUsername,
  verifyPassword,
  listUsers,
  UserError,
} from "../src/db/users";

describe("users e auth", () => {
  test("first-access cria o admin com hash argon2id (nunca a senha em claro)", async () => {
    const admin = await createFirstAdmin({ name: "Admin Um", username: "admin1", password: "senha-muito-boa" });
    expect(admin.status).toBe("active");
    expect(admin.type).toBe("administrator");
    const row = findByUsername("admin1")!;
    expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(row.passwordHash).not.toContain("senha-muito-boa");
    expect(await verifyPassword("senha-muito-boa", row.passwordHash)).toBe(true);
    expect(await verifyPassword("senha-errada", row.passwordHash)).toBe(false);
  });

  test("first-access só existe com a tabela vazia (2ª tentativa: 409)", async () => {
    expect(createFirstAdmin({ name: "Intruso", username: "intruso", password: "12345678ok" })).rejects.toThrow(
      /já foi concluído/
    );
  });

  test("username duplicado é rejeitado (409)", async () => {
    expect(createUser({ name: "Clone", username: "admin1", password: "12345678ok" })).rejects.toThrow(UserError);
  });

  test("senha curta é rejeitada", async () => {
    // 9 chars < MIN_PASSWORD_LENGTH (10)
    expect(createUser({ name: "Curto", username: "curto", password: "123456789" })).rejects.toThrow(/10 caracteres/);
  });

  test("não inativa o último administrador ativo", async () => {
    const admin = findByUsername("admin1")!;
    expect(updateUser(admin.id, { status: "inactive" })).rejects.toThrow(/último administrador/);
  });

  test("com um segundo admin ativo, inativar (e reativar) funciona", async () => {
    const second = await createUser({ name: "Admin Dois", username: "admin2", password: "outra-senha-ok" });
    const updated = await updateUser(second.id, { status: "inactive" });
    expect(updated.status).toBe("inactive");
    expect(listUsers().filter((u) => u.status === "active")).toHaveLength(1);
    await updateUser(second.id, { status: "active" });
  });

  test("trocar a própria senha exige a senha atual", async () => {
    const admin = findByUsername("admin1")!;
    expect(changeOwnPassword(admin.id, "senha-errada", "nova-senha-ok")).rejects.toThrow(/senha atual/);
    await changeOwnPassword(admin.id, "senha-muito-boa", "nova-senha-ok");
    expect(await verifyPassword("nova-senha-ok", findByUsername("admin1")!.passwordHash)).toBe(true);
  });
});
