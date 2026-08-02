// `yaoe-flow update`: atomic binary swap (download + checksum + rename +
// restart) is planned — for now the command covers the non-destructive part:
// checks the latest release and points at today's safe path — re-running the
// install one-liner (idempotent).
import { versionInfo } from "../version";

const RELEASE_REPO = process.env.YAOE_RELEASE_REPO ?? "nixartz/yaoe-flow";

export async function cmdUpdate(): Promise<void> {
  const current = versionInfo();
  console.log(`current version: ${current.version} (${current.commit})`);

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
    const latest = data.tag_name?.replace(/^v/, "");
    if (!latest || latest === current.version) {
      console.log("already on the latest version.");
      return;
    }
    console.log(`\nnew version available: v${latest}${data.html_url ? ` (${data.html_url})` : ""}`);
    console.log(
      "automatic atomic swap is on the roadmap — for now, re-run the install one-liner (idempotent):\n" +
        `  curl -fsSL https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts/install.sh | bash`
    );
  } catch (e) {
    console.log(`failed to check the latest release: ${String(e)}`);
  }
}
