import { describe, expect, test } from "bun:test";
import {
  cursorAcpArgs,
  cursorCredentialEnv,
  cursorDaemonHome,
  extractCursorLoginUrl,
  isCursorAuthRequiredError,
} from "../src/agent/harness/cursorAuth";

describe("cursorAuth helpers", () => {
  test("extractCursorLoginUrl from nested ACP error", () => {
    const url =
      "https://cursor.com/loginDeepControl?challenge=abc&uuid=7c6b6268-45e4-4aba-a46f-c85024449a43&mode=login&redirectTarget=cli";
    const err = {
      code: -32602,
      message: "Invalid params",
      data: { message: `Failed to open browser for login. Please visit: ${url}` },
    };
    expect(extractCursorLoginUrl(err)).toBe(url);
    expect(isCursorAuthRequiredError(err)).toBe(true);
  });

  test("extractCursorLoginUrl from Error message JSON", () => {
    const url = "https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login&redirectTarget=cli";
    expect(extractCursorLoginUrl(new Error(JSON.stringify({ data: { message: `visit: ${url}` } })))).toBe(url);
  });

  test("cursorAcpArgs puts --api-key before acp", () => {
    expect(cursorAcpArgs("")).toEqual(["acp"]);
    expect(cursorAcpArgs("key_abc")).toEqual(["--api-key", "key_abc", "acp"]);
  });

  test("cursorCredentialEnv forces file store and no browser", () => {
    const env = cursorCredentialEnv({ HOME: "/home/svc", FOO: "1" });
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe("file");
    expect(env.NO_OPEN_BROWSER).toBe("1");
    expect(env.HOME).toBe("/home/svc");
    expect(env.FOO).toBe("1");
  });

  test("cursorDaemonHome ignores isolated worktree HOME", () => {
    const real = "/home/lucas-souza";
    expect(cursorDaemonHome({ HOME: `${real}/.yaoe-flow/worktrees/run-12-home` })).not.toContain("run-12-home");
    expect(cursorDaemonHome({ HOME: real })).toBe(real);
  });
});
