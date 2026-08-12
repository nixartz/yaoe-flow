import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLinearClient, type LinearScope } from "../src/linear";

const SCOPE: LinearScope = {
  apiKey: "lin_api_batching_test_key_0123456789",
  teamId: null,
  connectionId: "conn-batching-test",
};

describe("listIssuesInStates batching", () => {
  let fetchCalls: { variables: Record<string, unknown> }[] = [];
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables?: Record<string, unknown> };
      fetchCalls.push({ variables: body.variables ?? {} });
      const data: Record<string, unknown> = {};
      Object.entries(body.variables ?? {}).forEach(([key, filter], i) => {
        const stateName = (filter as { state: { name: { eq: string } } }).state.name.eq;
        data[`s${i}`] = {
          nodes: [
            { id: `issue-${stateName}`, identifier: `ID-${stateName}`, title: "t", state: { name: stateName } },
          ],
        };
      });
      return {
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({ data }),
        json: async () => ({ data }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("fetches several distinct states in a single request", async () => {
    const client = createLinearClient(SCOPE);
    client.beginTickCache();

    const result = await client.listIssuesInStates(["Todo", "In Progress", "Code Review"]);

    expect(fetchCalls.length).toBe(1);
    expect(result["Todo"][0].identifier).toBe("ID-Todo");
    expect(result["In Progress"][0].identifier).toBe("ID-In Progress");
    expect(result["Code Review"][0].identifier).toBe("ID-Code Review");
  });

  test("a state already warmed by listIssuesInStates is served from cache", async () => {
    const client = createLinearClient(SCOPE);
    client.beginTickCache();

    await client.listIssuesInStates(["Todo", "In Progress"]);
    expect(fetchCalls.length).toBe(1);

    const todoAgain = await client.listIssuesInState("Todo");
    expect(todoAgain[0].identifier).toBe("ID-Todo");
    expect(fetchCalls.length).toBe(1);

    const count = await client.countInState("In Progress");
    expect(count).toBe(1);
    expect(fetchCalls.length).toBe(1);
  });

  test("a second batch only fetches the states not already cached this tick", async () => {
    const client = createLinearClient(SCOPE);
    client.beginTickCache();

    await client.listIssuesInStates(["Todo", "In Progress"]);
    expect(fetchCalls.length).toBe(1);

    const second = await client.listIssuesInStates(["Todo", "Blocked"]);
    expect(fetchCalls.length).toBe(2);
    expect(Object.keys(fetchCalls[1].variables).length).toBe(1);
    expect(second["Todo"][0].identifier).toBe("ID-Todo");
    expect(second["Blocked"][0].identifier).toBe("ID-Blocked");
  });

  test("beginTickCache resets the warm-up between ticks", async () => {
    const client = createLinearClient(SCOPE);
    client.beginTickCache();
    await client.listIssuesInStates(["Todo"]);
    expect(fetchCalls.length).toBe(1);

    client.beginTickCache();
    await client.listIssuesInStates(["Todo"]);
    expect(fetchCalls.length).toBe(2);
  });
});
