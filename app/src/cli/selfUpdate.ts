// Pure/testable pieces of `yaoe-flow update`'s atomic self-swap (cli/update.ts
// orchestrates I/O around these). Asset naming and AVX2 detection deliberately
// mirror scripts/install.sh / install.ps1 — the binary this command downloads
// must be name-for-name identical to what those installers would fetch.
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";

export type SelfUpdateOs = "darwin" | "linux" | "windows";
export type SelfUpdateArch = "x64" | "arm64";

/** Mirrors install.sh's `asset="yaoe-flow-$os-$arch"` (+ `-baseline`) / install.ps1's `.exe` variant. */
export function detectAssetName(os: SelfUpdateOs, arch: SelfUpdateArch, avx2: boolean): string {
  const baseline = arch === "x64" && !avx2 ? "-baseline" : "";
  if (os === "windows") return `yaoe-flow-windows-${arch}${baseline}.exe`;
  return `yaoe-flow-${os}-${arch}${baseline}`;
}

/**
 * Only meaningful for x64 (arm64 has no AVX2-baseline split — see install.sh).
 * Same probes as the shell installers, one per platform; any probe failure
 * (unreadable /proc/cpuinfo, no sysctl, PowerShell Add-Type blocked) assumes
 * a modern CPU — matches install.sh's "unknown probe → assume modern".
 */
export function detectAvx2(): boolean {
  if (process.arch !== "x64") return true;
  try {
    if (process.platform === "linux") {
      return /\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8"));
    }
    if (process.platform === "darwin") {
      const out = execFileSync("sysctl", ["-n", "machdep.cpu.leaf7_features"], { encoding: "utf8" });
      return /avx2/i.test(out);
    }
    if (process.platform === "win32") {
      // Same Win32 API probe as install.ps1's Test-Avx2Supported.
      const script =
        '$sig = \'[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);\'; ' +
        'Add-Type -MemberDefinition $sig -Name "Kernel32Probe" -Namespace "YaoeFlow"; ' +
        "[YaoeFlow.Kernel32Probe]::IsProcessorFeaturePresent(17)";
      const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
      return out.toLowerCase() === "true";
    }
  } catch {
    return true;
  }
  return true;
}

export function verifyChecksum(filePath: string, expectedSha256: string): boolean {
  const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return actual.toLowerCase() === expectedSha256.trim().toLowerCase();
}

/** `<hash>  <filename>` (shasum/sha256sum format) — same shape SHA256SUMS ships in. */
export function extractExpectedSha(sums: string, asset: string): string | null {
  const line = sums.split("\n").find((l) => {
    const parts = l.trim().split(/\s+/);
    return parts.length === 2 && parts[1]!.replace(/^\*/, "") === asset;
  });
  return line ? line.trim().split(/\s+/)[0]! : null;
}

/**
 * Replace targetPath with newFileTmpPath.
 * POSIX: same-directory rename() is atomic — a process that already exec'd
 * the old inode keeps running against it until it exits, so this is safe to
 * run against a live daemon binary.
 * Windows: a running .exe can hold its file locked, so rename-over can fail;
 * best effort is to move the old file aside first, then move the new one in.
 * If moving the old file aside succeeded but moving the new one in then fails
 * (e.g. a transient AV scan lock), targetPath would otherwise be left with no
 * binary at all — worse than the pre-update state — so that case rolls the
 * old file back into place before rethrowing. If the OS still refuses (lock
 * held by the running process on the FIRST move), this throws with targetPath
 * untouched — the caller prints a manual fallback ("stop the daemon, then retry").
 */
export function atomicReplace(targetPath: string, newFileTmpPath: string): void {
  if (process.platform === "win32") {
    const oldPath = `${targetPath}.old`;
    let movedOld = false;
    try {
      renameSync(targetPath, oldPath);
      movedOld = true;
    } catch {
      // no previous file to move aside — proceed anyway
    }
    try {
      renameSync(newFileTmpPath, targetPath);
    } catch (e) {
      if (movedOld) renameSync(oldPath, targetPath);
      throw e;
    }
    return;
  }
  renameSync(newFileTmpPath, targetPath);
}

/** True only when invoked as the compiled binary (Bun's `$bunfs` virtual path) — same heuristic as paths.ts's daemonStartArgv. */
export function isCompiledBinaryInvocation(argv1: string | undefined): boolean {
  return !!argv1 && (argv1.startsWith("/$bunfs/") || argv1.includes("$bunfs"));
}

export function splitPlatformTriple(triple: string): { os: SelfUpdateOs; arch: SelfUpdateArch } {
  const [os, arch] = triple.split("-");
  return { os: os as SelfUpdateOs, arch: arch as SelfUpdateArch };
}
