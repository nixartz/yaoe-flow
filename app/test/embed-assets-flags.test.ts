import { describe, expect, test } from "bun:test";
import { parseEmbedArgs } from "../scripts/generate-embedded-assets";

describe("embed-assets flags", () => {
  test("defaults", () => {
    expect(parseEmbedArgs([])).toEqual({ requireDashboard: false, noDashboard: false });
  });

  test("require / no-dashboard", () => {
    expect(parseEmbedArgs(["--require-dashboard"])).toEqual({ requireDashboard: true, noDashboard: false });
    expect(parseEmbedArgs(["--no-dashboard"])).toEqual({ requireDashboard: false, noDashboard: true });
  });
});
