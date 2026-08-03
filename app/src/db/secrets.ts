// Criptografia at-rest dos segredos gravados no SQLite (§5.2 do blueprint):
// AES-256-GCM com IV aleatório por valor e auth tag armazenada junto, no
// formato versionado `enc:v1:<iv>:<tag>:<ciphertext>` (hex) — o prefixo `v1`
// permite rotacionar o esquema no futuro sem quebrar valores antigos.
//
// A UI NUNCA recebe um segredo de volta em claro: editar = enviar valor novo.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { bootstrap } from "../config/bootstrap";

const PREFIX = "enc:v1:";
const KEY_HEX_LENGTH = 64; // 32 bytes

export class EncryptionKeyError extends Error {}

function keyBytes(): Buffer {
  assertEncryptionKey();
  return Buffer.from(bootstrap.appEncryptionKey, "hex");
}

/**
 * Falha o boot com instrução clara quando APP_ENCRYPTION_KEY está ausente ou
 * malformada (critério de aceite §5.8). Chamada na abertura do banco — nada
 * que persista/leia segredo roda sem passar por aqui.
 */
export function assertEncryptionKey(): void {
  const key = bootstrap.appEncryptionKey;
  if (!key || !/^[0-9a-fA-F]+$/.test(key) || key.length !== KEY_HEX_LENGTH) {
    throw new EncryptionKeyError(
      "APP_ENCRYPTION_KEY missing or invalid. It is required to encrypt secrets in the database (at rest). " +
        "Generate one with `openssl rand -hex 32` and set APP_ENCRYPTION_KEY in the environment (.env) before starting the service. " +
        "WARNING: changing the key afterwards makes previously stored secrets unreadable."
    );
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    // Tolerância a valor legado gravado antes da criptografia existir — lê em
    // claro; a próxima escrita já sai cifrada.
    return stored;
  }
  const [ivHex, tagHex, ctHex] = stored.slice(PREFIX.length).split(":");
  if (!ivHex || !tagHex || ctHex === undefined) {
    throw new EncryptionKeyError("segredo armazenado em formato inválido (esperado enc:v1:<iv>:<tag>:<ciphertext>)");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}
