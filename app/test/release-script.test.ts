import { describe, expect, test } from "bun:test";
import {
  bumpVersion,
  parseArgs,
  parseSemver,
  pollReleasePublished,
  promoteChangelog,
  repoSlugFromRemote,
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

  test("parseArgs: --no-wait / --no-pr flip the wait/pr defaults", () => {
    expect(parseArgs([]).wait).toBe(true);
    expect(parseArgs([]).pr).toBe(true);
    expect(parseArgs(["--no-wait"]).wait).toBe(false);
    expect(parseArgs(["--no-pr"]).pr).toBe(false);
    expect(parseArgs(["--no-wait", "--no-pr"])).toMatchObject({ wait: false, pr: false });
  });

  test("repoSlugFromRemote handles ssh and https origin shapes", () => {
    expect(repoSlugFromRemote("git@github.com:nixartz/yaoe-flow.git")).toBe("nixartz/yaoe-flow");
    expect(repoSlugFromRemote("https://github.com/nixartz/yaoe-flow.git")).toBe("nixartz/yaoe-flow");
    expect(repoSlugFromRemote("https://github.com/nixartz/yaoe-flow")).toBe("nixartz/yaoe-flow");
    expect(repoSlugFromRemote("https://gitlab.com/nixartz/yaoe-flow.git")).toBeNull();
  });

  test("pollReleasePublished returns published:true as soon as viewFn reports a url, no extra polling", async () => {
    let calls = 0;
    const result = await pollReleasePublished("v0.1.4", {
      attempts: 5,
      sleepMs: () => 0,
      viewFn: () => {
        calls++;
        return { status: 0, stdout: JSON.stringify({ url: "https://github.com/nixartz/yaoe-flow/releases/tag/v0.1.4" }) };
      },
    });
    expect(result).toEqual({ published: true, url: "https://github.com/nixartz/yaoe-flow/releases/tag/v0.1.4" });
    expect(calls).toBe(1);
  });

  test("pollReleasePublished retries on failure and eventually succeeds", async () => {
    let calls = 0;
    const result = await pollReleasePublished("v0.1.4", {
      attempts: 5,
      sleepMs: () => 0,
      viewFn: () => {
        calls++;
        if (calls < 3) return { status: 1, stdout: "" };
        return { status: 0, stdout: JSON.stringify({ url: "https://github.com/nixartz/yaoe-flow/releases/tag/v0.1.4" }) };
      },
    });
    expect(result.published).toBe(true);
    expect(calls).toBe(3);
  });

  test("pollReleasePublished gives up after the bounded attempt count (never hangs forever)", async () => {
    let calls = 0;
    const result = await pollReleasePublished("v0.1.4", {
      attempts: 4,
      sleepMs: () => 0,
      viewFn: () => {
        calls++;
        return { status: 1, stdout: "" };
      },
    });
    expect(result).toEqual({ published: false });
    expect(calls).toBe(4);
  });

  test("pollReleasePublished treats malformed JSON as not-yet-ready and keeps polling", async () => {
    let calls = 0;
    const result = await pollReleasePublished("v0.1.4", {
      attempts: 3,
      sleepMs: () => 0,
      viewFn: () => {
        calls++;
        return { status: 0, stdout: "not json" };
      },
    });
    expect(result).toEqual({ published: false });
    expect(calls).toBe(3);
  });
});
