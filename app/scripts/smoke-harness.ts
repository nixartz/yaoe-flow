#!/usr/bin/env bun
// Smoke test por harness real (§9.2) — roda CONTRA a dashboard já em execução
// (bun run dev) e uma issue de sandbox (ver ../sandbox/README.md). Não é um
// teste de CI: precisa do harness instalado/logado, credenciais reais do
// Linear/GitHub, e produz efeitos reais no repo de sandbox.
//
// Uso:
//   SMOKE_HARNESS=goose SMOKE_ISSUE=SANDBOX-1 \
//   DASHBOARD_URL=http://localhost:4791 DASHBOARD_USER=admin DASHBOARD_PASSWORD=... \
//   bun scripts/smoke-harness.ts
import process from "node:process";

const BASE = process.env.DASHBOARD_URL ?? "http://localhost:4791";
const HARNESS = process.env.SMOKE_HARNESS;
const ISSUE = process.env.SMOKE_ISSUE;
const USER = process.env.DASHBOARD_USER;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!HARNESS || !ISSUE || !USER || !PASSWORD) {
  console.error(
    "uso: SMOKE_HARNESS=<id> SMOKE_ISSUE=<identifier> DASHBOARD_USER=... DASHBOARD_PASSWORD=... bun scripts/smoke-harness.ts"
  );
  process.exit(1);
}

let cookie = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init?.headers ?? {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} — ${await res.text()}`);
  return res.json() as Promise<T>;
}

function step(label: string): void {
  console.log(`\n▶ ${label}`);
}

async function main(): Promise<void> {
  step(`login (${USER})`);
  await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: USER, password: PASSWORD }) });
  console.log("  ✓ autenticado");

  step(`detect (${HARNESS})`);
  const { detection } = await api<{ detection: { installed: boolean; authStatus: string; version?: string } }>(
    `/api/harness/${HARNESS}/redetect`,
    { method: "POST" }
  );
  console.log(`  instalado=${detection.installed} auth=${detection.authStatus} versão=${detection.version ?? "?"}`);
  if (!detection.installed) throw new Error(`${HARNESS} não está instalado nesta máquina`);

  step(`dispatch manual (${ISSUE})`);
  const dispatch = await api<{ dispatched: boolean; reason?: string }>(`/api/dispatch/${encodeURIComponent(ISSUE!)}`, {
    method: "POST",
  });
  if (!dispatch.dispatched) throw new Error(`dispatch não elegível: ${dispatch.reason}`);
  console.log("  ✓ despachado — acompanhe o run na tela Ao vivo/Histórico da dashboard");

  console.log(
    "\nPróximos passos manuais (ver ../sandbox/README.md): confirmar footprint/PR/merge no ciclo completo, " +
      "e testar 'Encerrar' num segundo run pra validar kill/reclaim."
  );
}

main().catch((e) => {
  console.error(`\n✗ smoke test falhou: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
