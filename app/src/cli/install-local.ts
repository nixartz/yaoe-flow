// `yaoe-flow install-local` — compiles the binary for the current platform
// from the source tree and installs it into ~/.local/bin (see
// scripts/build-and-install.ts).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { flagBool, flagStr } from "./args";

/**
 * Locates the repo root (needs scripts/build-and-install.ts + app/src/index.ts).
 * In a compiled binary the source does NOT ship along — there we require being
 * inside the clone (cwd or parents).
 */
export function findServiceRoot(): string | null {
  const candidates: string[] = [];

  // Dev: this file lives in app/src/cli/ → three levels up.
  const fromModule = resolve(import.meta.dir, "../../..");
  candidates.push(fromModule);

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(dir);
    candidates.push(join(dir, "yaoe-flow"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const c of candidates) {
    if (
      existsSync(join(c, "scripts", "build-and-install.ts")) &&
      existsSync(join(c, "app", "src", "index.ts"))
    ) {
      return c;
    }
  }
  return null;
}

export async function cmdInstallLocal(flags: Record<string, string | boolean>): Promise<void> {
  if (flagBool(flags, "help") || flagBool(flags, "h")) {
    console.log(`Usage: yaoe-flow install-local [--skip-dashboard] [--dir <path>] [--yes]

Compiles the binary for this machine from a clone of the repository and
installs it into ~/.local/bin/yaoe-flow (override: --dir or YAOE_INSTALL_DIR).

Equivalent: bun scripts/build-and-install.ts  (at the repo root)`);
    return;
  }

  const root = findServiceRoot();
  if (!root) {
    console.error(
      "yaoe-flow install-local: source tree not found.\n" +
        "  This command only works from inside a clone of the repository.\n" +
        "  Alternative: bun scripts/build-and-install.ts (at the repo root)"
    );
    process.exit(1);
  }

  const bun = Bun.which("bun");
  if (!bun) {
    console.error("yaoe-flow install-local: bun not found on PATH.");
    process.exit(1);
  }

  const script = join(root, "scripts", "build-and-install.ts");
  const args = [script];
  if (flagBool(flags, "skip-dashboard")) args.push("--skip-dashboard");
  if (flagBool(flags, "yes") || flagBool(flags, "y")) args.push("--yes");
  const dir = flagStr(flags, "dir");
  if (dir) {
    args.push("--dir", dir);
  }

  const r = spawnSync(bun, args, { cwd: root, stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
