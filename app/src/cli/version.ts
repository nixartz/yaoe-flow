// `yaoe-flow version`: version + commit + platform, with a non-blocking check
// of the latest GitHub release.
import { versionInfo } from "../version";

const RELEASE_REPO = process.env.YAOE_RELEASE_REPO ?? "nixartz/yaoe-flow";

export async function cmdVersion(): Promise<void> {
  const info = versionInfo();
  console.log(`yaoe-flow ${info.version} (${info.commit}) ${info.platform} — bun ${info.bunVersion}`);
  await checkLatestRelease(info.version);
}

async function checkLatestRelease(current: string): Promise<void> {
  // Best-effort: offline, rate-limited or repo without a release yet — never
  // fails the command.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json" },
    });
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = (await res.json()) as { tag_name?: string };
    const latest = data.tag_name?.replace(/^v/, "");
    if (latest && latest !== current) {
      console.log(`\nlatest release available: v${latest} (run "yaoe-flow update" for instructions)`);
    }
  } catch {
    // deliberately silent — see comment above.
  }
}
