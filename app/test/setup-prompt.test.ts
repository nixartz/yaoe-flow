import { describe, expect, test } from "bun:test";
import { maskSecret } from "../src/cli/setup/prompt";

describe("maskSecret", () => {
  test("curto vira bullets fixos", () => {
    expect(maskSecret("abc")).toBe("••••••••");
    expect(maskSecret("12345678")).toBe("••••••••");
  });

  test("longo mantém prefixo e sufixo", () => {
    expect(maskSecret("lin_api_abcdefghijklmnop")).toBe("lin_…mnop");
    expect(maskSecret("ghp_1234567890abcdef")).toBe("ghp_…cdef");
  });
});
