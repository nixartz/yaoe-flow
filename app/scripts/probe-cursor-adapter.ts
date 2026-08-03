#!/usr/bin/env bun
// Validates the REAL Cursor adapter (src/agent/harness/cursor.ts) end to
// end, without going through the scheduler/Linear: builds a HarnessRunInput
// the way dispatch would, runs it against the installed `cursor-agent`, and
// prints the NormalizedEvents in the order they arrive (the same stream that
// feeds run_events/the dashboard). Manual, outside CI (needs a logged-in
// CLI). See sandbox/README.md.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorAdapter } from "../src/agent/harness/cursor";
import type { HarnessRunInput, NormalizedEvent } from "../src/agent/harness/types";
import type { McpServerConfig } from "../src/agent/recipe/defaults";

const runId = `probe-${Date.now()}`;
const cwd = join(tmpdir(), "cursor-adapter-probe", `run-${runId}`);
mkdirSync(cwd, { recursive: true });

// Toy repo with an obvious bug — forces read + edit + shell.
writeFileSync(join(cwd, "sum.ts"), "export function sum(a: number, b: number) {\n  return a - b;\n}\n");
await Bun.$`git init -q`.cwd(cwd).quiet();
await Bun.$`git add -A`.cwd(cwd).quiet();
await Bun.$`git -c user.email=p@p -c user.name=probe commit -qm init`.cwd(cwd).quiet();

const detection = await cursorAdapter.detect();
console.log(`detect: installed=${detection.installed} version=${detection.version} auth=${detection.authStatus}\n`);
if (!detection.installed) process.exit(1);

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;

// Same MCPs the dev agent carries by default in the database.
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
    "The file sum.ts has a bug: `sum` subtracts instead of adding. " +
    "Create a task list, fix the file, run `git diff` to confirm, and summarize what you did.",
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
  console.log(`\n=== RESULT (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`stopReason=${result.stopReason} status=${result.finalStatus} sessionId=${result.sessionId}`);
  console.log(`events by type: ${JSON.stringify(byKind)}`);
  console.log(`usage: ${JSON.stringify(result.usage ?? null)}`);
  console.log(`\nfinal text (tail):\n${result.outputText.trim().slice(-600)}`);
  // The workspace is removed by the adapter; verifying the file has to rely
  // on what the agent reported + the git diff it ran.
  console.log(`\nworkspace still exists? ${existsSync(cwd)} (expected: false — adapter cleanup)`);
  if (existsSync(join(cwd, "sum.ts"))) console.log(readFileSync(join(cwd, "sum.ts"), "utf8"));
} catch (e) {
  console.log(`\n=== FAILED (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
  console.log(`events received: ${events.length}`);
  process.exitCode = 1;
}

// No process.exit() on purpose: the script only ends once the adapter has
// terminated the CLI and cleared the turn's timers. If it hangs again (or a
// process is left over), that is a termination regression — this is how a
// `cursor-agent` leak per run was first caught.
await Bun.sleep(2000); // SIGTERM is not instantaneous — without this slack the check false-positives
const alive = (await Bun.$`pgrep -fl cursor-agent`.nothrow().text()).trim();
console.log(`\nlive cursor-agent processes after the run: ${alive === "" ? "0" : alive} (expected: 0)`);
