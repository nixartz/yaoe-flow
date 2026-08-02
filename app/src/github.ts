// Cliente mínimo da API REST do GitHub — scope-check (arquivos da PR) e
// comentário em PR. Token: override por call → config.github.token (global).
// Multi-org: o scheduler passa o token da Linear connection (bot da org).
import { config } from "./config";
import { log, errFields } from "./logger";

const API = "https://api.github.com";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function parsePrUrl(url: string): PrRef | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function resolveToken(override?: string | null): string {
  return (override || config.github.token || "").trim();
}

function headers(token?: string | null): Record<string, string> {
  const t = resolveToken(token);
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${t}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function prKey(pr: PrRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

export async function getChangedFiles(pr: PrRef, token?: string | null): Promise<string[]> {
  const files: string[] = [];
  const key = prKey(pr);
  const start = Date.now();
  try {
    for (let page = 1; ; page++) {
      const url = `${API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`;
      const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(config.httpTimeoutMs) });
      if (!res.ok) {
        const body = await res.text();
        log.github.error(
          { operation: "getChangedFiles", pr: key, page, status: res.status, body },
          "GitHub API error"
        );
        throw new Error(`GitHub PR files ${res.status}: ${body}`);
      }
      const batch = (await res.json()) as { filename: string }[];
      files.push(...batch.map((f) => f.filename));
      if (batch.length < 100) break;
    }
    log.github.info(
      { operation: "getChangedFiles", pr: key, fileCount: files.length, durationMs: Date.now() - start },
      "GitHub PR files fetched"
    );
    return files;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("GitHub PR files")) throw e;
    log.github.error(
      { operation: "getChangedFiles", pr: key, ...errFields(e) },
      "GitHub request failed"
    );
    throw e;
  }
}

export async function commentOnPr(pr: PrRef, body: string, token?: string | null): Promise<void> {
  const key = prKey(pr);
  const url = `${API}/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(config.httpTimeoutMs),
    });
    const durationMs = Date.now() - start;
    if (!res.ok) {
      const resBody = await res.text();
      log.github.error(
        { operation: "commentOnPr", pr: key, status: res.status, body: resBody },
        "GitHub API error"
      );
      throw new Error(`GitHub PR comment ${res.status}: ${resBody}`);
    }
    log.github.info(
      { operation: "commentOnPr", pr: key, bodyLength: body.length, durationMs },
      "GitHub PR comment created"
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("GitHub PR comment")) throw e;
    log.github.error({ operation: "commentOnPr", pr: key, ...errFields(e) }, "GitHub request failed");
    throw e;
  }
}

/** Valida token (PAT fine-grained / classic / installation). */
export async function probeGithubToken(token: string): Promise<{ login: string; id: number; type: string }> {
  const t = token.trim();
  if (!t) throw new Error("github token vazia");
  const res = await fetch(`${API}/user`, {
    headers: headers(t),
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub /user ${res.status}: ${body}`);
  }
  const u = (await res.json()) as { login: string; id: number; type: string };
  return { login: u.login, id: u.id, type: u.type };
}
