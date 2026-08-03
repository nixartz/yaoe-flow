// Captures the dashboard documentation screenshots: navigates the REAL
// dashboard (headless Chrome via puppeteer-core, 1280×800 viewport, light
// theme) logged into a database populated by seed-demo — never with real
// data.
//
// Prerequisites:
//   1. demo database: DASHBOARD_DB_PATH=/tmp/demo.sqlite bun scripts/seed-demo.ts
//   2. service:        same DASHBOARD_DB_PATH + DASHBOARD_STATIC_DIR=../dashboard/dist
//   3. (optional) a 2nd service with an EMPTY database for the first-access screen
//
// Uso:
//   BASE_URL=http://localhost:14791 DEMO_USER=ana DEMO_PASSWORD=... \
//   FIRST_ACCESS_URL=http://localhost:14792 \
//   OUT_DIR=../docs/images/dashboard bun scripts/capture-dashboard-prints.ts
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:14791";
const FIRST_ACCESS_URL = process.env.FIRST_ACCESS_URL ?? "";
const DEMO_USER = process.env.DEMO_USER ?? "ana";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const OUT_DIR = resolve(process.env.OUT_DIR ?? resolve(import.meta.dir, "..", "..", "docs", "images", "dashboard"));
const CHROME =
  process.env.CHROME_BIN ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
    (p) => {
      try {
        return require("node:fs").existsSync(p);
      } catch {
        return false;
      }
    }
  );

if (!CHROME) {
  console.error("Chrome not found — set CHROME_BIN.");
  process.exit(1);
}

async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Capture standard: always light theme.
  await page.evaluateOnNewDocument(() => localStorage.setItem("dashboard-theme", "light"));
  return page;
}

// SSE keeps the connection open and goto sometimes never resolves the
// lifecycle — navigate with a short timeout and move on; the screenshot
// waits a fixed settle time afterward.
async function nav(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
}

async function shot(page: Page, rel: string): Promise<void> {
  const path = resolve(OUT_DIR, rel);
  mkdirSync(dirname(path), { recursive: true });
  // `networkidle` never fires with SSE open — fixed wait for charts/queries.
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path as `${string}.png` });
  console.log(`✓ ${rel}`);
}

async function main(): Promise<void> {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await newPage(browser);

  // Login
  await nav(page, `${BASE_URL}/login`);
  await shot(page, "login/01-login.png");
  await page.type('input[placeholder="usuário"]', DEMO_USER);
  await page.type('input[placeholder="senha"]', DEMO_PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }).catch(() => {}), page.click('button[type="submit"]')]);
  await new Promise((r) => setTimeout(r, 1200));

  // Main screens
  await nav(page, `${BASE_URL}/`);
  await shot(page, "overview/01-visao-geral.png");
  await nav(page, `${BASE_URL}/live`);
  await shot(page, "live/01-ao-vivo.png");
  await nav(page, `${BASE_URL}/history`);
  await shot(page, "history/01-historico.png");
  // RunDetailSheet: opens the first run in the table
  const firstRow = await page.$("table tbody tr");
  if (firstRow) {
    await firstRow.click();
    await new Promise((r) => setTimeout(r, 800));
    await shot(page, "history/02-run-detail.png");
    await page.keyboard.press("Escape");
  }
  await nav(page, `${BASE_URL}/webhooks`);
  await shot(page, "webhooks/01-webhooks.png");
  await nav(page, `${BASE_URL}/logs`);
  await shot(page, "logs/01-logs.png");

  // Config: overview, search + inline edit
  await nav(page, `${BASE_URL}/config`);
  await shot(page, "config/01-configuracao.png");
  await page.waitForSelector('input[placeholder="Buscar por nome ou descrição…"]', { timeout: 10_000 });
  await page.type('input[placeholder="Buscar por nome ou descrição…"]', "MAX_DEV_WORKERS");
  await new Promise((r) => setTimeout(r, 400));
  const editBtn = await page.$('button[title="Editar"]');
  if (editBtn) {
    await editBtn.click();
    await new Promise((r) => setTimeout(r, 300));
  }
  await shot(page, "config/02-busca-e-edicao-inline.png");

  // Users: list + new-user form
  await nav(page, `${BASE_URL}/users`);
  await shot(page, "users/01-usuarios.png");
  await page.waitForSelector("table tbody tr", { timeout: 10_000 }).catch(() => {});
  const buttons = await page.$$("button");
  for (const b of buttons) {
    const text = await b.evaluate((el) => el.textContent ?? "");
    if (text.includes("Novo usuário")) {
      await b.click();
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  await shot(page, "users/02-novo-usuario.png");

  // Profile
  await nav(page, `${BASE_URL}/profile`);
  await shot(page, "profile/01-meu-perfil.png");

  // Agents: per-role list + editor (3 tabs)
  await nav(page, `${BASE_URL}/agents`);
  await page.waitForSelector(".cursor-pointer", { timeout: 10_000 }).catch(() => {});
  await shot(page, "agents/01-agents.png");
  const firstAgentCard = await page.$(".cursor-pointer");
  if (firstAgentCard) {
    await firstAgentCard.click();
    await page.waitForSelector('button[role="tab"]', { timeout: 10_000 }).catch(() => {});
    await shot(page, "agents/02-editor-soul.png");
    const tabs = await page.$$('button[role="tab"]');
    for (const tab of tabs) {
      const text = await tab.evaluate((el) => el.textContent ?? "");
      if (text.trim() === "Harness") {
        await tab.click();
        await new Promise((r) => setTimeout(r, 300));
        await shot(page, "agents/03-editor-harness.png");
      }
      if (text.trim() === "MCPs") {
        await tab.click();
        await new Promise((r) => setTimeout(r, 300));
        await shot(page, "agents/04-editor-mcps.png");
      }
    }
  }

  // Harness: detection + capabilities + budgets
  await nav(page, `${BASE_URL}/harness`);
  await page.waitForSelector("h1", { timeout: 10_000 }).catch(() => {});
  await shot(page, "harness/01-harness.png");

  // Notifications: channels + channel×event matrix
  await nav(page, `${BASE_URL}/notifications`);
  await shot(page, "notifications/01-notificacoes.png");

  // First-access (2nd service with an empty database)
  if (FIRST_ACCESS_URL) {
    const fa = await newPage(browser);
    await nav(fa, FIRST_ACCESS_URL);
    await new Promise((r) => setTimeout(r, 800));
    await shot(fa, "login/02-first-access.png");
  }

  await browser.close();
  console.log(`screenshots saved to ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
