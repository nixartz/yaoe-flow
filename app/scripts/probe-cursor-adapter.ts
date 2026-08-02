#!/usr/bin/env bun
// Valida o adapter Cursor REAL (src/agent/harness/cursor.ts) ponta a ponta,
// sem passar pelo scheduler/Linear: monta um HarnessRunInput como o dispatch
// faria, roda contra o `cursor-agent` instalado e imprime os NormalizedEvent na
// ordem em que chegam (é o mesmo stream que alimenta run_events/dashboard).
// Manual, fora do CI (precisa do CLI logado). Ver sandbox/README.md.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorAdapter } from "../src/agent/harness/cursor";
import type { HarnessRunInput, NormalizedEvent } from "../src/agent/harness/types";
import type { McpServerConfig } from "../src/agent/recipe/defaults";

const runId = `probe-${Date.now()}`;
const cwd = join(tmpdir(), "cursor-adapter-probe", `run-${runId}`);
mkdirSync(cwd, { recursive: true });

// Repo de brinquedo com um bug óbvio — força leitura + edição + shell.
writeFileSync(join(cwd, "soma.ts"), "export function soma(a: number, b: number) {\n  return a - b;\n}\n");
await Bun.$`git init -q`.cwd(cwd).quiet();
await Bun.$`git add -A`.cwd(cwd).quiet();
await Bun.$`git -c user.email=p@p -c user.name=probe commit -qm init`.cwd(cwd).quiet();

const detection = await cursorAdapter.detect();
console.log(`detect: instalado=${detection.installed} versão=${detection.version} auth=${detection.authStatus}\n`);
if (!detection.installed) process.exit(1);

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;

// Mesmos MCPs que o agente dev traz por default no banco.
const mcpServers: McpServerConfig[] = [
  { type: "stdio", name: "linear", cmd: "npx", args: ["-y", "@tacticlaunch/mcp-linear"], timeout: 300, envKeys: ["LINEAR_API_TOKEN"] },
];

const events: NormalizedEvent[] = [];
const input: HarnessRunInput = {
  runId,
  role: "dev",
  kind: "dispatch",
  systemPrompt: "You are a senior engineer working autonomously. Be concise.",
  roleMeta: { title: "Senior Engineer", description: "Implements tasks", prompt: "Fix the bug described in the task." },
  promptText:
    "O arquivo soma.ts tem um bug: `soma` subtrai em vez de somar. " +
    "Crie uma lista de tarefas, corrija o arquivo, rode `git diff` pra confirmar e resuma o que fez.",
  cwd,
  mcpServers,
  model: process.env.PROBE_MODEL ?? "auto",
  settings: {},
  env,
  onEvent(evt) {
    events.push(evt);
    const head =
      evt.kind === "tool_call" || evt.kind === "tool_call_update"
        ? `${evt.toolName ?? "?"} [${evt.toolStatus ?? "?"}]`
        : (evt.text ?? JSON.stringify(evt.payload)).replace(/\s+/g, " ").slice(0, 110);
    console.log(`  ${evt.kind.padEnd(20)} ${head}`);
  },
};

const started = Date.now();
const run = cursorAdapter.createRun(input);
try {
  const result = await run.result;
  const byKind = events.reduce<Record<string, number>>((a, e) => ({ ...a, [e.kind]: (a[e.kind] ?? 0) + 1 }), {});
  console.log(`\n=== RESULTADO (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`stopReason=${result.stopReason} status=${result.finalStatus} sessionId=${result.sessionId}`);
  console.log(`eventos por tipo: ${JSON.stringify(byKind)}`);
  console.log(`usage: ${JSON.stringify(result.usage ?? null)}`);
  console.log(`\ntexto final (tail):\n${result.outputText.trim().slice(-600)}`);
  // O workspace é removido pelo adapter; a verificação do arquivo tem que ser
  // pelo que o agente contou + o git diff que ele rodou.
  console.log(`\nworkspace ainda existe? ${existsSync(cwd)} (esperado: false — cleanup do adapter)`);
  if (existsSync(join(cwd, "soma.ts"))) console.log(readFileSync(join(cwd, "soma.ts"), "utf8"));
} catch (e) {
  console.log(`\n=== FALHOU (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`erro: ${e instanceof Error ? e.message : String(e)}`);
  console.log(`eventos recebidos: ${events.length}`);
  process.exitCode = 1;
}

// Sem process.exit() de propósito: o script SÓ termina se o adapter tiver
// encerrado o CLI e limpado os timers do turno. Se voltar a pendurar (ou sobrar
// processo), é regressão do encerramento — foi assim que o vazamento de um
// `cursor-agent` por run apareceu.
await Bun.sleep(2000); // o SIGTERM não é instantâneo — sem a folga o check acusa falso positivo
const alive = (await Bun.$`pgrep -fl cursor-agent`.nothrow().text()).trim();
console.log(`\nprocessos cursor-agent vivos após o run: ${alive === "" ? "0" : alive} (esperado: 0)`);
