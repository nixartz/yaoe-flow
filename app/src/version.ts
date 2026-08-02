// Version of the standalone binary (`yaoe-flow version`). In the release
// pipeline (`bun build --compile --define`), CI injects YAOE_VERSION /
// YAOE_COMMIT as globals — see .github/workflows/release.yml. In dev
// (`bun run`/`bun test`) those globals do not exist (--define never ran): the
// bare reference throws ReferenceError, caught below, and we fall back to the
// package.json version + "dev" as the commit.
import pkg from "../package.json" with { type: "json" };

declare const YAOE_VERSION: string | undefined;
declare const YAOE_COMMIT: string | undefined;

function safeGlobal(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export const appVersion: string = safeGlobal(() => YAOE_VERSION) || pkg.version;
export const appCommit: string = safeGlobal(() => YAOE_COMMIT) || "dev";

export function platformTriple(): string {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

export interface VersionInfo {
  version: string;
  commit: string;
  platform: string;
  bunVersion: string;
}

export function versionInfo(): VersionInfo {
  return {
    version: appVersion,
    commit: appCommit,
    platform: platformTriple(),
    bunVersion: Bun.version,
  };
}
