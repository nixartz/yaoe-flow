// Fábrica dos adapters NATIVOS (§7.2, plano B do spike Cursor/Copilot): CLIs
// headless que falam ndjson próprio (não ACP) — `cursor-agent -p
// --output-format stream-json`, `copilot ... --output-format json`. Spawna o
// CLI, injeta o prompt via stdin/arg (varia por CLI — configurável), parseia
// cada linha JSON e normaliza pelo MELHOR ESFORÇO num shape compatível com o
// resto do pipeline (chunk de texto / tool call / fim de turno).
//
// IMPORTANTE (honestidade de implementação): este módulo segue a forma de
// integração que os dois CLIs documentam publicamente (ndjson por linha com
// um campo de tipo/role), mas SEM um binário real disponível neste ambiente
// pra validar o parser byte a byte — é o que o blueprint chama de "plano B
// nativo, referência Multica" (§7.2). Rodar o smoke test real (§9.2) antes de
// ativar em produção é obrigatório; ajustar os matchers de `parseLine` é o
// primeiro lugar a olhar se o smoke falhar.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolveHarnessBin, withHarnessSpawnEnv } from "../../cli/setup/harnessDeps";
import { agentLog, errFields } from "../../logger";
import type { HarnessAdapter, HarnessCapabilities, HarnessDetection, HarnessId, HarnessRun, HarnessRunInput } from "./types";

export interface NativeStreamJsonSpec {
  id: HarnessId;
  label: string;
  bin: string;
  /** Monta os args do processo (ex.: ["-p", "--output-format", "stream-json"]). O prompt final entra via stdin. */
  buildArgs(input: HarnessRunInput): string[];
  buildEnv(input: HarnessRunInput): Record<string, string>;
  capabilities: HarnessCapabilities;
  detect(): Promise<HarnessDetection>;
  /**
   * Extrai {textDelta?, toolName?, toolStatus?, done?, sessionId?, usage?} de
   * UMA linha ndjson do CLI. Isolado pra ser o ponto de ajuste rápido pós-smoke.
   */
  parseLine(line: Record<string, unknown>): {
    textDelta?: string;
    toolName?: string;
    toolStatus?: string;
    done?: boolean;
    sessionId?: string;
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  };
}

export function createNativeStreamJsonAdapter(spec: NativeStreamJsonSpec): HarnessAdapter {
  function createRun(input: HarnessRunInput): HarnessRun {
    const promptText = `${input.systemPrompt.trimEnd()}\n\n---\n\n${input.roleMeta.prompt}\n\n---\n\n${input.promptText}`;
    let killed = false;
    let proc: ReturnType<typeof Bun.spawn> | undefined;

    const result = (async () => {
      let collected = "";
      let sessionId: string | undefined;
      let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
      let stderrTail = "";
      try {
        // Mesmo pré-requisito do ACP client: posix_spawn com cwd inexistente
        // falha com ENOENT atribuído ao *binário* (mensagem enganosa).
        mkdirSync(input.cwd, { recursive: true });
        const p = (proc = Bun.spawn([resolveHarnessBin(spec.bin), ...spec.buildArgs(input)], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: withHarnessSpawnEnv(spec.buildEnv(input)),
          cwd: input.cwd,
        }));
        p.stdin.write(new TextEncoder().encode(promptText));
        p.stdin.end();

        (async () => {
          const dec = new TextDecoder();
          try {
            for await (const c of proc!.stderr as unknown as AsyncIterable<Uint8Array>) {
              stderrTail = (stderrTail + dec.decode(c)).slice(-4000);
            }
          } catch {
            /* pipe fechado */
          }
        })();

        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue; // linha não-JSON (banner/log do CLI) — ignora
            }
            const evt = spec.parseLine(parsed);
            if (evt.textDelta) {
              collected += evt.textDelta;
              input.onEvent({ kind: "agent_message_chunk", text: evt.textDelta, payload: parsed });
            }
            if (evt.toolName) {
              input.onEvent({ kind: "tool_call", toolName: evt.toolName, toolStatus: evt.toolStatus, payload: parsed });
            }
            if (evt.sessionId) sessionId = evt.sessionId;
            if (evt.usage) usage = evt.usage;
          }
        }
        const exitCode = await proc.exited;
        if (exitCode !== 0 && !killed) {
          throw new Error(`${spec.id} exited with code ${exitCode}: ${stderrTail.trim().slice(-1000)}`);
        }
        return {
          outputText: collected,
          usage,
          sessionId,
          externalRefs: sessionId ? { sessionId } : undefined,
          finalStatus: "completed" as const,
        };
      } catch (e) {
        agentLog({ harness: spec.id, runId: input.runId, role: input.role }).error({ ...errFields(e) }, "native adapter run failed");
        throw e;
      } finally {
        if (!input.resumeSessionId && existsSync(input.cwd)) {
          try {
            rmSync(input.cwd, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    })();

    return {
      result,
      kill() {
        killed = true;
        try {
          proc?.kill();
        } catch {
          /* já morto */
        }
      },
    };
  }

  return {
    id: spec.id,
    label: spec.label,
    capabilities: spec.capabilities,
    detect: spec.detect,
    createRun,
  };
}
