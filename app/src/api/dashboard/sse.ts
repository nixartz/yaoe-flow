import type { SSEStreamingApi } from "hono/streaming";

// Bun.serve tem um idleTimeout padrão curto (segundos) que fecha conexões sem
// tráfego — isso derrubava as SSE (ficavam ~10s abertas e reconectavam sem
// parar). Mandamos um `ping` nesse intervalo pra manter o socket "ativo"; o
// Bun.serve também sobe com idleTimeout explícito bem maior (ver server.ts),
// então as duas defesas se somam.
export const HEARTBEAT_MS = 15_000;

export async function heartbeatLoop(stream: SSEStreamingApi): Promise<void> {
  while (!stream.aborted) {
    await stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {});
    await stream.sleep(HEARTBEAT_MS);
  }
}
