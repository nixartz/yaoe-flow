#!/usr/bin/env bun
/**
 * Cut a yaoe-flow release: bump versions, promote CHANGELOG [Unreleased],
 * commit, push, and tag so `.github/workflows/release.yml` builds binaries.
 *
 * Usage (from repo root):
 *   bun scripts/release.ts                 # patch bump (0.1.3 → 0.1.4)
 *   bun scripts/release.ts --minor         # 0.1.3 → 0.2.0
 *   bun scripts/release.ts --major         # 0.1.3 → 1.0.0
 *   bun scripts/release.ts 0.2.0           # exact version
 *   bun scripts/release.ts --dry-run       # print plan, write nothing
 *   bun scripts/release.ts --yes           # skip final proceed prompt
 *   bun scripts/release.ts --replace-tag   # delete existing vX.Y.Z then recreate
 *   bun scripts/release.ts --no-push       # commit + local tag only
 *
 * See CONTRIBUTING.md → "Cutting a release".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SCRIPT_DIR = import.meta.dir;
const ROOT = resolve(SCRIPT_DIR, "..");
const APP_PKG = join(ROOT, "app", "package.json");
const DASH_PKG = join(ROOT, "dashboard", "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

export type BumpKind = "patch" | "minor" | "major";

export interface ReleaseArgs {
  bump: BumpKind | null;
  explicitVersion: string | null;
  dryRun: boolean;
  yes: boolean;
  push: boolean;
  allowDirty: boolean;
  allowBranch: boolean;
  allowEmpty: boolean;
  skipTests: boolean;
  /** Explicitly allow deleting and recreating an existing tag (local + remote when pushing). */
  replaceTag: boolean;
  /** Poll `gh release view` after pushing until the workflow publishes the release (bounded, never hangs forever). */
  wait: boolean;
  /** Open a PR into main when the release was cut off-main (only reachable via --allow-branch). */
  pr: boolean;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(version: string): { major: number; minor: number; patch: number } {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) throw new Error(`invalid semver: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function bumpVersion(current: string, kind: BumpKind): string {
  const v = parseSemver(current);
  if (kind === "major") return `${v.major + 1}.0.0`;
  if (kind === "minor") return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

export function todayIsoDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Move `[Unreleased]` body into `## [version] - date`, leave an empty Unreleased.
 * Returns the promoted body (trimmed) for validation / logging.
 */
export function promoteChangelog(markdown: string, version: string, date: string): { next: string; body: string } {
  const unreleasedHeader = /^## \[Unreleased\]\s*$/m;
  const match = unreleasedHeader.exec(markdown);
  if (!match || match.index === undefined) {
    throw new Error("CHANGELOG.md: missing `## [Unreleased]` heading");
  }

  const afterHeader = match.index + match[0].length;
  const rest = markdown.slice(afterHeader);
  const nextHeading = /^## \[/m.exec(rest);
  const bodyRaw = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const body = bodyRaw.replace(/^\n+/, "").replace(/\n+$/, "");

  const before = markdown.slice(0, match.index);
  const after = nextHeading ? rest.slice(nextHeading.index) : "";

  const emptyUnreleased = `## [Unreleased]\n\n`;
  const released = `## [${version}] - ${date}\n\n${body ? `${body}\n\n` : ""}`;
  const next = `${before}${emptyUnreleased}${released}${after}`.replace(/\n{3,}/g, "\n\n");
  return { next, body };
}

export function setPackageVersion(pkgJson: string, version: string): string {
  const pkg = JSON.parse(pkgJson) as { version?: string };
  if (typeof pkg.version !== "string") throw new Error("package.json: missing version field");
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function changelogHasVersion(markdown: string, version: string): boolean {
  const escaped = version.replace(/\./g, "\\.");
  return new RegExp(`^## \\[${escaped}\\]\\s*-`, "m").test(markdown);
}

export function parseArgs(argv: string[]): ReleaseArgs {
  const out: ReleaseArgs = {
    bump: "patch",
    explicitVersion: null,
    dryRun: false,
    yes: false,
    push: true,
    allowDirty: false,
    allowBranch: false,
    allowEmpty: false,
    skipTests: false,
    replaceTag: false,
    wait: true,
    pr: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--no-push") out.push = false;
    else if (a === "--allow-dirty") out.allowDirty = true;
    else if (a === "--allow-branch") out.allowBranch = true;
    else if (a === "--allow-empty") out.allowEmpty = true;
    else if (a === "--skip-tests") out.skipTests = true;
    else if (a === "--replace-tag") out.replaceTag = true;
    else if (a === "--no-wait") out.wait = false;
    else if (a === "--no-pr") out.pr = false;
    else if (a === "--patch") out.bump = "patch";
    else if (a === "--minor") out.bump = "minor";
    else if (a === "--major") out.bump = "major";
    else if (a.startsWith("-")) {
      console.error(`release: unknown flag: ${a}`);
      process.exit(1);
    } else {
      parseSemver(a.replace(/^v/, "")); // validate (strip optional leading v)
      out.explicitVersion = a.replace(/^v/, "");
      out.bump = null;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/release.ts [version | --patch|--minor|--major] [flags]

Bump app/ + dashboard/ package.json, promote CHANGELOG [Unreleased], commit,
optionally push, and create tag vX.Y.Z (triggers GitHub release workflow).

Version:
  (default)     --patch
  --minor       0.1.3 → 0.2.0
  --major       0.1.3 → 1.0.0
  0.2.0         exact version (with or without leading v)

Flags:
  --dry-run       show plan; do not write, commit, or tag
  --yes / -y      skip the final "Proceed?" confirmation (does NOT imply --replace-tag)
  --replace-tag   if vX.Y.Z already exists, delete it (local + remote when pushing) and recreate
  --no-push       commit + local tag only (no git push)
  --allow-dirty   allow other uncommitted changes (only release files are staged)
  --allow-branch  allow running off main/master
  --allow-empty   allow releasing with an empty [Unreleased] section
  --skip-tests    do not run \`cd app && bun test\` before committing
  --no-wait       do not poll \`gh release view\` for the workflow to publish (default: wait, bounded)
  --no-pr         do not open a PR into main when the release was cut off-main (default: open one)
  --help          this message

Post-push (requires the \`gh\` CLI; skipped with a note if it's not installed):
  waits for the release workflow to publish vX.Y.Z via bounded \`gh release view\` polling
  (never hangs forever — prints the Actions URL on timeout instead), and opens a PR into
  main if the release was cut from another branch (--allow-branch).

Republishing a broken tag:
  bun scripts/release.ts 0.1.4 --replace-tag
  (interactive runs without --replace-tag will ask before deleting)`);
}

function run(cmd: string, args: string[], opts?: { cwd?: string; inherit?: boolean }): string {
  const r = spawnSync(cmd, args, {
    cwd: opts?.cwd ?? ROOT,
    encoding: "utf8",
    stdio: opts?.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? "?"})${err ? `: ${err}` : ""}`);
  }
  return (r.stdout ?? "").trim();
}

function git(...args: string[]): string {
  return run("git", args);
}

function localTagExists(tag: string): boolean {
  const r = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return r.status === 0;
}

/** Best-effort: empty string if remote unreachable / tag absent. */
function remoteTagExists(tag: string): boolean {
  const r = spawnSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return false;
  return (r.stdout ?? "").trim().length > 0;
}

function deleteLocalTag(tag: string): void {
  run("git", ["tag", "-d", tag], { inherit: true });
}

function deleteRemoteTag(tag: string): void {
  // Prefer delete ref over force-push so Actions sees a fresh create event when we re-push.
  run("git", ["push", "origin", `:refs/tags/${tag}`], { inherit: true });
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * If the tag already exists, require an explicit OK to delete it.
 * `--yes` alone is NOT enough — use `--replace-tag` or answer the prompt.
 */
export async function resolveReplaceTag(opts: {
  tag: string;
  local: boolean;
  remote: boolean;
  replaceTagFlag: boolean;
  dryRun: boolean;
  ask: (msg: string) => Promise<boolean>;
}): Promise<"keep" | "replace" | "abort"> {
  if (!opts.local && !opts.remote) return "keep";

  const where = [
    opts.local ? "local" : null,
    opts.remote ? "remote (origin)" : null,
  ]
    .filter(Boolean)
    .join(" + ");

  if (opts.replaceTagFlag) {
    if (opts.dryRun) {
      console.warn(`release: would delete existing tag ${opts.tag} (${where}) because --replace-tag`);
    }
    return "replace";
  }

  if (opts.dryRun) {
    console.warn(
      `release: warning — tag ${opts.tag} already exists (${where}); without --replace-tag a real run would ask before deleting`
    );
    return "keep";
  }

  const ok = await opts.ask(
    `Tag ${opts.tag} already exists (${where}). Delete it and recreate? This can republish a broken release.`
  );
  return ok ? "replace" : "abort";
}

function ghAvailable(): boolean {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/** `git@github.com:org/repo.git` / `https://github.com/org/repo.git` / `https://github.com/org/repo` → `org/repo`. */
export function repoSlugFromRemote(remoteUrl: string): string | null {
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? m[1]! : null;
}

export interface PollResult {
  published: boolean;
  url?: string;
}

/**
 * Bounded poll of `gh release view <tag>` until the release workflow has
 * published it (never hangs indefinitely — the workflow can take minutes,
 * so a timeout is an expected outcome, not a failure). `viewFn`/`sleepMs`
 * are injectable so this can be tested without a real `gh` call or a real
 * wait (contract suite stays network-free).
 */
export async function pollReleasePublished(
  tag: string,
  opts: {
    attempts?: number;
    sleepMs?: (attempt: number) => number;
    viewFn?: (tag: string) => { status: number; stdout: string };
  } = {}
): Promise<PollResult> {
  const attempts = opts.attempts ?? 10;
  const sleepMs = opts.sleepMs ?? ((attempt: number) => Math.min(2_000 * attempt, 20_000));
  const viewFn =
    opts.viewFn ??
    ((t: string) => {
      const r = spawnSync("gh", ["release", "view", t, "--json", "url"], { encoding: "utf8" });
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { status, stdout } = viewFn(tag);
    if (status === 0) {
      try {
        const data = JSON.parse(stdout) as { url?: string };
        if (data.url) return { published: true, url: data.url };
      } catch {
        // malformed output — treat as not-yet-ready, keep polling
      }
    }
    if (attempt < attempts) await Bun.sleep(sleepMs(attempt));
  }
  return { published: false };
}

interface PrResult {
  opened: boolean;
  url?: string;
  reason?: string;
}

/** Best-effort — a failure here (no auth, PR already exists, gh missing) never fails the release itself. */
function tryOpenReleasePr(branch: string, tag: string): PrResult {
  if (!ghAvailable()) return { opened: false, reason: "gh CLI not found" };
  const body = `Release ${tag}, cut from branch \`${branch}\` (not main/master via --allow-branch). Merge to bring the version bump + CHANGELOG promotion back into main.`;
  const r = spawnSync(
    "gh",
    ["pr", "create", "--base", "main", "--head", branch, "--title", `release: ${tag}`, "--body", body],
    { encoding: "utf8" }
  );
  if (r.status === 0) return { opened: true, url: (r.stdout ?? "").trim() };
  return { opened: false, reason: (r.stderr || r.stdout || "").trim() };
}

function readPkgVersion(path: string): string {
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error(`${path}: missing version`);
  return pkg.version;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(join(ROOT, ".git"))) {
    console.error("release: not a git checkout (missing .git)");
    process.exit(1);
  }
  for (const p of [APP_PKG, DASH_PKG, CHANGELOG]) {
    if (!existsSync(p)) {
      console.error(`release: missing ${p}`);
      process.exit(1);
    }
  }

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!args.allowBranch && branch !== "main" && branch !== "master") {
    console.error(`release: current branch is "${branch}" (expected main/master). Pass --allow-branch to override.`);
    process.exit(1);
  }

  const status = git("status", "--porcelain");
  if (status && !args.allowDirty) {
    console.error("release: working tree is dirty. Commit/stash first, or pass --allow-dirty.\n");
    console.error(status);
    process.exit(1);
  }

  const current = readPkgVersion(APP_PKG);
  const dashCurrent = readPkgVersion(DASH_PKG);
  if (current !== dashCurrent) {
    console.warn(`release: warning — app (${current}) and dashboard (${dashCurrent}) versions differ; both will be set to the new version.`);
  }

  const nextVersion = args.explicitVersion ?? bumpVersion(current, args.bump ?? "patch");
  parseSemver(nextVersion);

  const tag = `v${nextVersion}`;
  const hasLocal = localTagExists(tag);
  const hasRemote = remoteTagExists(tag);
  const replaceDecision = await resolveReplaceTag({
    tag,
    local: hasLocal,
    remote: hasRemote,
    replaceTagFlag: args.replaceTag,
    dryRun: args.dryRun,
    ask: confirm,
  });
  if (replaceDecision === "abort") {
    console.log("Aborted (existing tag kept). Pass --replace-tag to delete without this prompt.");
    process.exit(1);
  }
  const willReplaceTag = replaceDecision === "replace";

  const sameVersion = nextVersion === current;
  if (sameVersion && !willReplaceTag && !args.dryRun) {
    console.error(
      `release: next version equals current (${current}). To republish tag ${tag}, confirm tag deletion when prompted or pass --replace-tag.`
    );
    process.exit(1);
  }
  if (sameVersion && !willReplaceTag && args.dryRun && !hasLocal && !hasRemote) {
    console.error(`release: next version equals current (${current}) and no tag to replace`);
    process.exit(1);
  }

  const date = todayIsoDate();
  const changelogBefore = readFileSync(CHANGELOG, "utf8");
  let changelogNext = changelogBefore;
  let body = "";
  let skipChangelogPromote = false;
  const versionAlreadyInChangelog = changelogHasVersion(changelogBefore, nextVersion);

  if (sameVersion && versionAlreadyInChangelog) {
    const peek = promoteChangelog(changelogBefore, nextVersion, date);
    if (peek.body.trim()) {
      console.error(
        `release: [Unreleased] still has notes, but CHANGELOG already has ## [${nextVersion}]. ` +
          `Move those notes into the existing section by hand (or bump a new version) before retagging.`
      );
      process.exit(1);
    }
    skipChangelogPromote = true;
    body = `(republish ${tag} — CHANGELOG unchanged)`;
  } else {
    const promoted = promoteChangelog(changelogBefore, nextVersion, date);
    changelogNext = promoted.next;
    body = promoted.body;
    if (!body.trim() && !args.allowEmpty && !sameVersion) {
      console.error("release: [Unreleased] is empty. Add notes first, or pass --allow-empty.");
      process.exit(1);
    }
    if (!body.trim() && sameVersion) {
      skipChangelogPromote = true;
      body = `(republish ${tag} — no Unreleased notes)`;
    }
  }

  console.log(`Release plan
  branch:     ${branch}
  version:    ${sameVersion ? `${current} (unchanged, republish)` : `${current} → ${nextVersion}`}  (tag ${tag})
  date:       ${date}
  changelog:  ${skipChangelogPromote ? body : body.trim() ? `${body.split("\n").length} line(s) under [Unreleased]` : "(empty)"}
  replace:    ${willReplaceTag ? `yes — delete existing tag (${[hasLocal && "local", hasRemote && "remote"].filter(Boolean).join(" + ")})` : "no"}
  push:       ${args.push ? "yes (branch + tag)" : "no (--no-push)"}
  tests:      ${args.skipTests ? "skip" : "cd app && bun test"}
  post-push:  ${args.push ? `wait for publish: ${args.wait ? "yes" : "no (--no-wait)"}, open PR if off-main: ${args.pr ? "yes" : "no (--no-pr)"}` : "n/a (--no-push)"}
  dry-run:    ${args.dryRun ? "yes" : "no"}`);

  if (args.dryRun) {
    console.log("\n--dry-run: no files written, no git operations.");
    process.exit(0);
  }

  if (!args.yes) {
    const ok = await confirm(`Proceed with release ${tag}?`);
    if (!ok) {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  if (willReplaceTag) {
    if (hasLocal) {
      console.log(`→ deleting local tag ${tag}`);
      deleteLocalTag(tag);
    }
    if (hasRemote && args.push) {
      console.log(`→ deleting remote tag origin ${tag}`);
      deleteRemoteTag(tag);
    } else if (hasRemote && !args.push) {
      console.warn(
        `release: remote tag ${tag} still exists; with --no-push only the local tag was removed. Delete remote later with:\n  git push origin :refs/tags/${tag}`
      );
    }
  }

  if (!args.skipTests) {
    console.log("→ bun test (app/)");
    run("bun", ["test"], { cwd: join(ROOT, "app"), inherit: true });
  }

  writeFileSync(APP_PKG, setPackageVersion(readFileSync(APP_PKG, "utf8"), nextVersion));
  writeFileSync(DASH_PKG, setPackageVersion(readFileSync(DASH_PKG, "utf8"), nextVersion));
  if (!skipChangelogPromote) {
    writeFileSync(CHANGELOG, changelogNext);
  }
  console.log(`✓ wrote ${APP_PKG}, ${DASH_PKG}${skipChangelogPromote ? "" : `, ${CHANGELOG}`}`);

  const staged = ["app/package.json", "dashboard/package.json"];
  if (!skipChangelogPromote) staged.push("CHANGELOG.md");
  git("add", "--", ...staged);

  // If nothing changed (pure tag republish with identical package.json), commit may fail.
  const porcelain = git("status", "--porcelain", "--", ...staged);
  if (porcelain.trim()) {
    git("commit", "-m", willReplaceTag && sameVersion ? `release: ${tag} (retag)` : `release: ${tag}`);
    console.log(`✓ committed release: ${tag}`);
  } else {
    console.log(`✓ nothing to commit (versions already at ${nextVersion}) — retag only`);
  }

  git("tag", "-a", tag, "-m", `Release ${tag}`);
  console.log(`✓ tagged ${tag}`);

  if (args.push) {
    console.log(`→ git push origin ${branch}`);
    run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { inherit: true });
    console.log(`→ git push origin ${tag}`);
    run("git", ["push", "origin", tag], { inherit: true });
    console.log(`\n✓ pushed. GitHub Actions release workflow should start for ${tag}.`);

    if (!ghAvailable()) {
      console.log("  (gh CLI not found — skipping release-wait/PR steps; install https://cli.github.com to enable them)");
    } else {
      if (args.wait) {
        console.log(`→ waiting for the release workflow to publish ${tag} (bounded \`gh release view\` polling)...`);
        const result = await pollReleasePublished(tag);
        if (result.published) {
          console.log(`✓ release published: ${result.url}`);
        } else {
          const slug = repoSlugFromRemote(git("remote", "get-url", "origin"));
          console.log(
            "  release not confirmed published yet (workflow may still be running) — check manually" +
              (slug ? `:\n  https://github.com/${slug}/actions` : ".")
          );
        }
      }

      if (args.pr && branch !== "main" && branch !== "master") {
        console.log(`→ opening a PR to merge ${branch} into main (release cut off-main)...`);
        const pr = tryOpenReleasePr(branch, tag);
        if (pr.opened) {
          console.log(`✓ PR opened: ${pr.url}`);
        } else {
          console.log(
            `  could not open a PR automatically${pr.reason ? ` (${pr.reason})` : ""} — open one manually:\n` +
              `  gh pr create --base main --head ${branch} --title "release: ${tag}"`
          );
        }
      }
    }
  } else {
    console.log(`\n✓ local only. Push when ready:\n  git push origin ${branch}\n  git push origin ${tag}`);
  }
}

// Only run CLI when executed directly (not when imported by tests).
if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
