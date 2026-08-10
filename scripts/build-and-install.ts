#!/usr/bin/env bun
// Compiles the yaoe-flow standalone binary for the current platform and
// installs it into ~/.local/bin (or YAOE_INSTALL_DIR).
//
// Usage (from the repo root or app/):
//   bun scripts/build-and-install.ts
//   bun run build:install          # via app/package.json
//   yaoe-flow install-local        # CLI, when running from the source clone
//
// Flags:
//   --skip-dashboard   do not rebuild the SPA (reuses dashboard/dist)
//   --dir <path>       binary destination (default: ~/.local/bin)
//   --yes / -y         do not ask before overwriting (still backs up)
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = import.meta.dir;
const SERVICE_ROOT = resolve(SCRIPT_DIR, "..");
const APP_DIR = join(SERVICE_ROOT, "app");
const DASHBOARD_DIR = join(SERVICE_ROOT, "dashboard");
const DIST_DIR = join(SERVICE_ROOT, "dist");

interface HostTarget {
  /** Asset suffix (e.g. darwin-arm64) — same as the release pipeline. */
  name: string;
  /** Bun --target value (e.g. bun-darwin-arm64). */
  bunTarget: string;
  ext: string;
}

function hostTarget(): HostTarget {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (os === "windows" && arch === "arm64") {
    // Bun has no windows-arm64 target yet — same as install.sh / release.
    return { name: "windows-x64", bunTarget: "bun-windows-x64", ext: ".exe" };
  }
  return {
    name: `${os}-${arch}`,
    bunTarget: `bun-${os}-${arch}`,
    ext: os === "windows" ? ".exe" : "",
  };
}

function parseArgs(argv: string[]): { skipDashboard: boolean; yes: boolean; dir: string | null } {
  let skipDashboard = false;
  let yes = false;
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--skip-dashboard") skipDashboard = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--dir") {
      dir = argv[++i] ?? null;
      if (!dir) {
        console.error("build-and-install: --dir requires a path");
        process.exit(1);
      }
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun scripts/build-and-install.ts [--skip-dashboard] [--dir <path>] [--yes]

Compiles yaoe-flow for this machine and installs it on the user's PATH
(default: ~/.local/bin/yaoe-flow).`);
      process.exit(0);
    } else {
      console.error(`build-and-install: unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return { skipDashboard, yes, dir };
}

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`→ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`❌ failed: ${cmd} ${args.join(" ")} (exit ${r.status ?? "?"})`);
    process.exit(r.status ?? 1);
  }
}

function gitShortSha(): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: SERVICE_ROOT,
    encoding: "utf8",
  });
  if (r.status === 0 && r.stdout?.trim()) return r.stdout.trim();
  return "dev";
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function defaultInstallDir(): string {
  // Local builds → always the user's bin (no sudo). The release one-liner
  // (install.sh) may try /usr/local/bin first; here the request is explicitly
  // for ~/.local/bin. Override: YAOE_INSTALL_DIR.
  return process.env.YAOE_INSTALL_DIR || join(homedir(), ".local", "bin");
}

function resolveInstallDir(override: string | null): string {
  return resolve(override || defaultInstallDir());
}

export interface InstallResult {
  installedPath: string;
  distPath: string;
  backedUp?: string;
}

/**
 * Copies the compiled binary to the destination, backing up whatever already
 * exists there.
 */
export function installBinary(distPath: string, installDir: string, opts: { yes: boolean }): InstallResult {
  mkdirSync(installDir, { recursive: true });
  const destName = process.platform === "win32" ? "yaoe-flow.exe" : "yaoe-flow";
  const dest = join(installDir, destName);

  let backedUp: string | undefined;

  if (existsSync(dest)) {
    backedUp = `${dest}.bak.${Date.now()}`;
    renameSync(dest, backedUp);
    console.log(`ℹ️  ${dest} already existed — backup at ${backedUp}`);
  }

  copyFileSync(distPath, dest);
  if (process.platform !== "win32") chmodSync(dest, 0o755);

  // macOS Gatekeeper: a locally compiled binary normally has no quarantine
  // flag, but if it does (copied from Downloads etc.), remove it.
  if (process.platform === "darwin") {
    spawnSync("xattr", ["-d", "com.apple.quarantine", dest], { stdio: "ignore" });
  }

  return { installedPath: dest, distPath, backedUp };
}

export async function buildAndInstall(opts: {
  skipDashboard?: boolean;
  yes?: boolean;
  dir?: string | null;
}): Promise<InstallResult> {
  if (!existsSync(join(APP_DIR, "src", "index.ts"))) {
    console.error(`❌ source tree not found at ${SERVICE_ROOT} (expected app/src/index.ts).`);
    console.error("   Run this script from inside a clone of the repository.");
    process.exit(1);
  }

  const bun = Bun.which("bun");
  if (!bun) {
    console.error("❌ bun not found on PATH — required to compile.");
    process.exit(1);
  }

  const target = hostTarget();
  const version = packageVersion();
  const commit = gitShortSha();
  const installDir = resolveInstallDir(opts.dir ?? null);

  const destName = `yaoe-flow${target.ext}`;
  console.log(`Compiling yaoe-flow ${version} (${commit}) → ${target.name}`);
  console.log(`Destination: ${join(installDir, destName)}\n`);

  // 1) deps
  run(bun, ["install"], APP_DIR);

  // 2) dashboard SPA (embedded into the binary)
  if (!opts.skipDashboard) {
    run(bun, ["install"], DASHBOARD_DIR);
    run(bun, ["run", "build"], DASHBOARD_DIR);
  } else if (!existsSync(join(DASHBOARD_DIR, "dist", "index.html"))) {
    console.error("❌ --skip-dashboard but dashboard/dist/index.html does not exist — run without the flag.");
    process.exit(1);
  } else {
    console.log("ℹ️  --skip-dashboard: reusing existing dashboard/dist.");
  }

  // 3) embed migrations/SOULs/SPA (SPA must be present — same as release CI)
  run(bun, ["run", "embed-assets", "--", "--require-dashboard"], APP_DIR);

  // 4) compile
  mkdirSync(DIST_DIR, { recursive: true });
  const outfile = join(DIST_DIR, `yaoe-flow-${target.name}${target.ext}`);
  run(
    bun,
    [
      "build",
      "--compile",
      "--minify",
      `--target=${target.bunTarget}`,
      `--define`,
      `YAOE_VERSION=${JSON.stringify(version)}`,
      `--define`,
      `YAOE_COMMIT=${JSON.stringify(commit)}`,
      "src/index.ts",
      "--outfile",
      outfile,
    ],
    APP_DIR
  );

  if (!existsSync(outfile)) {
    console.error(`❌ compile did not produce ${outfile}`);
    process.exit(1);
  }

  // 5) install
  const result = installBinary(outfile, installDir, { yes: opts.yes ?? false });

  // Quick smoke test
  const smoke = spawnSync(result.installedPath, ["version"], { encoding: "utf8" });
  if (smoke.status === 0) {
    console.log(`\n✅ ${smoke.stdout.trim()}`);
  } else {
    console.log(`\n⚠️  installed at ${result.installedPath}, but "version" failed (exit ${smoke.status}).`);
  }

  console.log(`\n📦 Installed executable: ${result.installedPath}`);
  const pathHint =
    process.env.PATH?.split(process.platform === "win32" ? ";" : ":").includes(installDir) ?? false;
  if (!pathHint) {
    console.log(`⚠️  ${installDir} is not on your PATH — add it (e.g. export PATH="$HOME/.local/bin:$PATH").`);
  }

  console.log(`\nNext step: yaoe-flow setup   (then: yaoe-flow daemon)`);

  return result;
}

// Executed directly (not when imported).
if (import.meta.main) {
  const flags = parseArgs(process.argv.slice(2));
  await buildAndInstall({
    skipDashboard: flags.skipDashboard,
    yes: flags.yes,
    dir: flags.dir,
  });
}
