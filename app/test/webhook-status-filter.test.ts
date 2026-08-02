import { describe, expect, test } from "bun:test";
import { parseWebhook } from "../src/webhook";

describe("parseWebhook — só status change aciona scheduler", () => {
  test("update com mudança de state → evento", () => {
    const evt = parseWebhook(
      JSON.stringify({
        type: "Issue",
        action: "update",
        data: { id: "iss-1", state: { name: "Pending Merge" } },
        updatedFrom: { stateId: "old-state-id" },
      })
    );
    expect(evt).toEqual({
      issueId: "iss-1",
      stateName: "Pending Merge",
      type: "Issue",
      action: "update",
    });
  });

  test("update só de label (mesmo state) → null (não fecha run de merge)", () => {
    const evt = parseWebhook(
      JSON.stringify({
        type: "Issue",
        action: "update",
        data: { id: "iss-1", state: { name: "Pending Merge" }, labels: [{ id: "l1", name: "agent:dev" }] },
        updatedFrom: { labelIds: ["l0"] },
      })
    );
    expect(evt).toBeNull();
  });

  test("create com state → evento", () => {
    const evt = parseWebhook(
      JSON.stringify({
        type: "Issue",
        action: "create",
        data: { id: "iss-2", state: { name: "To Do" } },
      })
    );
    expect(evt?.issueId).toBe("iss-2");
    expect(evt?.stateName).toBe("To Do");
  });

  test("Comment → null", () => {
    expect(
      parseWebhook(
        JSON.stringify({
          type: "Comment",
          action: "create",
          data: { id: "c1", issueId: "iss-1", body: "hi" },
        })
      )
    ).toBeNull();
  });
});
