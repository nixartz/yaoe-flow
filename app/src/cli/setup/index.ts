// `yaoe-flow setup`:
//   • First run (no completion marker in config.env): full guided wizard, in
//     order, idempotent — at the end it writes YAOE_SETUP_COMPLETED_AT, which
//     unlocks `yaoe-flow daemon`.
//   • Later runs: navigable menu — view current configuration, re-run any
//     individual section, or run the whole wizard again.
//   • --non-interactive --config <file>: reads answers from a KEY=VALUE file
//     (VM provisioning via script/cloud-init) instead of prompting.
import { existsSync, readFileSync } from "node:fs";
import { bootstrap } from "../../config/bootstrap";
import { flagBool, flagStr } from "../args";
import { markSetupCompleted, readConfigEnv, SETUP_COMPLETED_KEY } from "./configEnv";
import { choose, maskSecret } from "./prompt";
import {
  stepDirsKeys,
  stepFirstAdmin,
  stepGithub,
  stepHarness,
  stepHarnessDeps,
  stepInstallLocal,
  stepLinear,
  stepService,
  stepSummary,
  stepSystemDeps,
  stepValkey,
  type StepResult,
} from "./steps";

function loadNonInteractiveConfig(path: string): void {
  if (!existsSync(path)) {
    console.error(`yaoe-flow setup: --config ${path} not found.`);
    process.exit(1);
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key) process.env[key] = value;
  }
}

function printHeader(): void {
  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log("│  YAOE-FLOW — Yet Another Orchestration Engine-Flow           │");
  console.log("└──────────────────────────────────────────────────────────────┘");
  console.log(`YAOE_HOME: ${bootstrap.yaoeHome}`);
  console.log(`config:    ${bootstrap.yaoeConfigEnvPath}\n`);
}

function refuseRoot(): void {
  // Host security: same rationale as `yaoe-flow daemon` — the subscription
  // CLIs keep credentials in the logged-in user's HOME.
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    console.error("yaoe-flow setup: refusing to run as root.");
    process.exit(1);
  }
}

async function runFullWizard(nonInteractive: boolean, flags: Record<string, string | boolean>): Promise<void> {
  const results: StepResult[] = [];
  const run = async (fn: () => Promise<StepResult>, label: string): Promise<void> => {
    try {
      results.push(await fn());
    } catch (e) {
      // A validation failure never leaves the setup "silently half-configured":
      // everything already validated STAYS (each step persisted what it
      // confirmed), and the summary shows exactly where it stopped.
      console.error(`\n❌ Step "${label}" failed: ${String(e)}`);
      results.push({ step: label, status: "pending", detail: String(e) });
      stepSummary(results);
      process.exit(1);
    }
  };

  await run(stepSystemDeps, "System dependencies");
  await run(stepDirsKeys, "Directories and keys");
  await run(() => stepValkey(nonInteractive), "Valkey");
  await run(() => stepLinear(nonInteractive, process.env.SETUP_WEBHOOK_URL), "Linear");
  await run(() => stepGithub(nonInteractive), "GitHub");
  await run(() => stepFirstAdmin(nonInteractive), "First admin");
  await run(() => stepHarnessDeps(nonInteractive, flags), "Harness dependencies");
  await run(() => stepHarness(nonInteractive), "Harness detection");
  await run(() => stepInstallLocal(nonInteractive, flags), "Local binary");
  await run(() => stepService(nonInteractive, flags), "System service");

  // Marks completion even with pending items: the operator saw the summary and
  // knows what is missing; the daemon gate is about "the wizard ran", not
  // "everything is perfect" (doctor covers the rest).
  markSetupCompleted();
  stepSummary(results);
}

/** "View current configuration" menu entry — read-only summary, secrets masked. */
async function showCurrentConfig(): Promise<void> {
  const { resolveSetting } = await import("../../config/service");
  const show = (key: string, opts?: { secret?: boolean }) => {
    try {
      const r = resolveSetting(key);
      const raw = r.raw?.trim() ?? "";
      const display = !raw ? "(not set)" : opts?.secret ? maskSecret(raw) : raw;
      console.log(`  ${key.padEnd(28)} ${display}${r.source !== "default" ? `  [${r.source}]` : ""}`);
    } catch {
      console.log(`  ${key.padEnd(28)} (unavailable — database not readable)`);
    }
  };

  console.log("\nService");
  console.log(`  ${"YAOE_HOME".padEnd(28)} ${bootstrap.yaoeHome}`);
  console.log(`  ${"API".padEnd(28)} http://${bootstrap.host}:${bootstrap.port}`);
  console.log(`  ${"Dashboard".padEnd(28)} http://${bootstrap.host}:${bootstrap.dashboardPort}`);
  show("VALKEY_URL");
  show("ORCHESTRATOR_ENABLED");
  console.log("\nLinear");
  show("LINEAR_API_KEY", { secret: true });
  show("LINEAR_TEAM_KEY");
  show("LINEAR_WEBHOOK_SECRET", { secret: true });
  console.log("\nGitHub");
  show("GITHUB_TOKEN", { secret: true });
  show("AGENT_AUTHORIZED_ORGS");
  console.log("\nModels / harnesses");
  show("OPENROUTER_API_KEY", { secret: true });
  show("HERMES_BASE_URL");
  show("WORKSPACE_ROOT");
  console.log("\nCapacity");
  show("MAX_PMO_WORKERS");
  show("MAX_DEV_WORKERS");
  show("MAX_REVIEWER_WORKERS");
  show("MAX_ORCHESTRATOR_WORKERS");
  console.log("\n(everything is editable in more detail on the dashboard Config screen)");
}

async function runMenu(flags: Record<string, string | boolean>): Promise<void> {
  const completedAt = readConfigEnv().get(SETUP_COMPLETED_KEY);
  console.log(`Setup already completed (${completedAt}). What do you want to do?\n`);

  for (;;) {
    const choice = await choose("Configuration menu:", [
      { label: "View current configuration", value: "view" },
      { label: "Linear (API key, team, labels, webhook)", value: "linear" },
      { label: "GitHub (token, authorized orgs)", value: "github" },
      { label: "Valkey (locks database)", value: "valkey" },
      { label: "Harness dependencies (install ACPs/CLIs)", value: "harness-deps" },
      { label: "Harness detection + OpenRouter key", value: "harness" },
      { label: "Admin user (first admin)", value: "admin" },
      { label: "Local binary (recompile/install)", value: "binary" },
      { label: "System service (systemd/launchd/Task Scheduler)", value: "service" },
      { label: "Run the FULL wizard again", value: "full" },
      { label: "Exit", value: "exit" },
    ]);

    switch (choice.value) {
      case "view":
        await showCurrentConfig();
        break;
      case "linear":
        await stepLinear(false, process.env.SETUP_WEBHOOK_URL);
        break;
      case "github":
        await stepGithub(false);
        break;
      case "valkey":
        await stepValkey(false);
        break;
      case "harness-deps":
        await stepHarnessDeps(false, flags);
        break;
      case "harness":
        await stepHarness(false);
        break;
      case "admin":
        await stepFirstAdmin(false);
        break;
      case "binary":
        await stepInstallLocal(false, flags);
        break;
      case "service":
        await stepService(false, flags);
        break;
      case "full":
        await runFullWizard(false, flags);
        return;
      case "exit":
        return;
    }
    console.log("");
  }
}

export async function cmdSetup(flags: Record<string, string | boolean>): Promise<void> {
  const nonInteractive = flagBool(flags, "non-interactive");
  const configPath = flagStr(flags, "config");

  if (nonInteractive) {
    if (!configPath) {
      console.error("yaoe-flow setup: --non-interactive requires --config <file>.");
      process.exit(1);
    }
    loadNonInteractiveConfig(configPath);
  }

  refuseRoot();
  printHeader();

  const alreadyCompleted = Boolean(readConfigEnv().get(SETUP_COMPLETED_KEY));

  if (nonInteractive || !alreadyCompleted) {
    if (!nonInteractive) {
      console.log("First run detected — starting the guided wizard.");
      console.log("You will need (REQUIRED): a Linear API key, a GitHub token, and a local");
      console.log("Valkey/Redis. Optional: harness CLIs (Claude Code, Cursor, Codex, Goose,");
      console.log("Copilot), an OpenRouter API key, and a public webhook URL.\n");
    }
    await runFullWizard(nonInteractive, flags);
    return;
  }

  await runMenu(flags);
}
