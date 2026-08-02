// Preload do `bun test` (ver bunfig.toml): roda antes de qualquer import de
// módulo da aplicação. Fixa a chave de criptografia e aponta o banco pra um
// arquivo temporário por execução — os testes nunca tocam banco real.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));

process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
process.env.DASHBOARD_DB_PATH = join(dir, "test.sqlite");
process.env.DASHBOARD_SESSION_SECRET = "test-session-secret";

// O bun carrega .env do cwd automaticamente — remove qualquer variável que os
// testes de precedência manipulam, pra partir de um estado conhecido.
for (const key of [
  "MAX_DEV_WORKERS",
  "MAX_PMO_WORKERS",
  "MAX_REVIEWER_WORKERS",
  "MAX_ORCHESTRATOR_WORKERS",
  "MAX_WORKERS",
  "MAX_REFINERS",
  "TICK_INTERVAL_MS",
  "LINEAR_API_KEY",
  "ORCHESTRATOR_ENABLED",
  "LOG_LEVEL",
  "DASHBOARD_USER",
  "DASHBOARD_PASSWORD",
]) {
  delete process.env[key];
}

// Diretório exportado pros testes de migration criarem bancos próprios.
export const TEST_TMP_DIR = dir;
