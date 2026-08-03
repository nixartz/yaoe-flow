#!/usr/bin/env bun
// Real-harness smoke test — runs AGAINST the dashboard already running
// (bun run dev) and a sandbox issue (see ../sandbox/README.md). Not a CI
// test: it needs the harness installed/logged in, real Linear/GitHub
// credentials, and it produces real effects in the sandbox repo.
//
// Usage:
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
    "usage: SMOKE_HARNESS=<id> SMOKE_ISSUE=<identifier> DASHBOARD_USER=... DASHBOARD_PASSWORD=... bun scripts/smoke-harness.ts"
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
  console.log("  ✓ authenticated");

  step(`detect (${HARNESS})`);
  const { detection } = await api<{ detection: { installed: boolean; authStatus: string; version?: string } }>(
    `/api/harness/${HARNESS}/redetect`,
    { method: "POST" }
  );
  console.log(`  installed=${detection.installed} auth=${detection.authStatus} version=${detection.version ?? "?"}`);
  if (!detection.installed) throw new Error(`${HARNESS} is not installed on this machine`);

  step(`manual dispatch (${ISSUE})`);
  const dispatch = await api<{ dispatched: boolean; reason?: string }>(`/api/dispatch/${encodeURIComponent(ISSUE!)}`, {
    method: "POST",
  });
  if (!dispatch.dispatched) throw new Error(`dispatch not eligible: ${dispatch.reason}`);
  console.log("  ✓ dispatched — follow the run on the dashboard's Live/History screen");

  console.log(
    "\nManual next steps (see ../sandbox/README.md): confirm footprint/PR/merge through the full cycle, " +
      "and test 'Stop' on a second run to validate kill/reclaim."
  );
}

main().catch((e) => {
  console.error(`\n✗ smoke test failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
