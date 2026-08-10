import { describe, expect, test } from "bun:test";
import {
  bumpVersion,
  parseSemver,
  promoteChangelog,
  setPackageVersion,
  todayIsoDate,
  resolveReplaceTag,
  changelogHasVersion,
} from "../../scripts/release";

describe("release script helpers", () => {
  test("parseSemver / bumpVersion", () => {
    expect(parseSemver("0.1.3")).toEqual({ major: 0, minor: 1, patch: 3 });
    expect(bumpVersion("0.1.3", "patch")).toBe("0.1.4");
    expect(bumpVersion("0.1.3", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.1.3", "major")).toBe("1.0.0");
    expect(() => parseSemver("v0.1.3")).toThrow();
  });

  test("todayIsoDate is YYYY-MM-DD", () => {
    expect(todayIsoDate(new Date("2026-08-10T15:00:00"))).toBe("2026-08-10");
  });

  test("promoteChangelog moves Unreleased into dated section", () => {
    const md = `# Changelog

## [Unreleased]

### Fixed

- Something important.

## [0.1.3] - 2026-08-03

### Fixed

- Older fix.
`;
    const { next, body } = promoteChangelog(md, "0.1.4", "2026-08-10");
    expect(body).toContain("Something important");
    expect(next).toContain("## [Unreleased]\n\n## [0.1.4] - 2026-08-10");
    expect(next).toContain("### Fixed\n\n- Something important.");
    expect(next).toContain("## [0.1.3] - 2026-08-03");
    expect(next.indexOf("## [Unreleased]")).toBeLessThan(next.indexOf("## [0.1.4]"));
    expect(next.indexOf("## [0.1.4]")).toBeLessThan(next.indexOf("## [0.1.3]"));
  });

  test("promoteChangelog allows empty Unreleased body", () => {
    const md = `## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n`;
    const { next, body } = promoteChangelog(md, "0.1.1", "2026-08-10");
    expect(body).toBe("");
    expect(next).toContain("## [0.1.1] - 2026-08-10\n\n## [0.1.0]");
  });

  test("setPackageVersion preserves other fields", () => {
    const out = setPackageVersion(`{\n  "name": "yaoe-flow",\n  "version": "0.1.3"\n}\n`, "0.1.4");
    expect(JSON.parse(out)).toEqual({ name: "yaoe-flow", version: "0.1.4" });
  });

  test("changelogHasVersion", () => {
    expect(changelogHasVersion("## [0.1.4] - 2026-08-10\n", "0.1.4")).toBe(true);
    expect(changelogHasVersion("## [0.1.3] - 2026-08-03\n", "0.1.4")).toBe(false);
  });

  test("resolveReplaceTag requires explicit OK", async () => {
    expect(
      await resolveReplaceTag({
        tag: "v0.1.4",
        local: false,
        remote: false,
        replaceTagFlag: false,
        dryRun: false,
        ask: async () => false,
      })
    ).toBe("keep");

    expect(
      await resolveReplaceTag({
        tag: "v0.1.4",
        local: true,
        remote: false,
        replaceTagFlag: true,
        dryRun: false,
        ask: async () => false,
      })
    ).toBe("replace");

    expect(
      await resolveReplaceTag({
        tag: "v0.1.4",
        local: true,
        remote: true,
        replaceTagFlag: false,
        dryRun: false,
        ask: async () => true,
      })
    ).toBe("replace");

    expect(
      await resolveReplaceTag({
        tag: "v0.1.4",
        local: true,
        remote: false,
        replaceTagFlag: false,
        dryRun: false,
        ask: async () => false,
      })
    ).toBe("abort");

    expect(
      await resolveReplaceTag({
        tag: "v0.1.4",
        local: true,
        remote: false,
        replaceTagFlag: false,
        dryRun: true,
        ask: async () => false,
      })
    ).toBe("keep");
  });
});
