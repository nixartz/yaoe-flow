import { afterEach, describe, expect, test } from "bun:test";
import { filesOutsideFootprint, isAncillaryScopePath } from "../src/scope";
import { footprintsCollide } from "../src/dag";
import { settingMeta } from "../src/config/registry";
import { invalidateSettingsCache } from "../src/config/service";

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

  test("CHANGELOG and OKF change bundles are ancillary", () => {
    expect(isAncillaryScopePath("CHANGELOG.md")).toBe(true);
    expect(isAncillaryScopePath("knowledge/changes/2026-08-10/perfil-settings/README.md")).toBe(
      true
    );
    expect(isAncillaryScopePath("knowledge/product/architecture.md")).toBe(false);
  });

  test("default doc paths cover the other common change-bundle layouts", () => {
    expect(isAncillaryScopePath(".okf/2026-08-11/x.md")).toBe(true);
    expect(isAncillaryScopePath("docs/changes/2026-08-11/x.md")).toBe(true);
    expect(isAncillaryScopePath("docs/adr/0001-pick-sqlite.md")).toBe(true);
    expect(isAncillaryScopePath(".changeset/lovely-pandas-jam.md")).toBe(true);
    // Product docs are NOT process docs — they stay real scope.
    expect(isAncillaryScopePath("docs/harnesses.md")).toBe(false);
  });

  test("doc patterns also match at any depth (monorepo packages)", () => {
    expect(isAncillaryScopePath("apps/web/CHANGELOG.md")).toBe(true);
    expect(isAncillaryScopePath("packages/api/knowledge/changes/2026-08-11/x.md")).toBe(true);
  });
});

describe("SCOPE_ANCILLARY_DOC_PATHS", () => {
  afterEach(() => {
    delete process.env.SCOPE_ANCILLARY_DOC_PATHS;
    invalidateSettingsCache();
  });

  test("a repo with its own layout marks ITS docs ancillary — and only those", () => {
    process.env.SCOPE_ANCILLARY_DOC_PATHS = "configdocs/**,RELEASES.md";
    invalidateSettingsCache();

    expect(isAncillaryScopePath("configdocs/changes/feature-x.md")).toBe(true);
    expect(isAncillaryScopePath("RELEASES.md")).toBe(true);
    // Replaced, not merged: the default layout is no longer ancillary here.
    expect(isAncillaryScopePath("knowledge/changes/2026-08-11/x.md")).toBe(false);
    expect(isAncillaryScopePath("src/auth/login.ts")).toBe(false);
  });

  test("the scope-check stops rejecting the change bundle the repo guide requires", () => {
    process.env.SCOPE_ANCILLARY_DOC_PATHS = "docs/changes/**";
    invalidateSettingsCache();

    expect(
      filesOutsideFootprint(
        ["src/auth/login.ts", "docs/changes/2026-08-11/auth/README.md"],
        ["my-api:src/auth/*"],
        "my-api"
      )
    ).toEqual([]);
  });

  test("explicit override wins over the configured value", () => {
    expect(isAncillaryScopePath("CHANGELOG.md", ["docs/changes/**"])).toBe(false);
    expect(isAncillaryScopePath("docs/changes/x.md", ["docs/changes/**"])).toBe(true);
  });

  test("validation rejects globs that would disable the scope-check", () => {
    const validate = settingMeta("SCOPE_ANCILLARY_DOC_PATHS")?.validate;
    expect(validate?.("docs/changes/**,CHANGELOG.md")).toBeNull();
    expect(validate?.("docs/changes/**,*")).toContain("disable the scope-check");
    expect(validate?.("../outside/**")).toContain("repo-relative");
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
