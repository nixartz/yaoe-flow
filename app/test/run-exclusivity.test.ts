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

describe("duplicate-dispatch / premature close safety", () => {
  test("listOpenRuns returns every open row for the issue", () => {
    const issueId = randomUUID();
    const a = startDevRun(issueId);
    const b = startDevRun(issueId);
    const open = store.listOpenRuns(issueId);
    expect(open.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  test("closeOpenRuns skips exceptRunIds (Blocked must not kill live twin)", () => {
    const issueId = randomUUID();
    const live = startDevRun(issueId);
    const dead = startDevRun(issueId);
    store.closeOpenRuns(issueId, "failed", "Blocked webhook", { exceptRunIds: [live] });

    const { sqlite } = appDb();
    const liveRow = sqlite.query(`SELECT status FROM runs WHERE id = $id`).get({ $id: live }) as { status: string };
    const deadRow = sqlite.query(`SELECT status FROM runs WHERE id = $id`).get({ $id: dead }) as { status: string };
    expect(liveRow.status).toBe("running");
    expect(deadRow.status).toBe("failed");
  });

  test("reviveRunIfStillActive restores failed/timeout but not cancelled", () => {
    const issueId = randomUUID();
    const failed = startDevRun(issueId);
    const cancelled = startDevRun(issueId);
    store.finishRun(failed, { status: "failed", error: "Closed by Blocked" });
    store.finishRun(cancelled, { status: "cancelled", error: "manual stop" });

    store.reviveRunIfStillActive(failed);
    store.reviveRunIfStillActive(cancelled);

    const { sqlite } = appDb();
    const f = sqlite.query(`SELECT status, ended_at FROM runs WHERE id = $id`).get({ $id: failed }) as {
      status: string;
      ended_at: number | null;
    };
    const c = sqlite.query(`SELECT status FROM runs WHERE id = $id`).get({ $id: cancelled }) as { status: string };
    expect(f.status).toBe("running");
    expect(f.ended_at).toBeNull();
    expect(c.status).toBe("cancelled");
  });
});
