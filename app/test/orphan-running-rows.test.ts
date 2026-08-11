import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as store from "../src/dashboard/store";
import { appDb } from "../src/db";

function startDevRun(issueId: string): string {
  return store.startRun({
    backend: "cursor",
    operation: "dispatchWorker",
    role: "dev",
    issueId,
    harnessId: "cursor",
  });
}

describe("closeOrphanRunningRows (boot-time self-heal)", () => {
  test("flips a 'running' row to 'failed' with an orphan error message and a duration", () => {
    const runId = startDevRun(randomUUID());

    const { closed } = store.closeOrphanRunningRows();
    expect(closed).toBeGreaterThanOrEqual(1);

    const { sqlite } = appDb();
    const row = sqlite.query(`SELECT status, error_message, ended_at, duration_ms FROM runs WHERE id = $id`).get({
      $id: runId,
    }) as { status: string; error_message: string | null; ended_at: number | null; duration_ms: number | null };
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("orphaned: process restarted while run was in flight");
    expect(row.ended_at).not.toBeNull();
    expect(row.duration_ms).not.toBeNull();
  });

  test("preserves a pre-existing error_message instead of overwriting it", () => {
    const runId = startDevRun(randomUUID());
    const { sqlite } = appDb();
    sqlite.query(`UPDATE runs SET error_message = $msg WHERE id = $id`).run({ $id: runId, $msg: "pre-existing error" });

    store.closeOrphanRunningRows();

    const row = sqlite.query(`SELECT status, error_message FROM runs WHERE id = $id`).get({ $id: runId }) as {
      status: string;
      error_message: string | null;
    };
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("pre-existing error");
  });

  test("does not touch a run already in a terminal state", () => {
    const runId = startDevRun(randomUUID());
    store.finishRun(runId, { status: "completed" });

    store.closeOrphanRunningRows();

    const { sqlite } = appDb();
    const row = sqlite.query(`SELECT status, error_message FROM runs WHERE id = $id`).get({ $id: runId }) as {
      status: string;
      error_message: string | null;
    };
    expect(row.status).toBe("completed");
    expect(row.error_message).toBeNull();
  });

  test("returns { closed: 0 } once nothing is left running", () => {
    store.closeOrphanRunningRows(); // drain anything still open from earlier tests
    expect(store.closeOrphanRunningRows()).toEqual({ closed: 0 });
  });
});
