#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// Generates the Goose recipes from the SOULs (single source of truth).
//
//   agents/<role>.SOUL.md  +  agents/COMMUNICATION_PROTOCOL.md
//        └────────────────────────┬───────────────────────────┘
//                       instructions: |  (in the recipe)
//
// Each pipeline role becomes a `<role>.yaml` recipe in this directory, with
// the SOUL (+ protocol) embedded in the `instructions` field. Edit the SOULs
// in agents/ and run `bun recipes/build.ts` to regenerate — NEVER hand-edit
// the .yaml files.
//
// The task input (issueId / mode) is NOT a recipe parameter: it arrives in
// the prompt message (ACP), exactly as the SOUL already expects (same as the
// Hermes backend). This keeps both backends symmetric.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RECIPES_DIR = import.meta.dir;
const AGENTS_DIR = join(RECIPES_DIR, "..", "agents");
const PROTOCOL = readFileSync(join(AGENTS_DIR, "COMMUNICATION_PROTOCOL.md"), "utf8").trimEnd();

type RecipeDef = {
  file: string;
  soul: string;
  title: string;
  description: string;
  prompt: string;
  /** Role's env prefix (PMO/DEV/REVIEWER/ORCHESTRATOR) to resolve the model. */
  role: string;
  /** Literal YAML of the `extensions:` block (already indented under the key). */
  extensions: string;
};

// Recipe provider/model — configurable at generation time via env (the
// provider's KEY does NOT go in the recipe; it comes from goose's own
// environment, e.g. OPENROUTER_API_KEY):
//   RECIPE_PROVIDER          (default: openrouter)
//   RECIPE_MODEL             (global default)
//   RECIPE_<ROLE>_MODEL      (per-role override)
const PROVIDER = process.env.RECIPE_PROVIDER ?? "openrouter";
// Defaults: OpenRouter presets (see docs/harnesses.md). Override via
// RECIPE_<ROLE>_MODEL / RECIPE_ANALYSIS_MODEL / RECIPE_MODEL.
const MODEL_CODER = process.env.RECIPE_MODEL ?? "@preset/coder";
const MODEL_ANALYSIS = process.env.RECIPE_ANALYSIS_MODEL ?? "@preset/analysis";
const modelFor = (role: string) => {
  const specific = process.env[`RECIPE_${role}_MODEL`];
  if (specific) return specific;
  if (role === "PMO" || role === "REVIEWER" || role === "ORCHESTRATOR") return MODEL_ANALYSIS;
  return MODEL_CODER;
};

// Extension snippets reused across recipes. Secrets enter via `env_keys`
// (NAME only): Goose resolves the value from its own keyring/environment and
// injects it into the MCP process — the value never lives in the YAML. See
// docs/mcp-configuration.md.
const EXT_LINEAR = [
  "  # Linear MCP — credential: LINEAR_API_TOKEN (the backend aliases it from LINEAR_API_KEY).",
  "  - type: stdio",
  "    name: linear",
  "    cmd: npx",
  '    args: ["-y", "@tacticlaunch/mcp-linear"]',
  "    timeout: 300",
  '    env_keys: ["LINEAR_API_TOKEN"]',
];
// Official GitHub MCP (github/github-mcp-server). Lean toolsets per role —
// fewer schemas in the prompt = fewer tokens/cost per turn. See
// GITHUB_TOOLSETS in the github-mcp-server README. The Dockerfile.goose image
// ships the binary pre-installed; locally: release download or Docker — see
// docs/harnesses.md.
function extGithub(opts: { toolsets: string; readOnly?: boolean }): string[] {
  const lines = [
    "  # Official GitHub MCP (github/github-mcp-server) — credential:",
    "  # GITHUB_PERSONAL_ACCESS_TOKEN (the backend aliases it from GITHUB_TOKEN).",
    `  # Toolsets: ${opts.toolsets}${opts.readOnly ? " · READ_ONLY=1" : ""}`,
    "  - type: stdio",
    "    name: github",
    "    cmd: github-mcp-server",
    '    args: ["stdio"]',
    "    timeout: 300",
    '    env_keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"]',
    "    envs:",
    `      GITHUB_TOOLSETS: "${opts.toolsets}"`,
  ];
  if (opts.readOnly) lines.push('      GITHUB_READ_ONLY: "1"');
  return lines;
}
const EXT_GITHUB_PMO = extGithub({ toolsets: "repos", readOnly: true });
const EXT_GITHUB_CODE = extGithub({ toolsets: "repos,pull_requests" });
const extDeveloper = (note: string) => [
  `  # developer — ${note} (builtin: no credential needed).`,
  "  - type: builtin",
  "    name: developer",
];

// Hindsight — agent memory (recall/retain), remote MCP via streamable_http
// (not stdio: it is not a spawnable binary, it is an HTTP server already
// running — locally via docker-compose, or an existing Hindsight elsewhere).
// The URL (host + bank) is BAKED IN here at build time from RECIPE_HINDSIGHT_*
// (same pattern as RECIPE_PROVIDER/RECIPE_MODEL) — changing host/bank
// requires running `bun recipes/build.ts` again. Only the CREDENTIAL
// (Authorization header) is resolved at runtime by goose itself from its own
// process.env (${HINDSIGHT_API_KEY}), same as stdio MCP secrets via
// env_keys — it is never written here. See docs/mcp-configuration.md.
// Explicit opt-in (RECIPE_HINDSIGHT_ENABLED=true), OFF by default. Not just a
// preference: if the extension points at an unreachable/misconfigured
// Hindsight, there is no guarantee goose degrades gracefully (broken
// extensions have taken down others in the same process on some goose
// versions) — so anyone who has not configured Hindsight should carry ZERO
// new risk. Without the flag, EXT_HINDSIGHT is empty and the extension does
// not even appear in the generated .yaml.
const HINDSIGHT_ENABLED = process.env.RECIPE_HINDSIGHT_ENABLED === "true";
const HINDSIGHT_BASE_URL = process.env.RECIPE_HINDSIGHT_BASE_URL ?? "http://hindsight:8888";
const HINDSIGHT_BANK_ID = process.env.RECIPE_HINDSIGHT_BANK_ID ?? "orchestrator";
const EXT_HINDSIGHT = HINDSIGHT_ENABLED
  ? [
      "  # Hindsight MCP — agent memory (recall/retain). Credential via header",
      "  # (resolved by goose at runtime from its own environment), not",
      "  # env_keys — this extension is remote (streamable_http), not a stdio MCP.",
      "  - type: streamable_http",
      "    name: hindsight",
      `    uri: "${HINDSIGHT_BASE_URL}/mcp/${HINDSIGHT_BANK_ID}/"`,
      "    headers:",
      '      Authorization: "Bearer ${HINDSIGHT_API_KEY}"',
      "    timeout: 60",
    ]
  : [];

const RECIPES: RecipeDef[] = [
  {
    file: "pmo.yaml",
    soul: "pmo.SOUL.md",
    title: "PMO — Task refinement",
    description: "Refines tasks in Refining: dependencies (blockedBy/blocks), footprint, out-of-scope, checklist; moves to Planned or Blocked. Does not write code.",
    prompt: "Refine the Linear issue named in the message (issueId field). Follow your SOUL: normalize scope and ## Footprint, record dependencies, validate the checklist/prompt, and move to Planned (or Blocked if a human decision is missing).",
    role: "PMO",
    extensions: [
      ...EXT_LINEAR,
      ...EXT_GITHUB_PMO,
      ...EXT_HINDSIGHT,
      ...extDeveloper("read-only shell/fs — prefer shallow clone + rtk over GitHub MCP"),
    ].join("\n"),
  },
  {
    file: "dev.yaml",
    soul: "dev.SOUL.md",
    title: "Dev — Implementation",
    description: "Implements or fixes a task (mode: implement|fix), respecting the footprint as scope ceiling and the plan-gate. Opens a PR and attaches the link to the issue.",
    prompt: "Implement or fix the issue named in the message (issueId and mode fields). Respect the declared footprint as your scope ceiling and your SOUL's plan-gate; when opening the PR, attach its link to the issue before moving to Code Review.",
    role: "DEV",
    extensions: [
      ...EXT_LINEAR,
      ...EXT_GITHUB_CODE,
      ...EXT_HINDSIGHT,
      ...extDeveloper("shell + editor + filesystem (write) + git — inspect via rtk locally"),
    ].join("\n"),
  },
  {
    file: "reviewer.yaml",
    soul: "reviewer.SOUL.md",
    title: "Reviewer — PR audit",
    description: "Reviews the PR of a task in In Review: traceability to the checklist/criteria, scope audit (footprint), bugs and security. Approves or rejects (Reopened).",
    prompt: "Review the PR of the issue named in the message (issueId field). Audit scope (footprint) and traceability to the acceptance criteria per your SOUL; approve or reject pointing at the specific files/lines.",
    role: "REVIEWER",
    extensions: [
      ...EXT_GITHUB_CODE,
      ...EXT_LINEAR,
      ...extDeveloper("read-only (optional) — run lint/test while reviewing"),
    ].join("\n"),
  },
  {
    file: "orchestrator.yaml",
    soul: "orchestrator.SOUL.md",
    title: "Orchestrator — Planning & Merge",
    description: "Two modes: planning (estimates the footprint and replies with ONLY the JSON) and merge (merges the PR of a task in Pending Merge). The mode comes in the message.",
    prompt: "Per the mode field of the message: in 'planning', reply with ONLY the issue's { footprint } JSON; in 'merge', merge the issue's PR. Follow your SOUL.",
    role: "ORCHESTRATOR",
    extensions: [
      ...EXT_LINEAR,
      ...EXT_GITHUB_CODE,
      ...extDeveloper("shell/git — used only in merge mode"),
    ].join("\n"),
  },
];

// Indents every line by 2 spaces to fit a YAML literal block (`|`).
// Empty lines stay empty (valid and readable inside the block).
function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? `  ${line}` : ""))
    .join("\n");
}

// Escapes a string for double-quoted YAML (used in title/description/prompt).
function yamlDq(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildRecipe(def: RecipeDef): string {
  const soul = readFileSync(join(AGENTS_DIR, def.soul), "utf8").trimEnd();
  const instructions = indentBlock(`${soul}\n\n---\n\n${PROTOCOL}`);
  return `# GENERATED by recipes/build.ts from agents/${def.soul} + COMMUNICATION_PROTOCOL.md
# Do NOT hand-edit — edit the SOUL and run: bun recipes/build.ts
version: "1.0.0"
title: ${yamlDq(def.title)}
description: ${yamlDq(def.description)}
# The task input (issueId / mode) arrives in the prompt MESSAGE (ACP) — the SOUL reads it from there.
prompt: ${yamlDq(def.prompt)}
settings:
  goose_provider: ${yamlDq(PROVIDER)}
  goose_model: ${yamlDq(modelFor(def.role))}
extensions:
${def.extensions}
instructions: |
${instructions}
`;
}

let wrote = 0;
for (const def of RECIPES) {
  const yaml = buildRecipe(def);
  const out = join(RECIPES_DIR, def.file);
  writeFileSync(out, yaml, "utf8");
  // Validation: if this Bun build has YAML support, confirm the recipe
  // parses and that `instructions` is a non-empty string (the literal block
  // came out correctly).
  const Y = (Bun as unknown as { YAML?: { parse(s: string): unknown } }).YAML;
  if (Y) {
    const parsed = Y.parse(yaml) as { instructions?: unknown; extensions?: unknown };
    if (typeof parsed.instructions !== "string" || !parsed.instructions.length) {
      throw new Error(`${def.file}: invalid instructions after parsing`);
    }
    if (!Array.isArray(parsed.extensions)) {
      throw new Error(`${def.file}: invalid extensions after parsing`);
    }
  }
  console.log(`✓ ${def.file}  (${yaml.length} bytes)`);
  wrote++;
}
console.log(`\n${wrote} recipe(s) generated in ${RECIPES_DIR}${Y0()}`);
function Y0() {
  const Y = (Bun as unknown as { YAML?: unknown }).YAML;
  return Y ? "  · YAML validated" : "  · (Bun.YAML unavailable — parse validation skipped)";
}
