// DEMO seed for the dashboard: populates a DISPOSABLE database with
// plausible fictional runs/webhooks/logs to capture documentation
// screenshots without any real credential, customer issue or e-mail. NEVER
// point DASHBOARD_DB_PATH at the production database.
//
// Uso:
//   DASHBOARD_DB_PATH=/tmp/demo.sqlite APP_ENCRYPTION_KEY=$(openssl rand -hex 32) \
//     bun scripts/seed-demo.ts
import { randomUUID } from "node:crypto";
import { openAppDb } from "../src/db";
import { bootstrap } from "../src/config/bootstrap";

const { sqlite } = openAppDb(bootstrap.dashboardDbPath);

const now = Date.now();
const H = 3_600_000;

interface DemoRun {
  role: string;
  operation: string;
  issue: string;
  status: string;
  backend: string;
  model: string;
  startedAgoMs: number;
  durationMs: number | null;
  inTok?: number;
  outTok?: number;
  cost?: number;
}

const runs: DemoRun[] = [
  { role: "pmo", operation: "refine", issue: "DEMO-101", status: "completed", backend: "goose", model: "z-ai/glm-4.7-flash", startedAgoMs: 26 * H, durationMs: 4 * 60_000, inTok: 48_211, outTok: 6_930, cost: 0.031 },
  { role: "dev", operation: "implement", issue: "DEMO-101", status: "completed", backend: "goose", model: "qwen/qwen3-coder-next", startedAgoMs: 22 * H, durationMs: 31 * 60_000, inTok: 512_400, outTok: 48_112, cost: 0.62 },
  { role: "reviewer", operation: "review", issue: "DEMO-101", status: "completed", backend: "goose", model: "z-ai/glm-4.7-flash", startedAgoMs: 20 * H, durationMs: 9 * 60_000, inTok: 130_555, outTok: 9_411, cost: 0.11 },
  { role: "dev", operation: "implement", issue: "DEMO-102", status: "failed", backend: "goose", model: "qwen/qwen3-coder-next", startedAgoMs: 8 * H, durationMs: 12 * 60_000, inTok: 201_889, outTok: 15_002, cost: 0.28 },
  { role: "orchestrator", operation: "merge", issue: "DEMO-101", status: "completed", backend: "goose", model: "z-ai/glm-4.7-flash", startedAgoMs: 5 * H, durationMs: 3 * 60_000, inTok: 22_004, outTok: 1_882, cost: 0.02 },
  { role: "pmo", operation: "refine", issue: "DEMO-103", status: "running", backend: "goose", model: "z-ai/glm-4.7-flash", startedAgoMs: 6 * 60_000, durationMs: null },
];

const insertRun = sqlite.query(
  `INSERT INTO runs (id, backend, operation, role, issue_id, issue_identifier, mode, status, provider, model,
     input_tokens, output_tokens, cost_usd, usage_source, started_at, ended_at, duration_ms)
   VALUES ($id, $backend, $operation, $role, $issueId, $identifier, $mode, $status, 'openrouter', $model,
     $inTok, $outTok, $cost, 'goose_accumulated', $start, $end, $dur)`
);

const insertEvent = sqlite.query(
  `INSERT INTO run_events (run_id, seq, ts, kind, text, tool_name, tool_status, payload_json)
   VALUES ($runId, $seq, $ts, $kind, $text, $tool, $toolStatus, $payload)`
);

for (const r of runs) {
  const id = randomUUID();
  const start = now - r.startedAgoMs;
  insertRun.run({
    $id: id,
    $backend: r.backend,
    $operation: r.operation,
    $role: r.role,
    $issueId: randomUUID(),
    $identifier: r.issue,
    $mode: r.operation === "implement" ? "implement" : null,
    $status: r.status,
    $model: r.model,
    $inTok: r.inTok ?? null,
    $outTok: r.outTok ?? null,
    $cost: r.cost ?? null,
    $start: start,
    $end: r.durationMs ? start + r.durationMs : null,
    $dur: r.durationMs,
  });

  const steps: Array<[string, string | null, string | null, string | null]> = [
    ["message_chunk", `Analyzing issue ${r.issue} and the demo-org/demo-app repository…`, null, null],
    ["tool_call", null, "linear__get_issue", "completed"],
    ["tool_call", null, "developer__shell", "completed"],
    ["message_chunk", "Plan ready. Applying the changes and opening the PR…", null, null],
    ["tool_call", null, "github__create_pull_request", r.status === "failed" ? "failed" : "completed"],
  ];
  steps.forEach(([kind, text, tool, toolStatus], i) => {
    insertEvent.run({
      $runId: id,
      $seq: i + 1,
      $ts: start + (i + 1) * 30_000,
      $kind: kind,
      $text: text,
      $tool: tool,
      $toolStatus: toolStatus,
      $payload: JSON.stringify({ demo: true }),
    });
  });
}

const insertWebhook = sqlite.query(
  `INSERT INTO webhook_events (received_at, entity_type, action, issue_id, issue_identifier, issue_title,
     team_key, team_name, actor_name, actor_type, summary, triggered_scheduler, raw_json)
   VALUES ($ts, 'Issue', 'update', $issueId, $identifier, $title, 'DEMO', 'Demo Team', $actor, 'user', $summary, $trig, '{}')`
);

const webhooks = [
  ["DEMO-101", "Add a date-range filter to the report", "Ana (demo)", "To Do → Refining", 1],
  ["DEMO-101", "Add a date-range filter to the report", "PMO Agent", "Refining → Planned", 0],
  ["DEMO-102", "Fix listing pagination", "Bruno (demo)", "Planned → In Progress", 1],
  ["DEMO-103", "Export CSV on the sales dashboard", "Ana (demo)", "backlog → To Do", 0],
] as const;

webhooks.forEach(([identifier, title, actor, summary, trig], i) => {
  insertWebhook.run({
    $ts: now - (i + 1) * 2 * H,
    $issueId: randomUUID(),
    $identifier: identifier,
    $title: title,
    $actor: actor,
    $summary: summary,
    $trig: trig,
  });
});

const insertLog = sqlite.query(
  `INSERT INTO log_lines (ts, level, feature, msg, fields_json, raw)
   VALUES ($ts, $level, $feature, $msg, '{}', $raw)`
);

const logs = [
  ["info", "scheduler", "tick completed: 2 issues reconciled"],
  ["info", "goose", "dispatching worker for DEMO-102"],
  ["warn", "scheduler", "seat inProgress at capacity (2/2) — DEMO-104 waiting"],
  ["info", "webhook", "webhook received: DEMO-103 To Do"],
  ["error", "goose", "provider returned an empty response (retry 1/2)"],
] as const;

logs.forEach(([level, feature, msg], i) => {
  const ts = now - i * 90_000;
  insertLog.run({
    $ts: ts,
    $level: level,
    $feature: feature,
    $msg: msg,
    $raw: JSON.stringify({ level, time: ts, service: "yaoe-flow", feature, msg }),
  });
});

console.log(`seed-demo: database populated at ${bootstrap.dashboardDbPath}`);
console.log(`  runs: ${runs.length} · webhooks: ${webhooks.length} · logs: ${logs.length}`);
