// `yaoe-flow update [--force]`: atomic self-swap — download the latest release
// asset for this platform, verify its SHA256SUMS entry, and rename it over the
// running binary (see selfUpdate.ts for the rename-is-atomic rationale). Only
// works from a compiled binary (install.sh/install.ps1/install-local); refuses
// under `bun run` dev mode, where there is no binary file to replace.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { versionInfo } from "../version";
import { flagBool } from "./args";
import {
  atomicReplace,
  detectAssetName,
  detectAvx2,
  extractExpectedSha,
  isCompiledBinaryInvocation,
  splitPlatformTriple,
  verifyChecksum,
} from "./selfUpdate";

const RELEASE_REPO = process.env.YAOE_RELEASE_REPO ?? "nixartz/yaoe-flow";

async function downloadTo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  await Bun.write(outPath, res);
}

export async function cmdUpdate(flags: Record<string, string | boolean> = {}): Promise<void> {
  const current = versionInfo();
  console.log(`current version: ${current.version} (${current.commit})`);

  if (!isCompiledBinaryInvocation(process.argv[1])) {
    console.error(
      "yaoe-flow: self-update only works from the compiled binary (installed via install.sh, install.ps1, " +
        "or install-local) — running under `bun run`/dev mode has no binary file to replace."
    );
    process.exitCode = 1;
    return;
  }

  const force = flagBool(flags, "force");

  let latestTag: string;
  let releaseUrl: string | undefined;
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log("could not query the latest release (repo without a published release yet?).");
      return;
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!data.tag_name) {
      console.log("could not query the latest release (repo without a published release yet?).");
      return;
    }
    latestTag = data.tag_name;
    releaseUrl = data.html_url;
  } catch (e) {
    console.log(`failed to check the latest release: ${String(e)}`);
    process.exitCode = 1;
    return;
  }

  const latestVersion = latestTag.replace(/^v/, "");
  if (latestVersion === current.version && !force) {
    console.log("already on the latest version.");
    return;
  }

  console.log(
    `\n${force ? "re-installing" : "updating to"} v${latestVersion}${releaseUrl ? ` (${releaseUrl})` : ""}...`
  );

  const { os, arch } = splitPlatformTriple(current.platform);
  const asset = detectAssetName(os, arch, detectAvx2());
  const base = `https://github.com/${RELEASE_REPO}/releases/download/${latestTag}`;

  const tmp = mkdtempSync(join(tmpdir(), "yaoe-flow-update-"));
  try {
    const assetPath = join(tmp, asset);
    const sumsPath = join(tmp, "SHA256SUMS");
    console.log(`downloading ${asset}...`);
    await downloadTo(`${base}/${asset}`, assetPath);
    await downloadTo(`${base}/SHA256SUMS`, sumsPath);

    const expected = extractExpectedSha(readFileSync(sumsPath, "utf8"), asset);
    if (!expected) {
      console.error(`yaoe-flow: ${asset} not found in SHA256SUMS — aborting (nothing replaced).`);
      process.exitCode = 1;
      return;
    }
    if (!verifyChecksum(assetPath, expected)) {
      console.error("yaoe-flow: checksum mismatch — aborting (nothing replaced).");
      process.exitCode = 1;
      return;
    }

    const self = process.execPath;
    const stagedPath = join(dirname(self), `.yaoe-flow-update-${process.pid}`);
    copyFileSync(assetPath, stagedPath);
    chmodSync(stagedPath, 0o755);

    try {
      atomicReplace(self, stagedPath);
    } catch (e) {
      rmSync(stagedPath, { force: true });
      console.error(
        `yaoe-flow: could not replace the running binary at ${self}: ${String(e)}\n` +
          "the new binary was downloaded and verified but not installed — " +
          'on Windows the running .exe may be locked; run "yaoe-flow stop" and retry "yaoe-flow update".'
      );
      process.exitCode = 1;
      return;
    }

    console.log(`\n✅ updated: ${self} (v${latestVersion})`);
    console.log('restart any running daemon to use the new binary: "yaoe-flow stop && yaoe-flow daemon -d"');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
