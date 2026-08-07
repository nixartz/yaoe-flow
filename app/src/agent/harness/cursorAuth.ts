// Cursor CLI auth helpers — headless / isolated-HOME safe.
//
// The Cursor CLI stores interactive login as a macOS Keychain item named
// `cursor-user`. When yaoe-flow isolates HOME for MCP/git, the CLI probes that
// keychain against the fake HOME and either opens a browser or fails with
// "no credentials in the cursor-user keychain". Official escape hatches:
//   - CURSOR_API_KEY / --api-key (preferred for daemons)
//   - AGENT_CLI_CREDENTIAL_STORE=file (file-based tokens under ~/.cursor)
// See https://cursor.com/docs/cli/reference/authentication
import { homedir } from "node:os";
import { resolveHarnessBin } from "../../cli/setup/harnessDeps";
import { config } from "../../config";
import { log, errFields } from "../../logger";

const LOGIN_URL_RE = /https:\/\/cursor\.com\/loginDeepControl\?[^\s"'<>]+/i;
const AUTH_WAIT_DEFAULT_MS = 5 * 60_000;
const AUTH_POLL_MS = 3_000;

/** Env flags that keep Cursor CLI off the interactive keychain / browser. */
export function cursorCredentialEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    // File store avoids the `cursor-user` keychain probe that breaks under a
    // per-run HOME mirror (and under systemd without a GUI session).
    AGENT_CLI_CREDENTIAL_STORE: "file",
    NO_OPEN_BROWSER: "1",
  };
}

/**
 * Daemon profile HOME — never a previous run's isolated `…/run-*-home`.
 * Tests pass a fake HOME via `env.HOME`; production uses the service user's HOME.
 */
export function cursorDaemonHome(env?: Record<string, string>): string {
  const fromEnv = env?.HOME?.trim();
  const fromProcess = process.env.HOME?.trim();
  const pick = (h: string | undefined): string | undefined => {
    if (!h) return undefined;
    if (/[/\\]worktrees[/\\]run-[^/\\]+-home$/i.test(h)) return undefined;
    if (/[/\\]run-\d+-home$/i.test(h)) return undefined;
    return h;
  };
  return pick(fromEnv) || pick(fromProcess) || homedir();
}

/** Resolve API key: agent harness setting > config (ENV>db) > run env. */
export function resolveCursorApiKey(input: {
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
}): string {
  const fromSettings = typeof input.settings?.apiKey === "string" ? input.settings.apiKey.trim() : "";
  if (fromSettings) return fromSettings;
  const fromConfig = config.cursor.apiKey.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = (input.env?.CURSOR_API_KEY ?? "").trim();
  return fromEnv;
}

/** ACP spawn args: pass `--api-key` before `acp` when we have a key (Cursor docs). */
export function cursorAcpArgs(apiKey: string): string[] {
  if (apiKey) return ["--api-key", apiKey, "acp"];
  return ["acp"];
}

/** Pull the loginDeepControl URL out of an ACP / CLI error blob. */
export function extractCursorLoginUrl(err: unknown): string | null {
  const texts: string[] = [];
  const walk = (v: unknown, depth = 0): void => {
    if (v == null || depth > 6) return;
    if (typeof v === "string") {
      texts.push(v);
      return;
    }
    if (v instanceof Error) {
      texts.push(v.message);
      walk((v as Error & { data?: unknown }).data, depth + 1);
      walk((v as Error & { cause?: unknown }).cause, depth + 1);
      return;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["message", "data", "error", "stderr", "stdout"]) walk(o[k], depth + 1);
      try {
        texts.push(JSON.stringify(v));
      } catch {
        /* ignore */
      }
    }
  };
  walk(err);
  for (const t of texts) {
    const m = t.match(LOGIN_URL_RE);
    if (m) return m[0].replace(/[.,;]+$/, "");
  }
  return null;
}

export function isCursorAuthRequiredError(err: unknown): boolean {
  if (extractCursorLoginUrl(err)) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to open browser for login|not authenticated|login required|cursor_login/i.test(msg);
}

export interface CursorAuthStatus {
  loggedIn: boolean;
  raw: string;
  account?: string;
}

/** `cursor-agent status` against the daemon HOME (file credential store). */
export async function probeCursorAuthStatus(opts?: {
  apiKey?: string;
  home?: string;
}): Promise<CursorAuthStatus> {
  const home = opts?.home ?? cursorDaemonHome();
  const apiKey = (opts?.apiKey ?? resolveCursorApiKey({})).trim();
  const bin = resolveHarnessBin("cursor-agent");
  const env = cursorCredentialEnv({
    ...(process.env as Record<string, string>),
    HOME: home,
    ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}),
  });
  try {
    const proc = Bun.spawn([bin, "status"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    await proc.exited;
    const raw = out.trim();
    const loggedIn =
      /logged in|login successful|authenticated/i.test(raw) && !/not logged in|not authenticated/i.test(raw);
    // Best-effort account line (format varies by CLI version).
    const account =
      raw.match(/(?:email|account|user)\s*[:=]\s*(\S+)/i)?.[1] ??
      raw.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)?.[1];
    return { loggedIn: loggedIn || Boolean(apiKey && !/invalid.*api.?key/i.test(raw)), raw, account };
  } catch (e) {
    log.agent.warn({ harness: "cursor", ...errFields(e) }, "cursor-agent status probe failed");
    return { loggedIn: Boolean(apiKey), raw: String(e) };
  }
}

/**
 * Wait until Cursor auth is usable (API key set or CLI file-store login),
 * emitting progress for the run timeline.
 */
export async function waitForCursorAuth(opts: {
  timeoutMs?: number;
  apiKey?: string;
  onProgress?(msg: string): void;
  shouldAbort?(): boolean;
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? AUTH_WAIT_DEFAULT_MS;
  const deadline = Date.now() + timeoutMs;
  opts.onProgress?.(
    `Waiting for Cursor authentication (up to ${Math.round(timeoutMs / 60_000)} min). ` +
      `Set CURSOR_API_KEY in Config, or use Harness → Log in to Cursor.`
  );
  while (Date.now() < deadline) {
    if (opts.shouldAbort?.()) return false;
    const key = (opts.apiKey ?? resolveCursorApiKey({})).trim();
    if (key) {
      const st = await probeCursorAuthStatus({ apiKey: key });
      if (st.loggedIn) {
        opts.onProgress?.("Cursor authentication ready — retrying the run.");
        return true;
      }
    } else {
      const st = await probeCursorAuthStatus();
      if (st.loggedIn) {
        opts.onProgress?.("Cursor CLI login detected — retrying the run.");
        return true;
      }
    }
    await Bun.sleep(AUTH_POLL_MS);
  }
  opts.onProgress?.("Timed out waiting for Cursor authentication.");
  return false;
}

interface InteractiveLoginSession {
  proc: ReturnType<typeof Bun.spawn>;
  url: string | null;
  startedAt: number;
  done: boolean;
  error?: string;
}

let activeLogin: InteractiveLoginSession | null = null;

function collectLoginUrl(text: string, current: string | null): string | null {
  if (current) return current;
  const m = text.match(LOGIN_URL_RE);
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}

/**
 * Start `cursor-agent login` with NO_OPEN_BROWSER against the daemon HOME.
 * Returns a URL to open locally; the process stays alive until status is ok or timeout.
 */
export async function startCursorInteractiveLogin(): Promise<{
  url: string | null;
  alreadyLoggedIn: boolean;
  message: string;
}> {
  const apiKey = resolveCursorApiKey({});
  if (apiKey) {
    const st = await probeCursorAuthStatus({ apiKey });
    if (st.loggedIn) {
      return { url: null, alreadyLoggedIn: true, message: "CURSOR_API_KEY is configured and accepted." };
    }
  }
  const st = await probeCursorAuthStatus({ apiKey: apiKey || undefined });
  if (st.loggedIn) {
    return { url: null, alreadyLoggedIn: true, message: "Cursor CLI is already logged in on this machine." };
  }

  if (activeLogin && !activeLogin.done) {
    return {
      url: activeLogin.url,
      alreadyLoggedIn: false,
      message: activeLogin.url
        ? "Login already in progress — open the URL below."
        : "Login already in progress — waiting for the CLI to print a URL.",
    };
  }

  const home = cursorDaemonHome();
  const bin = resolveHarnessBin("cursor-agent");
  const env = cursorCredentialEnv({
    ...(process.env as Record<string, string>),
    HOME: home,
  });
  const proc = Bun.spawn([bin, "login"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });
  const session: InteractiveLoginSession = { proc, url: null, startedAt: Date.now(), done: false };
  activeLogin = session;

  const ingest = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const text = dec.decode(chunk);
        session.url = collectLoginUrl(text, session.url);
      }
    } catch {
      /* closed */
    }
  };
  void ingest(proc.stdout as unknown as ReadableStream<Uint8Array>);
  void ingest(proc.stderr as unknown as ReadableStream<Uint8Array>);
  void proc.exited.then((code) => {
    session.done = true;
    if (code !== 0 && !session.url) {
      session.error = `cursor-agent login exited with code ${code}`;
    }
    if (activeLogin === session) activeLogin = null;
  });

  // Give the CLI a moment to print the URL.
  const waitUntil = Date.now() + 8_000;
  while (!session.url && !session.done && Date.now() < waitUntil) {
    await Bun.sleep(200);
  }

  return {
    url: session.url,
    alreadyLoggedIn: false,
    message: session.url
      ? "Open the URL in a browser on a machine where you can log in. This page will detect when login completes."
      : session.error ??
        "Started cursor-agent login but no URL appeared yet. Check the server logs, or set CURSOR_API_KEY in Config.",
  };
}

export function getCursorInteractiveLoginState(): {
  active: boolean;
  url: string | null;
  startedAt?: number;
  error?: string;
} {
  if (!activeLogin) return { active: false, url: null };
  return {
    active: !activeLogin.done,
    url: activeLogin.url,
    startedAt: activeLogin.startedAt,
    error: activeLogin.error,
  };
}

export async function cancelCursorInteractiveLogin(): Promise<void> {
  if (!activeLogin) return;
  try {
    activeLogin.proc.kill();
  } catch {
    /* ignore */
  }
  activeLogin.done = true;
  activeLogin = null;
}
