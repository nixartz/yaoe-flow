// Proxy local OpenRouter: o goose aponta OPENROUTER_HOST pra cá; nós
// encaminhamos pra openrouter.ai e capturamos os generation ids (gen-…)
// das respostas SSE/JSON. Sem isso não dá pra reconciliar custo — a API
// pública não lista gerações por session_id.
import { config } from "../config";
import { log, errFields } from "../logger";
import * as store from "../dashboard/store";
import { resolveRunId } from "./registry";

const GEN_ID_RE = /"id"\s*:\s*"(gen-[A-Za-z0-9_-]+)"/g;
const COMPLETIONS_PATH = /\/api\/v1\/(chat\/completions|completions|responses)\/?$/;

let server: ReturnType<typeof Bun.serve> | null = null;

/** Capturas SSE em andamento por run — o reconcile espera zerar antes de listar. */
const pendingCaptures = new Map<string, number>();
const captureWaiters = new Map<string, Array<() => void>>();

function beginCapture(runId: string): void {
  pendingCaptures.set(runId, (pendingCaptures.get(runId) ?? 0) + 1);
}

function endCapture(runId: string): void {
  const next = (pendingCaptures.get(runId) ?? 1) - 1;
  if (next > 0) {
    pendingCaptures.set(runId, next);
    return;
  }
  pendingCaptures.delete(runId);
  const waiters = captureWaiters.get(runId);
  if (waiters?.length) {
    captureWaiters.delete(runId);
    for (const w of waiters) w();
  }
}

/** Resolve quando não há mais tee/capture ativo pra este run (ou timeout). */
export function waitForPendingCaptures(runId: string, timeoutMs = 10_000): Promise<void> {
  if (!pendingCaptures.has(runId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const list = captureWaiters.get(runId);
      if (list) {
        const idx = list.indexOf(onDone);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) captureWaiters.delete(runId);
      }
      resolve();
    }, timeoutMs);
    const onDone = () => {
      clearTimeout(timer);
      resolve();
    };
    const list = captureWaiters.get(runId) ?? [];
    list.push(onDone);
    captureWaiters.set(runId, list);
  });
}

function isLlmPath(pathname: string): boolean {
  return COMPLETIONS_PATH.test(pathname);
}

function parseAssociation(
  body: ArrayBuffer,
  reqHeaders: Headers
): { sessionId?: string; user?: string } {
  let sessionId: string | undefined;
  let user: string | undefined;
  try {
    const json = JSON.parse(new TextDecoder().decode(body)) as {
      session_id?: unknown;
      user?: unknown;
    };
    if (typeof json.session_id === "string") sessionId = json.session_id;
    if (typeof json.user === "string") user = json.user;
  } catch {
    /* body não-JSON — raro em chat/completions */
  }
  // Goose também manda Agent-Session-Id (= ACP session) no header.
  if (!user) {
    const hdr = reqHeaders.get("Agent-Session-Id") ?? reqHeaders.get("agent-session-id");
    if (hdr) user = hdr;
  }
  return { sessionId, user };
}

/** Drena o tee e grava gen-ids. `beginCapture` já foi chamado antes do fetch upstream. */
async function captureGenerationIds(stream: ReadableStream<Uint8Array>, runId: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const seen = new Set<string>();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Janela deslizante — o id aparece cedo no SSE; não precisamos do body inteiro.
      if (buf.length > 96_000) buf = buf.slice(-48_000);
      GEN_ID_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = GEN_ID_RE.exec(buf)) !== null) {
        const genId = m[1];
        if (seen.has(genId)) continue;
        seen.add(genId);
        store.recordGeneration(runId, genId);
      }
    }
  } catch (e) {
    log.openrouter.debug({ runId, ...errFields(e) }, "falha ao capturar generation ids do stream");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
    endCapture(runId);
  }
}

function forwardHeaders(upstream: Headers): Headers {
  const out = new Headers(upstream);
  // Bun já pode ter descomprimido o body; não reenviar encoding/length velhos.
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  return out;
}

function teeCapture(upstream: Response, runId: string): Response {
  if (!upstream.body) return upstream;
  const [forClient, forCapture] = upstream.body.tee();
  void captureGenerationIds(forCapture, runId);
  return new Response(forClient, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardHeaders(upstream.headers),
  });
}

export function proxyBaseUrl(): string {
  return `http://127.0.0.1:${config.openrouter.proxyPort}`;
}

export function startOpenRouterProxy(): void {
  if (server) return;
  if (!config.openrouter.reconcile) {
    log.openrouter.info("OPENROUTER_RECONCILE=false — reconciliation proxy disabled");
    return;
  }

  const upstreamBase = config.openrouter.upstream.replace(/\/$/, "");

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.openrouter.proxyPort,
    // Streams de chat/completions podem ficar abertos vários minutos.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const target = `${upstreamBase}${url.pathname}${url.search}`;
      const method = req.method.toUpperCase();

      let body: ArrayBuffer | undefined;
      let runId: string | undefined;
      if (method !== "GET" && method !== "HEAD") {
        body = await req.arrayBuffer();
        if (isLlmPath(url.pathname)) {
          runId = resolveRunId(parseAssociation(body, req.headers));
          if (!runId) {
            log.openrouter.warn(
              { path: url.pathname },
              "chat/completions with no run association — generation id will not be captured"
            );
          }
        }
      }

      const headers = new Headers();
      for (const [k, v] of req.headers.entries()) {
        const lower = k.toLowerCase();
        // Evita gzip/br: o Bun descomprime o upstream e reenviar Content-Encoding
        // quebrava o cliente (ZlibError). Pedimos identity e deixamos o body cru.
        if (
          lower === "host" ||
          lower === "connection" ||
          lower === "content-length" ||
          lower === "accept-encoding"
        ) {
          continue;
        }
        headers.set(k, v);
      }
      headers.set("Accept-Encoding", "identity");

      // Conta a captura ANTES do fetch: senão waitForPendingCaptures resolve na
      // janela em que o upstream ainda não respondeu (kill/cancel).
      if (runId) beginCapture(runId);

      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method,
          headers,
          body: body && body.byteLength > 0 ? body : undefined,
        });
      } catch (e) {
        if (runId) endCapture(runId);
        log.openrouter.error({ target, ...errFields(e) }, "OpenRouter proxy: failed to reach upstream");
        return new Response(JSON.stringify({ error: "openrouter proxy upstream failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }

      if (runId && isLlmPath(url.pathname)) {
        if (!upstream.body) {
          endCapture(runId);
          return new Response(null, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: forwardHeaders(upstream.headers),
          });
        }
        return teeCapture(upstream, runId);
      }
      if (runId) endCapture(runId);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: forwardHeaders(upstream.headers),
      });
    },
  });

  log.openrouter.info(
    { url: proxyBaseUrl(), upstream: upstreamBase },
    "OpenRouter reconcile proxy listening (goose OPENROUTER_HOST points here)"
  );
}

export function stopOpenRouterProxy(): void {
  server?.stop(true);
  server = null;
}
