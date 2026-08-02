// Ponto único de dispatch — o scheduler importa SÓ daqui, nunca de um harness
// concreto (invariante §3.2). Desde a Fase 1/2 do blueprint multi-harness, o
// harness de um dispatch é decidido pelo AGENTE ATIVO do papel (banco), não
// mais por `AGENT_BACKEND` fixo no boot — `dispatch.ts` resolve isso a cada
// chamada (§7.3).
import { authorizedOrgsLine, joinDispatchLines, pendingMergeLine } from "./backend";
import { runDispatch, estimateFootprintViaAgent, cancelActiveRun } from "./dispatch";
import { activeAgentForRole } from "../db/agents";
import type { LinearContext } from "../db/linearConnections";
import { linearFor } from "../linear";
import type { Footprint, WorkerMode } from "../types";

/** Nome do backend/harness ativo do papel `orchestrator` — exibido no /health. */
export function backendName(): string {
  try {
    return activeAgentForRole("orchestrator")?.harnessId ?? "unresolved";
  } catch {
    return "unresolved";
  }
}

export function estimateFootprint(issueId: string, ctx: LinearContext): Promise<Footprint> {
  return estimateFootprintViaAgent(issueId, ctx);
}

export async function dispatchRefine(issueId: string, ctx: LinearContext): Promise<void> {
  const text = await joinDispatchLines(
    `issueId: ${issueId}`,
    authorizedOrgsLine(),
    linearFor(ctx).linearDispatchHints()
  );
  await runDispatch({
    operation: "dispatchRefine",
    role: "pmo",
    kind: "dispatch",
    issueId,
    promptText: text,
    linearCtx: ctx,
  });
}

export async function dispatchWorker(
  issueId: string,
  mode: WorkerMode,
  pendingMergeIssues: string[] | undefined,
  ctx: LinearContext
): Promise<void> {
  const text = await joinDispatchLines(
    `issueId: ${issueId}\nmode: ${mode}`,
    authorizedOrgsLine(),
    pendingMergeLine(pendingMergeIssues),
    linearFor(ctx).linearDispatchHints()
  );
  await runDispatch({
    operation: "dispatchWorker",
    role: "dev",
    kind: "dispatch",
    issueId,
    mode,
    promptText: text,
    linearCtx: ctx,
  });
}

export async function dispatchReviewer(issueId: string, ctx: LinearContext): Promise<void> {
  const text = await joinDispatchLines(`issueId: ${issueId}`, linearFor(ctx).linearDispatchHints());
  await runDispatch({
    operation: "dispatchReviewer",
    role: "reviewer",
    kind: "dispatch",
    issueId,
    promptText: text,
    linearCtx: ctx,
  });
}

export async function dispatchMerge(issueId: string, ctx: LinearContext): Promise<void> {
  const text = await joinDispatchLines(
    `mode: merge\nissueId: ${issueId}`,
    authorizedOrgsLine(),
    linearFor(ctx).linearDispatchHints()
  );
  await runDispatch({
    operation: "dispatchMerge",
    role: "orchestrator",
    kind: "dispatch",
    issueId,
    promptText: text,
    linearCtx: ctx,
  });
}

/** Encerra o processo do run (harness com capabilities.kill). false = não é um run ativo neste processo. */
export function cancelRun(runId: string): boolean {
  return cancelActiveRun(runId);
}
