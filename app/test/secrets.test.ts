// §9.3: roundtrip cifra/decifra, formato versionado, adulteração falha limpo.
import { describe, expect, test } from "bun:test";
import { encryptSecret, decryptSecret, isEncrypted } from "../src/db/secrets";

describe("secrets (AES-256-GCM at-rest)", () => {
  test("roundtrip cifra e decifra", () => {
    const plain = "lin_api_um_segredo_bem_secreto_123";
    const stored = encryptSecret(plain);
    expect(stored).not.toContain(plain);
    expect(decryptSecret(stored)).toBe(plain);
  });

  test("formato versionado enc:v1:<iv>:<tag>:<ciphertext>", () => {
    const stored = encryptSecret("x");
    expect(isEncrypted(stored)).toBe(true);
    const parts = stored.split(":");
    expect(parts[0]).toBe("enc");
    expect(parts[1]).toBe("v1");
    expect(parts).toHaveLength(5);
    expect(parts[2]).toHaveLength(24); // IV 12 bytes em hex
    expect(parts[3]).toHaveLength(32); // auth tag 16 bytes em hex
  });

  test("IV aleatório: mesmo plaintext nunca gera o mesmo ciphertext", () => {
    expect(encryptSecret("mesmo valor")).not.toBe(encryptSecret("mesmo valor"));
  });

  test("valor adulterado (auth tag) falha limpo, sem devolver lixo", () => {
    const stored = encryptSecret("segredo");
    const parts = stored.split(":");
    parts[3] = parts[3].replace(/^./, parts[3][0] === "0" ? "1" : "0");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  test("valor legado em claro (pré-criptografia) é lido como está", () => {
    expect(decryptSecret("valor-antigo-em-claro")).toBe("valor-antigo-em-claro");
  });
});
