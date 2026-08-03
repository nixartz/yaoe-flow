// Fábrica compartilhada pelos adapters ACP "maduros" (§7.2: claude-code via
// `claude-code-acp`, codex via `codex-acp`, cursor via `cursor-agent acp` —
// adapters Zed sobre os CLIs oficiais, ou ACP nativo no caso do Cursor).
// Diferem do goose em como a SOUL entra: sem deeplink de recipe, o system
// prompt (SOUL + protocolo + brief do papel) vai concatenado à primeira
// mensagem do turno — mecanismo portável entre adapters ACP que não têm o
// conceito de "recipe" do goose.
//
// Os MCPs do agente ativo vão pelo param `mcpServers` do `session/new` (forma
// padrão do ACP), traduzidos em acp/client.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHarnessBin, withHarnessSpawnEnv } from "../../cli/setup/harnessDeps";
import { agentLog, errFields } from "../../logger";
import { runAcpTurn, listAcpModels, cleanupWorkspace, type AcpProcess } from "../acp/client";
import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessDetection,
  HarnessId,
  HarnessModelInfo,
  HarnessRun,
  HarnessRunInput,
} from "./types";

/** Ajustes de spawn resolvidos por run (ex.: HOME isolado do Cursor). */
export interface AcpSpawnPrep {
  env?: Record<string, string>;
  /** Chamado no fim do run (sempre), pra limpar o que o prepare criou. */
  cleanup?(): void;
}

/**
 * O mínimo pra montar env/spawn do CLI. Um `HarnessRunInput` satisfaz isto,
 * e a sonda de modelos (listModels) monta um contexto sintético — assim
 * `buildEnv`/`prepareSpawn` valem pros dois casos sem duplicação.
 */
export interface AcpSpawnContext {
  runId: string;
  cwd: string;
  settings: Record<string, unknown>;
  env: Record<string, string>;
}

export interface AcpAdapterSpec {
  id: HarnessId;
  label: string;
  /** Binário spawnado (ex.: `claude-code-acp`, `codex-acp`, `cursor-agent`). */
  bin: string;
  args?: string[];
  /** Cursor ACP: `cursor_login` após initialize. */
  authenticateMethodId?: string;
  capabilities: HarnessCapabilities;
  /** Sonda de instalação/versão/auth — cada CLI tem seu próprio comando (ver docs/harness-notes.md). */
  detect(): Promise<HarnessDetection>;
  /** Env extra específico do adapter (ex.: ANTHROPIC_API_KEY, OPENAI_API_KEY). */
  buildEnv(ctx: AcpSpawnContext): Record<string, string>;
  /**
   * Preparo de ambiente por spawn, DEPOIS do buildEnv — para o que precisa de
   * diretório temporário e limpeza (Cursor: HOME isolado que neutraliza o
   * `~/.cursor/mcp.json` da máquina). Ver cursor.ts.
   */
  prepareSpawn?(ctx: AcpSpawnContext, env: Record<string, string>): AcpSpawnPrep;
  requestTimeoutMs?: number;
}

export function createAcpAdapter(spec: AcpAdapterSpec): HarnessAdapter {
  function createRun(input: HarnessRunInput): HarnessRun {
    const promptText = `${input.systemPrompt.trimEnd()}\n\n---\n\n${input.roleMeta.prompt}\n\n---\n\n${input.promptText}`;
    const log = agentLog({ harness: spec.id, runId: input.runId, role: input.role });
    let processRef: AcpProcess | null = null;
    let killed = false;

    const result = (async () => {
      let prep: AcpSpawnPrep | undefined;
      try {
        const baseEnv = withHarnessSpawnEnv(spec.buildEnv(input));
        prep = spec.prepareSpawn?.(input, baseEnv);
        const { result } = await runAcpTurn({
          spawn: {
            bin: resolveHarnessBin(spec.bin),
            args: spec.args ?? [],
            env: prep?.env ?? baseEnv,
            cwd: input.cwd,
          },
          authenticateMethodId: spec.authenticateMethodId,
          model: input.model,
          preferFast: input.preferFast,
          mcpServers: input.mcpServers,
          promptText,
          requestTimeoutMs: spec.requestTimeoutMs ?? 45 * 60_000,
          resumeSessionId: input.resumeSessionId,
          log,
          onEvent: input.onEvent,
          // Referência do processo chega ANTES de qualquer await — kill() no
          // meio do run (Pausar/Encerrar, reclaimStale) mata de verdade.
          onProcess(p) {
            processRef = p;
            if (killed) p.kill();
          },
        });
        return {
          outputText: result.outputText,
          stopReason: result.stopReason,
          usage: result.usage,
          sessionId: result.sessionId,
          externalRefs: { sessionId: result.sessionId },
          finalStatus: "completed" as const,
        };
      } catch (e) {
        log.error({ ...errFields(e) }, "acp adapter run failed");
        throw e;
      } finally {
        try {
          prep?.cleanup?.();
        } catch {
          /* best-effort */
        }
        cleanupWorkspace(input.cwd, false);
      }
    })();

    return {
      result,
      kill() {
        killed = true;
        processRef?.kill();
      },
    };
  }

  /**
   * Lista os modelos aceitos pelo CLI. Spawn dedicado e descartável: workspace
   * temporário, `prepareSpawn` do adapter (no Cursor, o HOME isolado — sem ele
   * a sonda subiria os MCPs da máquina só pra ler uma lista) e limpeza dos
   * dois no fim.
   */
  async function listModels(): Promise<{ models: HarnessModelInfo[]; defaultModelId?: string }> {
    const cwd = mkdtempSync(join(tmpdir(), `${spec.id}-models-`));
    const ctx: AcpSpawnContext = {
      runId: `${spec.id}-models-probe`,
      cwd,
      settings: {},
      env: process.env as Record<string, string>,
    };
    const log = agentLog({ harness: spec.id });
    const baseEnv = withHarnessSpawnEnv(spec.buildEnv(ctx));
    let prep: AcpSpawnPrep | undefined;
    try {
      prep = spec.prepareSpawn?.(ctx, baseEnv);
      return await listAcpModels({
        spawn: { bin: resolveHarnessBin(spec.bin), args: spec.args ?? [], env: prep?.env ?? baseEnv, cwd },
        authenticateMethodId: spec.authenticateMethodId,
        log,
      });
    } finally {
      try {
        prep?.cleanup?.();
      } catch {
        /* best-effort */
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    capabilities: spec.capabilities,
    detect: spec.detect,
    // Só quem enumera modelos ganha a sonda — pra `flag`/`none` a dashboard
    // continua no campo livre (goose/hermes resolvem modelo por env/recipe).
    ...(spec.capabilities.modelSelection === "list" ? { listModels } : {}),
    createRun,
  };
}

/** Sonda genérica `<bin> --version` — usada por vários harness (mesma forma). */
export async function detectByVersionFlag(
  bin: string,
  opts?: { authEnvVar?: string; versionArgs?: string[]; installHint?: string }
): Promise<HarnessDetection> {
  try {
    const resolved = resolveHarnessBin(bin);
    const proc = Bun.spawn([resolved, ...(opts?.versionArgs ?? ["--version"])], {
      stdout: "pipe",
      stderr: "pipe",
      env: withHarnessSpawnEnv(process.env as Record<string, string>),
    });
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    const code = await proc.exited;
    // A missing shebang interpreter (e.g. `node` only reachable via nvm, not
    // on a service manager's PATH) makes `env` print a clear, unambiguous
    // error instead of Bun.spawn failing outright — treat it as "not
    // installed" rather than the generic "produced some output" fallback
    // below, which would otherwise misreport this as "installed".
    const missingInterpreter = /\/usr\/bin\/env: .*No such file or directory/.test(out);
    if (code !== 0 && (!out.trim() || missingInterpreter)) {
      return {
        installed: false,
        authStatus: "unknown",
        installHint: missingInterpreter
          ? `${opts?.installHint ?? ""} (interpreter not found on PATH: ${out.trim()})`.trim()
          : opts?.installHint,
        checkedAt: Date.now(),
      };
    }
    const m = out.match(/(\d+\.\d+\.\d+)/);
    const hasApiKey = opts?.authEnvVar ? Boolean(process.env[opts.authEnvVar]) : undefined;
    return {
      installed: true,
      binPath: resolved,
      version: m?.[1],
      // Sem API key configurada, a auth depende do CLI estar logado (D5) —
      // não temos como confirmar isso genericamente; "unknown" é honesto.
      authStatus: hasApiKey ? "ok" : "unknown",
      checkedAt: Date.now(),
    };
  } catch {
    return {
      installed: false,
      authStatus: "unknown",
      installHint: opts?.installHint,
      checkedAt: Date.now(),
    };
  }
}
