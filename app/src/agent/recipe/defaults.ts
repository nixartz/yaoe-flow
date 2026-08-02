// Metadados por PAPEL (title/description/prompt do recipe) + MCPs default —
// a versão em DADOS do que recipes/build.ts fazia em YAML. É daqui que o seed
// da Fase 1 (§6.2) monta o `mcpServersJson` inicial de cada agente e que o
// builder de runtime (§6.3) tira o esqueleto do recipe quando o agente não
// customizou nada.
//
// O input da task (issueId/mode) NÃO é parâmetro do recipe: chega na mensagem
// do prompt, exatamente como as SOULs esperam — igual nos dois backends de hoje.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMBEDDED_COMMUNICATION_PROTOCOL, EMBEDDED_SOULS } from "../../embedded-assets.generated";

/** Papel canônico do banco (blueprint §6.1) ↔ papel interno do scheduler. */
export type AgentRole = "pmo" | "dev" | "reviewer" | "orchestrator";
/** Alias histórico `worker` ainda aceito em leituras (runs antigos / filtros). */
export type SchedulerRole = "pmo" | "dev" | "worker" | "reviewer" | "orchestrator";

export function toAgentRole(role: SchedulerRole | string): AgentRole {
  if (role === "worker" || role === "senior-engineer") return "dev";
  return role as AgentRole;
}

export function toSchedulerRole(role: AgentRole): Exclude<SchedulerRole, "worker"> {
  return role;
}

export const AGENT_ROLES: AgentRole[] = ["pmo", "dev", "reviewer", "orchestrator"];

// Config de MCP server agnóstica de harness (gravada em mcpServersJson).
// Segredos entram por NOME (envKeys) — resolvidos do ambiente no dispatch;
// nunca ficam gravados na config.
export type McpServerConfig =
  | { type: "builtin"; name: string }
  | {
      type: "stdio";
      name: string;
      cmd: string;
      args: string[];
      envKeys?: string[];
      envs?: Record<string, string>;
      timeout?: number;
    }
  | { type: "streamable_http"; name: string; uri: string; headers?: Record<string, string>; timeout?: number };

export interface RoleMeta {
  role: AgentRole;
  title: string;
  description: string;
  prompt: string;
  soulFile: string;
  defaultMcpServers: McpServerConfig[];
}

const MCP_LINEAR: McpServerConfig = {
  type: "stdio",
  name: "linear",
  cmd: "npx",
  args: ["-y", "@tacticlaunch/mcp-linear"],
  timeout: 300,
  envKeys: ["LINEAR_API_TOKEN"],
};

function mcpGithub(opts: { toolsets: string; readOnly?: boolean }): McpServerConfig {
  return {
    type: "stdio",
    name: "github",
    cmd: "github-mcp-server",
    args: ["stdio"],
    timeout: 300,
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    envs: {
      GITHUB_TOOLSETS: opts.toolsets,
      ...(opts.readOnly ? { GITHUB_READ_ONLY: "1" } : {}),
    },
  };
}

const MCP_DEVELOPER: McpServerConfig = { type: "builtin", name: "developer" };

export const ROLE_METAS: Record<AgentRole, RoleMeta> = {
  pmo: {
    role: "pmo",
    title: "PMO — Task refinement",
    description:
      "Refines tasks in Refining: dependencies (blockedBy/blocks), footprint, out-of-scope, checklist; moves to Planned or Blocked. Does not write code.",
    prompt:
      "Refine the Linear issue named in the message (issueId field). Follow your SOUL: normalize scope and ## Footprint, record dependencies, validate the checklist/prompt, and move to Planned (or Blocked if a human decision is missing).",
    soulFile: "pmo.SOUL.md",
    defaultMcpServers: [MCP_LINEAR, mcpGithub({ toolsets: "repos", readOnly: true }), MCP_DEVELOPER],
  },
  dev: {
    role: "dev",
    title: "Dev — Implementation",
    description:
      "Implements or fixes a task (mode: implement|fix), respecting the footprint as scope ceiling and the plan-gate. Opens a PR and attaches the link to the issue.",
    prompt:
      "Implement or fix the issue named in the message (issueId and mode fields). Respect the declared footprint as your scope ceiling and your SOUL's plan-gate; when opening the PR, attach its link to the issue before moving to Code Review.",
    soulFile: "dev.SOUL.md",
    defaultMcpServers: [MCP_LINEAR, mcpGithub({ toolsets: "repos,pull_requests" }), MCP_DEVELOPER],
  },
  reviewer: {
    role: "reviewer",
    title: "Reviewer — PR audit",
    description:
      "Reviews the PR of a task in In Review: traceability to the checklist/criteria, scope audit (footprint), bugs and security. Approves or rejects (Reopened).",
    prompt:
      "Review the PR of the issue named in the message (issueId field). Audit scope (footprint) and traceability to the acceptance criteria per your SOUL; approve or reject pointing at the specific files/lines.",
    soulFile: "reviewer.SOUL.md",
    defaultMcpServers: [mcpGithub({ toolsets: "repos,pull_requests" }), MCP_LINEAR, MCP_DEVELOPER],
  },
  orchestrator: {
    role: "orchestrator",
    title: "Orchestrator — Planning & Merge",
    description:
      "Two modes: planning (estimates the footprint and replies with ONLY the JSON) and merge (merges the PR of a task in Pending Merge). The mode comes in the message.",
    prompt:
      "Per the mode field of the message: in 'planning', reply with ONLY the issue's { footprint } JSON; in 'merge', merge the issue's PR. Follow your SOUL.",
    soulFile: "orchestrator.SOUL.md",
    defaultMcpServers: [MCP_LINEAR, mcpGithub({ toolsets: "repos,pull_requests" }), MCP_DEVELOPER],
  },
};

// agents/ lives at the repo root (sibling of app/). In Docker
// (WORKDIR=/app = conteúdo de app/) o COPY agents ./agents cai em /app/agents
// — por isso tentamos os dois layouts antes de desistir.
function resolveAgentsDir(): string {
  const candidates = [
    resolve(import.meta.dir, "..", "..", "..", "..", "agents"), // source: <repo>/agents
    resolve(import.meta.dir, "..", "..", "..", "agents"), // docker: /app/agents
    "/agents",
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

const AGENTS_DIR = resolveAgentsDir();

export function soulFilePath(role: AgentRole): string {
  return resolve(AGENTS_DIR, ROLE_METAS[role].soulFile);
}

/**
 * Binário compilado (docs/daemon-binary.md §7): as SOULs são embutidas como
 * texto no bundle (scripts/generate-embedded-assets.ts) — checadas ANTES do
 * disco, porque `agents/` (irmã de `app/`) não existe fora do checkout/imagem
 * Docker. Dev/Docker seguem lendo do disco (mapa embutido vazio no git).
 */
export function readSoulFile(role: AgentRole): string | null {
  const embedded = EMBEDDED_SOULS[ROLE_METAS[role].soulFile];
  if (embedded !== undefined) return embedded;
  const path = soulFilePath(role);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

// The communication protocol applies to EVERY harness and is concatenated to
// the SOUL when the prompt/recipe is assembled — it keeps living in git (it is
// deliberately not versioned per agent: it is a pipeline contract, not a
// variant's personality).
let protocolCache: string | null = null;
export function communicationProtocol(): string {
  if (protocolCache === null) {
    if (EMBEDDED_COMMUNICATION_PROTOCOL !== null) {
      protocolCache = EMBEDDED_COMMUNICATION_PROTOCOL.trimEnd();
    } else {
      const path = resolve(AGENTS_DIR, "COMMUNICATION_PROTOCOL.md");
      protocolCache = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
    }
  }
  // {{OUTPUT_LANGUAGE}} (§ Language): resolved per call — the operator can
  // change AGENT_OUTPUT_LANGUAGE on the Config screen and the next dispatch
  // already speaks the new language. Falls back to English when the database
  // is not readable (e.g. prompt assembly in tests without a config).
  let language = "English";
  try {
    const { str } = require("../../config/service") as typeof import("../../config/service");
    language = str("AGENT_OUTPUT_LANGUAGE") || "English";
  } catch {
    // keep the default
  }
  return protocolCache.replaceAll("{{OUTPUT_LANGUAGE}}", language);
}
