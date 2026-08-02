import { describe, expect, test } from "bun:test";
import { filesOutsideFootprint, isAncillaryScopePath } from "../src/scope";
import { footprintsCollide } from "../src/dag";

describe("isAncillaryScopePath", () => {
  test("lockfiles and manifests", () => {
    expect(isAncillaryScopePath("package-lock.json")).toBe(true);
    expect(isAncillaryScopePath("pnpm-lock.yaml")).toBe(true);
    expect(isAncillaryScopePath("bun.lock")).toBe(true);
    expect(isAncillaryScopePath("apps/web/package.json")).toBe(true);
    expect(isAncillaryScopePath("tsconfig.json")).toBe(true);
    expect(isAncillaryScopePath("tsconfig.build.json")).toBe(true);
    expect(isAncillaryScopePath("eslint.config.js")).toBe(true);
  });

  test("test companions", () => {
    expect(isAncillaryScopePath("src/audit-log/audit-log.test.ts")).toBe(true);
    expect(isAncillaryScopePath("__tests__/mongo-connector.spec.ts")).toBe(true);
    expect(isAncillaryScopePath("tests/unit/foo.ts")).toBe(true);
  });

  test("feature code is not ancillary", () => {
    expect(isAncillaryScopePath("src/audit-log/service.ts")).toBe(false);
    expect(isAncillaryScopePath("src/auth/login.tsx")).toBe(false);
  });
});

describe("filesOutsideFootprint", () => {
  test("ignores ancillary paths outside footprint", () => {
    const outside = filesOutsideFootprint(
      [
        "src/auth/login.ts",
        "package-lock.json",
        "tsconfig.json",
        "src/auth/login.test.ts",
        "src/billing/invoice.ts",
      ],
      ["my-api:src/auth/*"],
      "my-api"
    );
    expect(outside).toEqual(["src/billing/invoice.ts"]);
  });

  test("still flags feature code outside footprint", () => {
    const outside = filesOutsideFootprint(
      ["src/other/x.ts"],
      ["my-api:src/auth/*"],
      "my-api"
    );
    expect(outside).toEqual(["src/other/x.ts"]);
  });
});

describe("footprintsCollide ancillary", () => {
  test("lock/config-only overlap does not collide", () => {
    expect(
      footprintsCollide(["api:package-lock.json"], ["api:package-lock.json"])
    ).toBe(false);
    expect(footprintsCollide(["api:tsconfig.json"], ["api:tsconfig.json"])).toBe(false);
  });

  test("module overlap still collides", () => {
    expect(footprintsCollide(["api:src/auth/*"], ["api:src/auth/login.ts"])).toBe(true);
  });
});
