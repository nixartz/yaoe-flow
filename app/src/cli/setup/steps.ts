// Steps of the `yaoe-flow setup` wizard — each function is one step, in
// order, idempotent (running again reviews existing values, never destroys).
//
// Convention: every step announces itself with a [n/11] header, whether it is
// REQUIRED or OPTIONAL, and — when a credential is involved — WHERE to create
// it and WHICH permissions it really needs.
import { randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import Redis from "ioredis";
import { bootstrap } from "../../config/bootstrap";
import { resolveSetting } from "../../config/service";
import { ensureYaoeDirs, installedYaoeBin } from "../paths";
import { findServiceRoot } from "../install-local";
import { readConfigEnv, writeConfigEnv } from "./configEnv";
import { ask, askSecret, askOrKeep, confirm, choose, chooseOrKeep, maskSecret } from "./prompt";
import { createLabel, createWebhook, fetchViewer, fetchOrganization, listTeamLabels, listTeamStates, listTeams } from "./linearAdmin";

const execFileAsync = promisify(execFile);

export interface StepResult {
  step: string;
  status: "done" | "skipped" | "pending";
  detail?: string;
}

/** Effective value only when it came from ENV/db (not an empty default) — for "already configured?". */
function configuredSetting(key: string): string | undefined {
  try {
    const r = resolveSetting(key);
    if (r.source === "default") return undefined;
    const raw = r.raw.trim();
    return raw || undefined;
  } catch {
    // Database cannot open yet (e.g. no APP_ENCRYPTION_KEY) — treat as empty.
    return undefined;
  }
}

async function which(bin: string): Promise<string | null> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(cmd, [bin]);
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

function installHint(pkg: string): string {
  if (process.platform === "darwin") return `install with: brew install ${pkg}`;
  if (process.platform === "win32") return "install via https://git-scm.com/download/win (or winget install --id Git.Git)";
  return `install with your distro's package manager (e.g. apt install ${pkg} / dnf install ${pkg})`;
}

// ── Step 0 — System dependencies (REQUIRED) ──
export async function stepSystemDeps(): Promise<StepResult> {
  console.log("\n[0/11] System dependencies — REQUIRED");
  const git = await which("git");
  if (!git) {
    console.error("❌ git not found — required (agents clone repositories).");
    console.error(`   ${installHint("git")}`);
    process.exit(1);
  }
  console.log(`✅ git: ${git}`);

  const curl = await which("curl");
  console.log(curl ? `✅ curl: ${curl}` : "⚠️  curl not found (recommended for the install one-liner).");

  const harnessBins = ["claude", "codex", "cursor-agent", "copilot", "goose"];
  const found: string[] = [];
  for (const bin of harnessBins) if (await which(bin)) found.push(bin);
  console.log(
    found.length
      ? `ℹ️  harnesses on PATH: ${found.join(", ")} (full detection in step 7)`
      : "ℹ️  no subscription harness found on PATH yet (see steps 6–7)."
  );

  return { step: "System dependencies", status: "done" };
}

// ── Step 1 — Directories and keys (REQUIRED, automatic) ──
export async function stepDirsKeys(): Promise<StepResult> {
  console.log("\n[1/11] Directories and keys — REQUIRED (automatic)");
  ensureYaoeDirs();

  const current = readConfigEnv();
  const updates: Record<string, string> = {};
  if (!current.get("APP_ENCRYPTION_KEY")) {
    updates.APP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    console.log("✅ APP_ENCRYPTION_KEY generated.");
  } else {
    console.log("✅ APP_ENCRYPTION_KEY already exists — kept.");
  }
  if (!current.get("DASHBOARD_SESSION_SECRET")) {
    updates.DASHBOARD_SESSION_SECRET = randomBytes(32).toString("hex");
    console.log("✅ DASHBOARD_SESSION_SECRET generated.");
  } else {
    console.log("✅ DASHBOARD_SESSION_SECRET already exists — kept.");
  }
  if (Object.keys(updates).length > 0) writeConfigEnv(updates);
  // Must also apply to THIS process — the following steps open the database
  // and encrypt settings using bootstrap.appEncryptionKey (getter — see
  // bootstrap.ts).
  for (const [k, v] of Object.entries(updates)) if (process.env[k] === undefined) process.env[k] = v;

  console.log(`✅ directories ready: ${bootstrap.yaoeDataDir}, ${bootstrap.yaoeLogsDir}, ${bootstrap.yaoeWorktreesDir}`);
  console.log(`✅ config.env written: ${bootstrap.yaoeConfigEnvPath} (chmod 600)`);
  return { step: "Directories and keys", status: "done" };
}

// ── Step 2 — Network binding (REQUIRED, default is the safe choice) ──
export async function stepNetwork(nonInteractive: boolean): Promise<StepResult> {
  console.log("\n[2/11] Network binding — REQUIRED (default: this machine only)");
  console.log("By default yaoe-flow only accepts connections from THIS machine (HOST=localhost).");
  console.log("Bind to 0.0.0.0 only if you need to reach it directly from other machines/containers —");
  console.log("if a reverse proxy (nginx/Caddy) on this SAME machine will front it, keep localhost:");
  console.log("the proxy already reaches it over loopback, no bind change needed.\n");

  const current = configuredSetting("HOST");
  // HOST is a common, low-entropy env var name — some shells/containers set it
  // for unrelated reasons, so "configured" here may be neither of the two
  // canned choices. Route anything else to "custom" instead of mislabeling it.
  const isLocal = !current || current === "localhost" || current === "127.0.0.1";
  const currentValue = current === "0.0.0.0" ? "0.0.0.0" : isLocal ? "localhost" : "__custom__";

  let host: string;
  if (nonInteractive) {
    host = (process.env.HOST ?? current ?? "localhost").trim() || "localhost";
  } else {
    const picked = await chooseOrKeep(
      "Who should be able to reach yaoe-flow?",
      [
        { label: "Only this machine (localhost) — safer, recommended", value: "localhost" },
        { label: "Other machines/containers on the network (0.0.0.0)", value: "0.0.0.0" },
        { label: currentValue === "__custom__" ? `Custom bind address (currently: ${current})` : "Custom bind address", value: "__custom__" },
      ],
      currentValue,
      "HOST"
    );
    host =
      picked.value === "__custom__"
        ? (await ask("Bind address:", current ?? "0.0.0.0")).trim() || "0.0.0.0"
        : picked.value;
  }

  if (host !== "localhost" && host !== "127.0.0.1") {
    console.log(`⚠️  binding to ${host} exposes the API (PORT) and dashboard (DASHBOARD_PORT) beyond this machine.`);
    console.log("   Make sure a firewall (or your cloud provider's security group) limits who can reach those ports.");
  }

  writeConfigEnv({ HOST: host });
  console.log(`✅ HOST=${host} (takes effect the next time "yaoe-flow daemon" starts)`);
  return { step: "Network binding", status: "done" };
}

// ── Step 3 — Valkey (REQUIRED) ──
async function pingValkey(url: string): Promise<boolean> {
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export async function stepValkey(nonInteractive: boolean): Promise<StepResult> {
  console.log("\n[3/11] Valkey — REQUIRED");
  console.log("Valkey (or Redis) stores the footprint locks and attempt counters that keep");
  console.log("concurrent agents from colliding. A local instance is perfectly fine.\n");

  const existingUrl =
    process.env.VALKEY_URL?.trim() ||
    readConfigEnv().get("VALKEY_URL")?.trim() ||
    undefined;

  if (existingUrl) {
    const ok = await pingValkey(existingUrl);
    if (ok) {
      console.log(`✅ VALKEY_URL already configured and reachable: ${existingUrl}`);
      if (nonInteractive || !(await confirm("Change the Valkey URL? (Enter = keep)", false))) {
        // Ensure it lands in config.env even if it only came from process.env.
        writeConfigEnv({ VALKEY_URL: existingUrl });
        return { step: "Valkey", status: "done", detail: existingUrl };
      }
    } else {
      console.log(`⚠️  VALKEY_URL already configured but unreachable: ${existingUrl}`);
      if (nonInteractive) {
        return { step: "Valkey", status: "pending", detail: `unreachable: ${existingUrl}` };
      }
      if (!(await confirm("Enter another URL / reinstall? (Enter = keep as is)", true))) {
        writeConfigEnv({ VALKEY_URL: existingUrl });
        return { step: "Valkey", status: "pending", detail: `unreachable: ${existingUrl}` };
      }
    }
  }

  const localUrl = "redis://127.0.0.1:6379";
  if (await pingValkey(localUrl)) {
    console.log(`✅ local Valkey detected (${localUrl}).`);
    writeConfigEnv({ VALKEY_URL: localUrl });
    return { step: "Valkey", status: "done", detail: localUrl };
  }

  if (nonInteractive) {
    console.log("⚠️  Valkey unreachable and --non-interactive — skipping (noted as pending).");
    return { step: "Valkey", status: "pending", detail: "no reachable Valkey" };
  }

  console.log("No local Valkey found. How do you want to resolve this?");
  const hasBrew = process.platform === "darwin" && (await which("brew"));
  const hasApt = await which("apt-get");
  const hasDnf = await which("dnf");
  const hasDocker = await which("docker");

  const options = [
    ...(hasBrew ? [{ label: "install via Homebrew (brew install valkey)", value: "brew" }] : []),
    ...(hasApt ? [{ label: "install via apt (apt-get install -y valkey || redis-server)", value: "apt" }] : []),
    ...(hasDnf ? [{ label: "install via dnf (dnf install -y valkey)", value: "dnf" }] : []),
    ...(hasDocker ? [{ label: "run via Docker (local container)", value: "docker" }] : []),
    { label: "I already have Valkey/Redis on another host — enter the URL", value: "manual" },
    { label: "skip (configure later)", value: "skip" },
  ];
  const choice = await choose("Pick an option:", options);

  if (choice.value === "skip") {
    return { step: "Valkey", status: "pending", detail: "skipped by the user" };
  }

  if (choice.value === "manual") {
    const url = await ask("Valkey/Redis URL (redis://host:port):", existingUrl || localUrl);
    if (await pingValkey(url)) {
      writeConfigEnv({ VALKEY_URL: url });
      console.log("✅ Valkey reachable.");
      return { step: "Valkey", status: "done", detail: url };
    }
    console.log('⚠️  could not PING that URL — saving anyway (check later with "yaoe-flow doctor").');
    writeConfigEnv({ VALKEY_URL: url });
    return { step: "Valkey", status: "pending", detail: url };
  }

  const install = (cmd: string, args: string[]) =>
    confirm(`Run "${cmd} ${args.join(" ")}"?`).then((ok) => (ok ? execFileAsync(cmd, args) : Promise.reject(new Error("cancelled by the user"))));

  try {
    if (choice.value === "brew") await install("brew", ["install", "valkey"]).then(() => execFileAsync("brew", ["services", "start", "valkey"]));
    else if (choice.value === "apt") await install("sudo", ["apt-get", "install", "-y", "valkey"]);
    else if (choice.value === "dnf") await install("sudo", ["dnf", "install", "-y", "valkey"]);
    else if (choice.value === "docker") {
      await install("docker", [
        "run",
        "-d",
        "--name",
        "yaoe-flow-valkey",
        "--restart",
        "unless-stopped",
        "-p",
        "127.0.0.1:6379:6379",
        "valkey/valkey:8-alpine",
      ]);
    }
  } catch (e) {
    console.log(`⚠️  install failed/cancelled (${String(e)}) — skipping (pending).`);
    return { step: "Valkey", status: "pending", detail: String(e) };
  }

  await Bun.sleep(1000);
  if (await pingValkey(localUrl)) {
    writeConfigEnv({ VALKEY_URL: localUrl });
    console.log("✅ Valkey installed and reachable.");
    return { step: "Valkey", status: "done", detail: localUrl };
  }
  console.log('⚠️  installed but not answering PING yet — check later with "yaoe-flow doctor".');
  return { step: "Valkey", status: "pending", detail: "PING failed after install" };
}

// ── Step 4 — Linear (REQUIRED) ──
export async function stepLinear(nonInteractive: boolean, webhookUrlHint?: string): Promise<StepResult> {
  console.log("\n[4/11] Linear — REQUIRED");
  console.log("Linear is the source of truth of the pipeline (statuses, labels, comments).");
  console.log("You need a personal API key:");
  console.log("  • Where: Linear → Settings → Security & access → Personal API keys");
  console.log("    (https://linear.app/settings/account/security)");
  console.log("  • Scope: created keys have full access of the creating user — prefer a");
  console.log("    dedicated service account user if your plan allows it.\n");
  const { setSetting } = await import("../../config/service");

  const existingKey = configuredSetting("LINEAR_API_KEY");
  let apiKey: string;
  if (nonInteractive) {
    apiKey = (process.env.LINEAR_API_KEY ?? existingKey ?? "").trim();
  } else {
    apiKey = await askOrKeep(
      "LINEAR_API_KEY",
      existingKey,
      () => askSecret("Linear API key:"),
      { secret: true }
    );
  }
  if (!apiKey) {
    console.log("⚠️  no API key — skipping Linear (pending).");
    return { step: "Linear", status: "pending", detail: "no API key" };
  }

  let viewer;
  for (;;) {
    try {
      viewer = await fetchViewer(apiKey);
      break;
    } catch (e) {
      console.log(`❌ invalid API key (${String(e)}).`);
      if (nonInteractive) return { step: "Linear", status: "pending", detail: "invalid API key" };
      apiKey = await askSecret("Linear API key (try again):");
      if (!apiKey) {
        console.log("⚠️  no API key — skipping Linear (pending).");
        return { step: "Linear", status: "pending", detail: "no API key" };
      }
    }
  }
  console.log(`✅ logged in as ${viewer.name} (${viewer.email})`);
  setSetting("LINEAR_API_KEY", apiKey, null);

  const teams = await listTeams(apiKey);
  if (teams.length === 0) {
    console.log("⚠️  no team found in that workspace.");
    return { step: "Linear", status: "pending", detail: "no teams" };
  }

  const existingTeamId = configuredSetting("LINEAR_TEAM_ID");
  let team;
  if (nonInteractive) {
    team = teams.find((t) => t.key === process.env.LINEAR_TEAM_KEY) ?? teams.find((t) => t.id === existingTeamId) ?? teams[0]!;
  } else {
    const picked = await chooseOrKeep(
      "Team whose workflow the pipeline will orchestrate:",
      teams.map((t) => ({ label: `${t.name} (${t.key})`, value: t.id })),
      existingTeamId,
      "Linear team"
    );
    team = teams.find((t) => t.id === picked.value)!;
  }
  setSetting("LINEAR_TEAM_ID", team.id, null);
  setSetting("LINEAR_TEAM_KEY", team.key, null);
  console.log(`✅ team selected: ${team.name} (${team.key})`);

  // States: divergence is a human decision inside Linear — the wizard only REPORTS.
  const { SETTINGS_REGISTRY, settingMeta } = await import("../../config/registry");
  const teamStates = new Set(await listTeamStates(apiKey, team.id));
  const stateMetas = SETTINGS_REGISTRY.filter((m) => m.linearValidatable === "state");
  const diverging = stateMetas.filter((m) => !teamStates.has(resolveSetting(m.key).raw));
  if (diverging.length === 0) {
    console.log("✅ every STATE_* matches the team workflow.");
  } else {
    console.log(`⚠️  ${diverging.length} status(es) diverge from the Linear workflow:`);
    for (const m of diverging) console.log(`   - ${m.key}=${resolveSetting(m.key).raw} does not exist in the team (${[...teamStates].join(", ")})`);
    console.log("   adjust the STATE_* on the Config screen later, or create the matching columns in Linear.");
  }

  // Labels: safe to create via API (unlike states).
  const teamLabels = new Set(await listTeamLabels(apiKey, team.id));
  const labelMetas = SETTINGS_REGISTRY.filter((m) => m.linearValidatable === "label");
  const missingLabels = labelMetas.map((m) => settingMeta(m.key)!.default as string).filter((name) => !teamLabels.has(name));
  if (missingLabels.length === 0) {
    console.log("✅ ready-to-*/agent:* labels already exist in the team.");
  } else if (nonInteractive || (await confirm(`Create the missing labels in Linear? (${missingLabels.join(", ")})`))) {
    for (const name of missingLabels) {
      try {
        await createLabel(apiKey, team.id, name);
        console.log(`✅ label created: ${name}`);
      } catch (e) {
        console.log(`⚠️  failed to create label "${name}": ${String(e)}`);
      }
    }
  }

  // Webhook — never overwrites an existing secret without explicit request.
  const existingWebhookSecret = configuredSetting("LINEAR_WEBHOOK_SECRET");
  let webhookSecret = existingWebhookSecret ?? "";
  let skipWebhookCreate = false;
  if (existingWebhookSecret && !nonInteractive) {
    console.log(`✅ LINEAR_WEBHOOK_SECRET already configured (${maskSecret(existingWebhookSecret)}).`);
    if (!(await confirm("Recreate the webhook / generate a new secret? (Enter = keep)", false))) {
      skipWebhookCreate = true;
    }
  } else if (existingWebhookSecret && nonInteractive) {
    console.log(`✅ LINEAR_WEBHOOK_SECRET already configured — kept.`);
    skipWebhookCreate = true;
  }

  const url = nonInteractive
    ? webhookUrlHint
    : await ask("Public URL to receive the Linear webhook (ENTER to skip — pipeline runs on ticks only):", webhookUrlHint ?? "");

  if (!skipWebhookCreate) {
    webhookSecret = randomBytes(24).toString("hex");
    if (url) {
      try {
        await createWebhook(apiKey, team.id, `${url.replace(/\/$/, "")}/webhook/linear`, webhookSecret);
        setSetting("LINEAR_WEBHOOK_SECRET", webhookSecret, null);
        console.log(`✅ webhook created pointing at ${url}/webhook/linear`);
      } catch (e) {
        console.log(`⚠️  failed to create the webhook automatically (${String(e)}) — create it manually at Linear → Settings → API → Webhooks.`);
        setSetting("LINEAR_WEBHOOK_SECRET", webhookSecret, null);
      }
    } else {
      console.log("ℹ️  no public URL — the pipeline works via tick (15s) only, without instant push from Linear. Noted as pending.");
      // Still syncs the connection below if there is a legacy secret.
      if (!webhookSecret) {
        return { step: "Linear", status: "pending", detail: "webhook not configured" };
      }
    }
  }

  // Multi-Linear: also persists as a connection row (idempotent per org).
  try {
    const { getByOrganizationId, createConnection, updateConnection, listConnections } = await import(
      "../../db/linearConnections"
    );
    const org = await fetchOrganization(apiKey);
    const secret = configuredSetting("LINEAR_WEBHOOK_SECRET") || webhookSecret;
    if (!secret) {
      console.log("⚠️  no webhook secret — connection not created (configure it on the dashboard).");
      return { step: "Linear", status: skipWebhookCreate ? "done" : "pending", detail: `${team.name} (${team.key})` };
    }
    const existing = getByOrganizationId(org.id);
    if (existing) {
      updateConnection(existing.id, {
        apiKey,
        webhookSecret: secret,
        teamId: team.id,
        teamKey: team.key,
        organizationKey: org.urlKey,
        name: existing.name || "Default",
      });
      console.log(`✅ Linear connection updated: ${existing.name} (${org.urlKey})`);
    } else {
      createConnection({
        name: listConnections().length === 0 ? "Default" : org.name || org.urlKey,
        organizationId: org.id,
        organizationKey: org.urlKey,
        apiKey,
        webhookSecret: secret,
        teamId: team.id,
        teamKey: team.key,
      });
      console.log(`✅ Linear connection created: ${org.urlKey}`);
    }

    if (!nonInteractive) {
      while (await confirm("Add another Linear connection (another workspace)?", false)) {
        const extraKey = await askSecret("API key of the other Linear workspace:");
        if (!extraKey) break;
        try {
          const extraViewer = await fetchViewer(extraKey);
          const extraOrg = await fetchOrganization(extraKey);
          console.log(`✅ logged in as ${extraViewer.name} — org ${extraOrg.name} (${extraOrg.urlKey})`);
          const extraTeams = await listTeams(extraKey);
          const picked = await choose(
            "Team (optional):",
            [
              { label: "No team filter", value: "" },
              ...extraTeams.map((t) => ({ label: `${t.name} (${t.key})`, value: t.id })),
            ]
          );
          const extraTeam = extraTeams.find((t) => t.id === picked.value);
          const extraSecret = randomBytes(24).toString("hex");
          if (url && extraTeam) {
            try {
              await createWebhook(extraKey, extraTeam.id, `${url.replace(/\/$/, "")}/webhook/linear`, extraSecret);
            } catch (e) {
              console.log(`⚠️  extra webhook: ${String(e)} — configure it manually with the generated secret.`);
            }
          }
          createConnection({
            name: await ask("Friendly name for this connection:", extraOrg.name || extraOrg.urlKey),
            organizationId: extraOrg.id,
            organizationKey: extraOrg.urlKey,
            apiKey: extraKey,
            webhookSecret: extraSecret,
            teamId: extraTeam?.id ?? null,
            teamKey: extraTeam?.key ?? null,
          });
          console.log(`✅ extra connection created (${extraOrg.urlKey}). Webhook secret: ${extraSecret}`);
        } catch (e) {
          console.log(`⚠️  failed to add the connection: ${String(e)}`);
        }
      }
    }
  } catch (e) {
    console.log(`⚠️  could not sync linear_connections (${String(e)}) — use the dashboard's Linear Connections screen.`);
  }

  return { step: "Linear", status: "done", detail: `${team.name} (${team.key})` };
}

// ── Step 5 — GitHub (REQUIRED) ──
export async function stepGithub(nonInteractive: boolean): Promise<StepResult> {
  console.log("\n[5/11] GitHub — REQUIRED");
  console.log("The service reads PRs (scope-check) and the agents push branches/PRs.");
  console.log("You need a token. Two options:");
  console.log("  • Fine-grained PAT (recommended): https://github.com/settings/personal-access-tokens/new");
  console.log("      Repository access: only the repos the agents will work on");
  console.log("      Permissions → Repository: Contents (Read and write),");
  console.log("      Pull requests (Read and write), Metadata (Read-only — automatic)");
  console.log("  • Classic PAT: https://github.com/settings/tokens/new — scope: repo");
  console.log("    (a classic PAT grants access to ALL your repos; prefer fine-grained)");
  console.log("  • A GitHub App connection can be configured later on the dashboard for");
  console.log("    org-wide installs with short-lived tokens.\n");
  const { setSetting } = await import("../../config/service");

  const existingToken = configuredSetting("GITHUB_TOKEN");
  let token: string;
  if (nonInteractive) {
    token = (process.env.GITHUB_TOKEN ?? existingToken ?? "").trim();
  } else {
    token = await askOrKeep(
      "GITHUB_TOKEN",
      existingToken,
      () => askSecret("GitHub token:"),
      { secret: true }
    );
  }
  if (!token) {
    console.log("⚠️  no token — skipping GitHub (pending).");
    return { step: "GitHub", status: "pending", detail: "no token" };
  }

  for (;;) {
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { login?: string };
      const scopes = res.headers.get("x-oauth-scopes") ?? "";
      console.log(`✅ logged in as ${json.login}${scopes ? ` (scopes: ${scopes})` : ""}`);
      break;
    } catch (e) {
      console.log(`❌ invalid token (${String(e)}).`);
      if (nonInteractive) return { step: "GitHub", status: "pending", detail: "invalid token" };
      token = await askSecret("GitHub token (try again):");
      if (!token) {
        console.log("⚠️  no token — skipping GitHub (pending).");
        return { step: "GitHub", status: "pending", detail: "no token" };
      }
    }
  }
  setSetting("GITHUB_TOKEN", token, null);

  const existingOrgs = configuredSetting("AGENT_AUTHORIZED_ORGS");
  let orgs: string;
  if (nonInteractive) {
    orgs = (process.env.AGENT_AUTHORIZED_ORGS ?? existingOrgs ?? "").trim();
  } else {
    orgs = await askOrKeep(
      "AGENT_AUTHORIZED_ORGS",
      existingOrgs,
      () =>
        ask(
          "Authorized orgs/owners (comma-separated — anti-fork fail-safe; ENTER to leave empty):",
          existingOrgs ?? ""
        )
    );
  }
  if (orgs) {
    setSetting("AGENT_AUTHORIZED_ORGS", orgs, null);
    console.log(`✅ AGENT_AUTHORIZED_ORGS=${orgs}`);
  } else {
    console.log("ℹ️  AGENT_AUTHORIZED_ORGS empty — no extra org guard (only the issue decides the repo).");
  }

  return { step: "GitHub", status: "done" };
}

// ── Step 6 — First admin (REQUIRED for the dashboard) ──
export async function stepFirstAdmin(nonInteractive: boolean): Promise<StepResult> {
  console.log("\n[6/11] First admin — REQUIRED (dashboard login)");
  const { countUsers, createFirstAdmin } = await import("../../db/users");

  if (countUsers() > 0) {
    console.log("✅ a user already exists — skipping.");
    return { step: "First admin", status: "done", detail: "already existed" };
  }

  if (nonInteractive) {
    const name = process.env.SETUP_ADMIN_NAME;
    const username = process.env.SETUP_ADMIN_USERNAME;
    const password = process.env.SETUP_ADMIN_PASSWORD;
    const email = process.env.SETUP_ADMIN_EMAIL;
    if (!name || !username || !password) {
      console.log("⚠️  SETUP_ADMIN_NAME/USERNAME/PASSWORD missing from --config — skipping (use the dashboard first-access flow later).");
      return { step: "First admin", status: "pending", detail: "credentials missing from --config" };
    }
    await createFirstAdmin({ name, username, password, email });
    console.log(`✅ admin created: ${username}`);
    return { step: "First admin", status: "done", detail: username };
  }

  console.log("No user registered yet — let's create the first admin.");
  const name = await ask("Name:");
  const email = await ask("E-mail (optional):");
  const username = await ask("Username:");
  const { MIN_PASSWORD_LENGTH } = await import("../../db/users");
  let password = "";
  for (;;) {
    password = await askSecret(`Password (min. ${MIN_PASSWORD_LENGTH} characters):`);
    if (password.length >= MIN_PASSWORD_LENGTH) break;
    console.log(`password too short (min. ${MIN_PASSWORD_LENGTH}), try again.`);
  }
  await createFirstAdmin({ name, email: email || undefined, username, password });
  console.log(`✅ admin created: ${username}`);
  return { step: "First admin", status: "done", detail: username };
}

// ── Step 7 — Harness dependencies (OPTIONAL, but you need at least one harness) ──
export async function stepHarnessDeps(
  nonInteractive: boolean,
  flags: Record<string, string | boolean>
): Promise<StepResult> {
  console.log("\n[7/11] Harness dependencies — OPTIONAL (at least one harness is needed to run agents)");
  console.log(
    "Before detection, we offer to install what each harness needs:\n" +
      "  • Claude Code / Codex → ACP adapter (npm) on top of the official CLI\n" +
      "  • Cursor / Copilot / Goose → the harness's native CLI\n" +
      "  • Hermes → HTTP gateway (no ACP — instructions only)\n"
  );

  const {
    HARNESS_DEP_SPECS,
    ensureHarnessBinOnPath,
    installHarnessDep,
    kindLabel,
    probeHarnessDep,
    harnessBinDir,
  } = await import("./harnessDeps");

  ensureHarnessBinOnPath();
  const statuses = await Promise.all(HARNESS_DEP_SPECS.map(probeHarnessDep));

  for (const s of statuses) {
    const kind = kindLabel(s.spec.kind);
    if (s.requiredOk) {
      console.log(`✅ ${s.spec.label} (${kind}): ${s.spec.requiredBin} → ${s.requiredPath}`);
    } else {
      console.log(`❌ ${s.spec.label} (${kind}): missing "${s.spec.requiredBin}"`);
      if (s.spec.underlyingCli) {
        console.log(
          s.underlyingOk
            ? `   base CLI OK: ${s.spec.underlyingCli} → ${s.underlyingPath}`
            : `   base CLI missing: ${s.spec.underlyingCli} (install it before the ACP adapter)`
        );
      }
      if (s.spec.manualHint) console.log(`   ${s.spec.manualHint}`);
      if (s.spec.docsUrl) console.log(`   docs: ${s.spec.docsUrl}`);
    }
  }

  const missing = statuses.filter((s) => !s.requiredOk);
  if (missing.length === 0) {
    console.log("\n✅ every harness dependency is already on PATH.");
    return { step: "Harness dependencies", status: "done", detail: "all ok" };
  }

  const auto = missing.filter((s) => s.canAutoInstall);
  const manualOnly = missing.filter((s) => !s.canAutoInstall);

  if (manualOnly.length > 0) {
    console.log(`\nℹ️  ${manualOnly.map((s) => s.spec.label).join(", ")} — manual install (no auto-install in this step).`);
  }

  const force = flags["install-harness"] === true;
  if (nonInteractive && !force) {
    console.log(
      "ℹ️  --non-interactive: harness install skipped (pass --install-harness to force the auto-installs).\n" +
        `   Missing: ${missing.map((s) => s.spec.requiredBin).join(", ")}`
    );
    return {
      step: "Harness dependencies",
      status: "pending",
      detail: `missing: ${missing.map((s) => s.spec.requiredBin).join(", ")}`,
    };
  }

  if (auto.length === 0) {
    return {
      step: "Harness dependencies",
      status: "pending",
      detail: `missing (manual): ${manualOnly.map((s) => s.spec.requiredBin).join(", ")}`,
    };
  }

  if (!nonInteractive) {
    console.log("\nAuto-installable right now:");
    auto.forEach((s, i) => {
      const how = s.spec.npmPackage
        ? `npm ${s.spec.npmPackage} → ${harnessBinDir()}`
        : s.spec.installShell?.label ?? "script";
      console.log(`  ${i + 1}) ${s.spec.label}: ${how}`);
    });
    const ok = await confirm(
      `Install ${auto.length} missing dependenc${auto.length === 1 ? "y" : "ies"} now? (Enter = yes)`,
      true
    );
    if (!ok) {
      console.log("ℹ️  skipped — the next step will report what is still missing.");
      return {
        step: "Harness dependencies",
        status: "skipped",
        detail: `not installed: ${auto.map((s) => s.spec.requiredBin).join(", ")}`,
      };
    }
  }

  const installed: string[] = [];
  const failed: string[] = [];
  for (const s of auto) {
    // If it is an ACP adapter and the base CLI is missing, skip it.
    if (s.spec.kind === "acp-adapter" && s.spec.underlyingCli && !s.underlyingOk) {
      console.log(`⚠️  ${s.spec.label}: no "${s.spec.underlyingCli}" — skipping the ACP adapter.`);
      failed.push(`${s.spec.requiredBin} (missing ${s.spec.underlyingCli})`);
      continue;
    }
    if (!nonInteractive && auto.length > 1) {
      const one = await confirm(`Install ${s.spec.label} (${s.spec.requiredBin})?`, true);
      if (!one) {
        console.log(`⏭️  ${s.spec.label} skipped.`);
        continue;
      }
    }
    console.log(`\n→ installing ${s.spec.label}…`);
    const r = await installHarnessDep(s);
    if (r.ok) {
      console.log(`✅ ${s.spec.label}: ${r.detail}`);
      installed.push(s.spec.requiredBin);
    } else {
      console.log(`❌ ${s.spec.label}: ${r.detail}`);
      failed.push(s.spec.requiredBin);
    }
  }

  ensureHarnessBinOnPath();
  if (installed.length > 0) {
    console.log(`\nLocal yaoe-flow bins: ${harnessBinDir()}`);
    console.log("(already on this process's PATH; for new terminals, add that dir or ~/.local/bin)");
  }

  if (failed.length > 0 || manualOnly.length > 0) {
    return {
      step: "Harness dependencies",
      status: "pending",
      detail: `ok=${installed.join(",") || "—"}; missing=${[...failed, ...manualOnly.map((s) => s.spec.requiredBin)].join(",")}`,
    };
  }
  return {
    step: "Harness dependencies",
    status: installed.length ? "done" : "skipped",
    detail: installed.join(", ") || undefined,
  };
}

// ── Step 8 — Harness detection (OPTIONAL) ──
export async function stepHarness(nonInteractive: boolean): Promise<StepResult> {
  console.log("\n[8/11] Harness detection — OPTIONAL");
  const { ensureHarnessBinOnPath } = await import("./harnessDeps");
  ensureHarnessBinOnPath();

  const { detectAllHarnesses } = await import("../../agent/harness/detect");
  const report = await detectAllHarnesses();

  for (const [id, d] of Object.entries(report)) {
    const state = !d.installed ? "not installed" : `installed${d.version ? ` (${d.version})` : ""}, auth=${d.authStatus}`;
    console.log(`  ${d.installed && d.authStatus === "ok" ? "✅" : "⚠️ "} ${id}: ${state}`);
    if (!d.installed && d.installHint) console.log(`     install: ${d.installHint}`);
    if (d.installed && d.authStatus !== "ok" && d.loginHint) console.log(`     login: ${d.loginHint}`);
  }

  if (!nonInteractive) {
    console.log("\nOPTIONAL: an OpenRouter API key lets the Goose harness use your own model");
    console.log("budget (BYOK) and enables cost reconciliation on the dashboard.");
    console.log("  • Where: https://openrouter.ai/settings/keys\n");
    const existingOpenRouter = configuredSetting("OPENROUTER_API_KEY");
    if (existingOpenRouter) {
      console.log(`✅ OPENROUTER_API_KEY already configured (${maskSecret(existingOpenRouter)}).`);
      if (await confirm("Change it? (Enter = keep)", false)) {
        const key = await askSecret("OPENROUTER_API_KEY:");
        if (key) {
          const { setSetting } = await import("../../config/service");
          setSetting("OPENROUTER_API_KEY", key, null);
          console.log("✅ OPENROUTER_API_KEY updated (encrypted in the database).");
        }
      }
    } else if (await confirm("Configure OPENROUTER_API_KEY now (optional, used by Goose)?", false)) {
      const key = await askSecret("OPENROUTER_API_KEY:");
      if (key) {
        const { setSetting } = await import("../../config/service");
        setSetting("OPENROUTER_API_KEY", key, null);
        console.log("✅ OPENROUTER_API_KEY saved (encrypted in the database).");
      }
    }
  }

  return { step: "Harness detection", status: "done" };
}

// ── Step 9 — Local binary (OPTIONAL: compile + ~/.local/bin) ──
export async function stepInstallLocal(
  nonInteractive: boolean,
  flags: Record<string, string | boolean>
): Promise<StepResult> {
  console.log("\n[9/11] Local binary — OPTIONAL");

  const root = findServiceRoot();
  if (!root) {
    console.log(
      "ℹ️  source tree not found — skipping the local compile.\n" +
        "   (With the repo clone: bun scripts/build-and-install.ts or yaoe-flow install-local)"
    );
    return { step: "Local binary", status: "skipped", detail: "no source tree" };
  }

  const existing = installedYaoeBin();
  if (existing) {
    console.log(`✅ binary already installed: ${existing}`);
    if (nonInteractive && flags["install-local"] !== true) {
      return { step: "Local binary", status: "skipped", detail: existing };
    }
    if (!nonInteractive) {
      const again = await confirm("Recompile and reinstall the binary now?", false);
      if (!again) return { step: "Local binary", status: "skipped", detail: existing };
    }
  } else {
    const force = flags["install-local"] === true;
    if (nonInteractive && !force) {
      console.log(
        "ℹ️  --non-interactive: local compile skipped (pass --install-local to force).\n" +
          "   Later: yaoe-flow install-local   or   bun scripts/build-and-install.ts"
      );
      return { step: "Local binary", status: "skipped", detail: "not requested in --non-interactive" };
    }
    if (!nonInteractive) {
      const ok = await confirm(
        "Compile the binary for this machine and install into ~/.local/bin? (recommended — takes a few minutes)",
        true
      );
      if (!ok) {
        console.log('ℹ️  skipped — later: "yaoe-flow install-local" or "bun scripts/build-and-install.ts".');
        return { step: "Local binary", status: "skipped" };
      }
    }
  }

  const bun = Bun.which("bun");
  if (!bun) {
    console.error("❌ bun not found — required to compile the binary.");
    return { step: "Local binary", status: "pending", detail: "bun missing" };
  }

  const script = join(root, "scripts", "build-and-install.ts");
  console.log("Compiling (dashboard + embed + bun build --compile)…");
  const r = spawnSync(bun, [script, "--yes"], { cwd: root, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    return { step: "Local binary", status: "pending", detail: `compile exit ${r.status ?? "?"}` };
  }

  const installed = installedYaoeBin();
  console.log(installed ? `✅ installed: ${installed}` : "✅ compile ok (check ~/.local/bin/yaoe-flow).");
  return { step: "Local binary", status: "done", detail: installed ?? undefined };
}

// ── Step 10 — System service (OPTIONAL) ──
export async function stepService(nonInteractive: boolean, flags: Record<string, string | boolean>): Promise<StepResult> {
  console.log("\n[10/11] System service — OPTIONAL");

  // Installing a service is a persistent system change (unit/plist/Task
  // Scheduler + auto start) — it only happens with an EXPLICIT flag
  // (--systemd/--launchd) or an explicit confirmation in interactive mode;
  // never silently by default in --non-interactive (VM provisioning must not
  // run system commands the operator did not put in writing).
  let install: "systemd" | "launchd" | "windows" | "skip" = "skip";
  if (flags.systemd === true) install = "systemd";
  else if (flags.launchd === true) install = "launchd";
  else if (!nonInteractive) {
    const platformDefault = process.platform === "linux" ? "systemd" : process.platform === "darwin" ? "launchd" : "windows";
    const label = platformDefault === "systemd" ? "systemd --user" : platformDefault === "launchd" ? "launchd" : "Task Scheduler";
    const ok = await confirm(`Install as a user service (${label})?`, false);
    if (ok) install = platformDefault as typeof install;
  }

  if (install === "skip") {
    console.log('ℹ️  skipped — start manually with "yaoe-flow daemon" (or -d to run in the background).');
    return { step: "System service", status: "skipped" };
  }

  if (install === "systemd") {
    const { installSystemdUnit } = await import("../service/systemd");
    const r = await installSystemdUnit();
    console.log(`✅ unit written at ${r.path}${r.enabled ? " and enabled" : ""}.`);
    console.log(`   ${r.lingerHint}`);
    return { step: "System service", status: "done", detail: r.path };
  }

  if (install === "launchd") {
    const { installLaunchdPlist } = await import("../service/launchd");
    const r = await installLaunchdPlist();
    console.log(`✅ LaunchAgent written at ${r.path}${r.loaded ? " and loaded" : ""}.`);
    return { step: "System service", status: "done", detail: r.path };
  }

  const { installWindowsTask } = await import("../service/windows");
  const r = await installWindowsTask();
  console.log(r.created ? "✅ Task Scheduler task created." : `ℹ️  run manually: ${r.command}`);
  return { step: "System service", status: r.created ? "done" : "pending", detail: r.command };
}

// ── Step 11 — Summary ──
export function stepSummary(results: StepResult[]): void {
  console.log("\n[11/11] Summary\n");
  for (const r of results) {
    const icon = r.status === "done" ? "✅" : r.status === "pending" ? "⚠️ " : "⏭️ ";
    console.log(`${icon} ${r.step}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const pending = results.filter((r) => r.status === "pending");
  // bootstrap.host is frozen at process start — re-read config.env in case the
  // Network binding step just changed it in THIS run (takes effect next boot).
  const effectiveHost = readConfigEnv().get("HOST") || bootstrap.host;
  console.log(`\nDashboard: http://${effectiveHost}:${bootstrap.dashboardPort}`);
  console.log('Next: put your first issue into the pipeline with the "ready-to-refine" label in Linear.');
  console.log(`YAOE_HOME: ${bootstrap.yaoeHome} (logs in ${bootstrap.yaoeLogsDir}, data in ${bootstrap.yaoeDataDir})`);
  if (pending.length > 0) {
    console.log(`\n${pending.length} pending item(s) — resolve when you can and run "yaoe-flow doctor" to confirm.`);
  }
  const bin = installedYaoeBin();
  if (bin) {
    console.log(`\nStart the service with "${bin} daemon" (or "yaoe-flow daemon -d" for background).`);
  } else {
    console.log('\nStart the service with "yaoe-flow daemon" (or "yaoe-flow daemon -d" for background).');
    console.log('  (no binary in ~/.local/bin yet — run "yaoe-flow install-local" if you have the clone)');
  }
}
