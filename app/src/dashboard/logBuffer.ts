// Ring buffer em memória das últimas N linhas de log (Pino/JSON) + publicação no
// bus para tail ao vivo (SSE) na dashboard. NÃO persiste em disco — o stdout já é
// a fonte durável (capturada pelo Docker/K8s); isto é só um viewer de curto prazo.
//
// Cuidado: este módulo é importado por `logger.ts` — não pode importar `logger.ts`
// de volta (ciclo) nem nada que dependa dele.
import { Writable } from "node:stream";
import { config } from "../config";
import { bus } from "./bus";

const buffer: string[] = [];

// Lido UMA vez (DASHBOARD_LOG_BUFFER_SIZE é requiresRestart) e com fallback:
// este push roda dentro do stream do Pino — se a resolução via banco falhar
// (ex.: boot ainda validando APP_ENCRYPTION_KEY), logar não pode explodir.
let size: number | null = null;
function bufferSize(): number {
  if (size === null) {
    try {
      size = config.dashboard.logBufferSize;
    } catch {
      size = 5000;
    }
  }
  return size;
}

function push(line: string): void {
  buffer.push(line);
  if (buffer.length > bufferSize()) buffer.shift();
  bus.emit("log", line);
}

export function recentLogs(limit?: number): string[] {
  if (!limit || limit >= buffer.length) return buffer.slice();
  return buffer.slice(buffer.length - limit);
}

export const logBufferStream = new Writable({
  write(chunk, _enc, callback) {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (line) push(line);
    }
    callback();
  },
});
