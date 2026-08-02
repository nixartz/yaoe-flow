#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// Gera os recipes do Goose a partir das SOULs (fonte única da verdade).
//
//   agents/<role>.SOUL.md  +  agents/COMMUNICATION_PROTOCOL.md
//        └────────────────────────┬───────────────────────────┘
//                       instructions: |  (do recipe)
//
// Cada papel do pipeline vira um recipe `<role>.yaml` neste diretório, com a SOUL
// (+ protocolo) embutida no campo `instructions`. Edite as SOULs em agents/ e
// rode `bun recipes/build.ts` para regenerar — NUNCA edite os .yaml à mão.
//
// O input da task (issueId / mode) NÃO é parâmetro do recipe: chega na mensagem
// do prompt (ACP), exatamente como a SOUL já espera (igual ao backend Hermes).
// Assim os dois backends ficam simétricos.
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
  /** Prefixo de env do papel (PMO/WORKER/REVIEWER/ORCHESTRATOR) p/ resolver o model. */
  role: string;
  /** YAML literal do bloco `extensions:` (já indentado sob a chave). */
  extensions: string;
};

// Provider/model dos recipes — configuráveis na geração via env (a CHAVE do
// provider NÃO vai no recipe; vem do ambiente do goose, ex.: OPENROUTER_API_KEY):
//   RECIPE_PROVIDER          (default: openrouter)
//   RECIPE_MODEL             (default global)
//   RECIPE_<PAPEL>_MODEL     (override por papel)
const PROVIDER = process.env.RECIPE_PROVIDER ?? "openrouter";
// Defaults: presets OpenRouter (ver docs/openrouter-presets.md). Override por
// RECIPE_<PAPEL>_MODEL / RECIPE_ANALYSIS_MODEL / RECIPE_MODEL.
const MODEL_CODER = process.env.RECIPE_MODEL ?? "@preset/coder";
const MODEL_ANALYSIS = process.env.RECIPE_ANALYSIS_MODEL ?? "@preset/analysis";
const modelFor = (role: string) => {
  const specific = process.env[`RECIPE_${role}_MODEL`];
  if (specific) return specific;
  if (role === "PMO" || role === "REVIEWER" || role === "ORCHESTRATOR") return MODEL_ANALYSIS;
  return MODEL_CODER;
};

// Snippets de extensions reutilizados pelos recipes. Os segredos entram via
// `env_keys` (só o NOME): o Goose resolve o valor do keyring/ambiente do goose
// e injeta no processo do MCP — o valor nunca fica no YAML. Ver docs/goose-setup.md §2.
const EXT_LINEAR = [
  "  # Linear MCP — credential: LINEAR_API_TOKEN (the backend aliases it from LINEAR_API_KEY).",
  "  - type: stdio",
  "    name: linear",
  "    cmd: npx",
  '    args: ["-y", "@tacticlaunch/mcp-linear"]',
  "    timeout: 300",
  '    env_keys: ["LINEAR_API_TOKEN"]',
];
// GitHub MCP oficial (github/github-mcp-server). Toolsets enxutos por papel —
// menos schemas no prompt = menos tokens/custo por turno. Ver GITHUB_TOOLSETS
// no README do github-mcp-server. Na imagem Dockerfile.goose o binário vem
// pré-instalado; localmente: release ou Docker — docs/*-setup.md.
function extGithub(opts: { toolsets: string; readOnly?: boolean }): string[] {
  const lines = [
    "  # GitHub MCP oficial (github/github-mcp-server) — credential:",
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

// Hindsight — memória de agente (recall/retain), MCP remoto via streamable_http
// (não stdio: não é um binário spawnável, é um servidor HTTP já rodando —
// local via docker-compose ou um Hindsight existente em outro lugar). A URL
// (host + bank) é BAKEADA aqui em build-time a partir de RECIPE_HINDSIGHT_*
// (mesmo padrão de RECIPE_PROVIDER/RECIPE_MODEL) — mudar host/bank exige
// rodar `bun recipes/build.ts` de novo. Só a CREDENCIAL (header Authorization)
// é resolvida em runtime pelo próprio goose a partir do seu process.env
// (${HINDSIGHT_API_KEY}), igual ao segredo dos MCPs stdio via env_keys — nunca
// fica escrita aqui. Ver docs/goose-setup.md §Hindsight.
// Opt-in explícito (RECIPE_HINDSIGHT_ENABLED=true), default DESLIGADO. Não é só
// preferência: se a extension apontar pra um Hindsight inalcançável/mal configurado,
// não há garantia de que o goose degrade graciosamente (extensions quebradas já
// derrubaram outras no mesmo processo em algumas versões do goose) — então quem
// não configurou Hindsight não deve ter NENHUM risco novo. Sem a flag, EXT_HINDSIGHT
// fica vazio e a extension nem aparece no .yaml gerado.
const HINDSIGHT_ENABLED = process.env.RECIPE_HINDSIGHT_ENABLED === "true";
const HINDSIGHT_BASE_URL = process.env.RECIPE_HINDSIGHT_BASE_URL ?? "http://hindsight:8888";
const HINDSIGHT_BANK_ID = process.env.RECIPE_HINDSIGHT_BANK_ID ?? "orchestrator";
const EXT_HINDSIGHT = HINDSIGHT_ENABLED
  ? [
      "  # Hindsight MCP — memória de agente (recall/retain). Credencial via header",
      "  # (resolvida pelo goose em runtime a partir do seu próprio ambiente), não",
      "  # env_keys — essa extension é remota (streamable_http), não um MCP stdio.",
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

// Indenta cada linha por 2 espaços para caber num bloco literal YAML (`|`).
// Linhas vazias ficam vazias (válido e legível dentro do bloco).
function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? `  ${line}` : ""))
    .join("\n");
}

// Escapa string para YAML de aspas duplas (usado em title/description/prompt).
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
  // Validação: se esta build do Bun tiver YAML, garante que o recipe parseia e
  // que `instructions` é uma string não-vazia (o bloco literal saiu correto).
  const Y = (Bun as unknown as { YAML?: { parse(s: string): unknown } }).YAML;
  if (Y) {
    const parsed = Y.parse(yaml) as { instructions?: unknown; extensions?: unknown };
    if (typeof parsed.instructions !== "string" || !parsed.instructions.length) {
      throw new Error(`${def.file}: instructions inválido após parse`);
    }
    if (!Array.isArray(parsed.extensions)) {
      throw new Error(`${def.file}: extensions inválido após parse`);
    }
  }
  console.log(`✓ ${def.file}  (${yaml.length} bytes)`);
  wrote++;
}
console.log(`\n${wrote} recipe(s) gerado(s) em ${RECIPES_DIR}${Y0()}`);
function Y0() {
  const Y = (Bun as unknown as { YAML?: unknown }).YAML;
  return Y ? "  · YAML validado" : "  · (Bun.YAML indisponível — validação de parse pulada)";
}
