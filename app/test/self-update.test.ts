import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicReplace,
  detectAssetName,
  extractExpectedSha,
  isCompiledBinaryInvocation,
  splitPlatformTriple,
  verifyChecksum,
} from "../src/cli/selfUpdate";

describe("detectAssetName", () => {
  test("linux/darwin x64 with AVX2: no baseline suffix", () => {
    expect(detectAssetName("linux", "x64", true)).toBe("yaoe-flow-linux-x64");
    expect(detectAssetName("darwin", "x64", true)).toBe("yaoe-flow-darwin-x64");
  });

  test("x64 without AVX2: -baseline suffix", () => {
    expect(detectAssetName("linux", "x64", false)).toBe("yaoe-flow-linux-x64-baseline");
    expect(detectAssetName("darwin", "x64", false)).toBe("yaoe-flow-darwin-x64-baseline");
  });

  test("arm64 never gets a baseline suffix, regardless of the avx2 flag", () => {
    expect(detectAssetName("darwin", "arm64", false)).toBe("yaoe-flow-darwin-arm64");
    expect(detectAssetName("linux", "arm64", false)).toBe("yaoe-flow-linux-arm64");
  });

  test("windows: .exe suffix, baseline inserted before it", () => {
    expect(detectAssetName("windows", "x64", true)).toBe("yaoe-flow-windows-x64.exe");
    expect(detectAssetName("windows", "x64", false)).toBe("yaoe-flow-windows-x64-baseline.exe");
  });
});

describe("splitPlatformTriple", () => {
  test("splits the version.ts platformTriple() shape", () => {
    expect(splitPlatformTriple("darwin-arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(splitPlatformTriple("linux-x64")).toEqual({ os: "linux", arch: "x64" });
    expect(splitPlatformTriple("windows-x64")).toEqual({ os: "windows", arch: "x64" });
  });
});

describe("extractExpectedSha", () => {
  const sums = [
    "aaaa111  yaoe-flow-linux-x64",
    "bbbb222  yaoe-flow-linux-x64-baseline",
    "cccc333  yaoe-flow-darwin-arm64",
    "dddd444 *yaoe-flow-windows-x64.exe",
    "",
  ].join("\n");

  test("finds the exact asset's hash (two-space shasum format)", () => {
    expect(extractExpectedSha(sums, "yaoe-flow-linux-x64")).toBe("aaaa111");
  });

  test("does not confuse an asset with its -baseline sibling", () => {
    expect(extractExpectedSha(sums, "yaoe-flow-linux-x64-baseline")).toBe("bbbb222");
  });

  test("handles the binary-mode '*filename' marker some sha256sum builds emit", () => {
    expect(extractExpectedSha(sums, "yaoe-flow-windows-x64.exe")).toBe("dddd444");
  });

  test("returns null when the asset isn't listed", () => {
    expect(extractExpectedSha(sums, "yaoe-flow-linux-arm64")).toBeNull();
  });
});

describe("verifyChecksum", () => {
  test("accepts the correct sha256 and rejects a wrong one", () => {
    const dir = mkdtempSync(join(tmpdir(), "self-update-test-"));
    const filePath = join(dir, "asset");
    writeFileSync(filePath, "hello world");
    const actual = createHash("sha256").update("hello world").digest("hex");

    expect(verifyChecksum(filePath, actual)).toBe(true);
    expect(verifyChecksum(filePath, actual.toUpperCase())).toBe(true); // case-insensitive
    expect(verifyChecksum(filePath, "0".repeat(64))).toBe(false);
  });
});

describe("atomicReplace", () => {
  test("replaces the target file's contents with the staged file's, same directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "self-update-test-"));
    const target = join(dir, "yaoe-flow");
    const staged = join(dir, ".yaoe-flow-update-123");
    writeFileSync(target, "old binary");
    writeFileSync(staged, "new binary");

    atomicReplace(target, staged);

    expect(readFileSync(target, "utf8")).toBe("new binary");
  });

  test("works even when the target does not exist yet (fresh install path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "self-update-test-"));
    const target = join(dir, "yaoe-flow");
    const staged = join(dir, ".yaoe-flow-update-123");
    writeFileSync(staged, "new binary");

    atomicReplace(target, staged);

    expect(readFileSync(target, "utf8")).toBe("new binary");
  });
});

describe("isCompiledBinaryInvocation", () => {
  test("true for Bun's $bunfs virtual path (compiled binary)", () => {
    expect(isCompiledBinaryInvocation("/$bunfs/root/yaoe-flow")).toBe(true);
    expect(isCompiledBinaryInvocation("B:\\~BUN\\root\\$bunfs\\yaoe-flow.exe")).toBe(true);
  });

  test("false for a dev-mode script path or undefined", () => {
    expect(isCompiledBinaryInvocation("/Users/dev/yaoe-flow/app/src/index.ts")).toBe(false);
    expect(isCompiledBinaryInvocation(undefined)).toBe(false);
  });
});
