// Pipeline-policy overlay — STOPGAP assembly for hot operator flags.
//
// WHY THIS FILE EXISTS
// The SOUL + COMMUNICATION_PROTOCOL describe the DEFAULT product
// (footprint = privilege ceiling; Linear blockedBy is real). Flags such as
// IGNORE_FOOTPRINT_LOCKS / IGNORE_BLOCKING_ISSUES are operator *exceptions*,
// hot, default false. Baking the exception into agents/*.SOUL.md would break
// the default, force sync-souls on every toggle, and leave installs with the
// flags off running a weaker agent.
//
// WHAT IT DOES TODAY
// When a flag is on, `pipelinePolicyOverlay(role)` returns a short English
// block. `appendPipelinePolicy` concatenates it after the existing prompt
// (same `---` separator the adapters already use). Empty string when both
// flags are off — zero extra tokens. Role-specific bullets (Reviewer vs Dev
// vs PMO) so the scheduler bypass is not silently undone by the agent.
//
// HOW TO REDO THIS
// This is an ad-hoc overlay for two booleans, spliced at two call sites
// (Goose recipe `instructions` vs ACP/native first-turn concatenation)
// because those paths do not share an assembler today:
//   • Goose (`builder.ts`): SOUL + protocol live in recipe.instructions
//   • ACP / native (`acpAdapter.ts`, `nativeStreamJson.ts`): SOUL + role
//     brief + user message; protocol is NOT concatenated here (pre-existing
//     split; HarnessRunInput.systemPrompt is documented as "SOUL + protocol"
//     but dispatch currently passes the SOUL only).
// The intended replacement is a single `assembleAgentInstructions({ soul,
// role })` called from `dispatch.ts` when filling `systemPrompt`, including
// protocol + any policy overlays, with adapters forbidden from concatenating
// protocol again. Goose `cachedGooseRecipe` must then key on the assembly
// (see `recipeAssemblyKey`). Do NOT grow this file into a generic
// config→SOUL compiler — keep overlays to *enforcement* flags that would
// otherwise contradict the SOUL (scheduler bypass vs agent audit).
//
// Related: knowledge/product/pipeline-policy-overlay.md
import { dispatchGateFlags, type DispatchGateFlags } from "../../dispatch-gates";
import { toAgentRole, type AgentRole, type SchedulerRole } from "./defaults";

const SEPARATOR = "\n\n---\n\n";

export function pipelinePolicyOverlay(
  role: AgentRole | SchedulerRole,
  flags: DispatchGateFlags = dispatchGateFlags()
): string {
  if (!flags.ignoreFootprintLocks && !flags.ignoreBlockingIssues) return "";

  const r = toAgentRole(role);
  const parts: string[] = [
    "## Current pipeline policy (operator Config — this run)",
    "The scheduler is running with operator opt-in bypasses (Config → Reliability & merge). When a bullet below conflicts with the SOUL or COMMUNICATION_PROTOCOL, follow the bullet for THIS run. When both flags are off, this block is omitted and the SOUL/protocol apply unchanged.",
  ];

  if (flags.ignoreFootprintLocks) {
    parts.push(
      "IGNORE_FOOTPRINT_LOCKS=true: the scheduler dispatches even when another in-flight issue holds an overlapping footprint lock, and does not reopen a PR solely because the diff escapes ## Footprint. A missing PR and AGENT_AUTHORIZED_ORGS still apply. Footprint remains the privilege ceiling for feature/module code (protocol §8) — this flag is parallelism and deterministic-check skip, not a license to edit the whole repo."
    );
    if (r === "dev") {
      parts.push(
        "Dev: other agents may be editing overlapping paths in parallel. Expect merge conflicts; rebase or stack as you already do for pendingMergeIssues. Do not 🙋+Blocked because of a colliding lock."
      );
    }
    if (r === "reviewer") {
      parts.push(
        "Reviewer: do not reject (Reopened) solely because non-ancillary files sit outside ## Footprint — note 📝 if the leak is real. Still reject for bugs, security, missing checklist/§14 deliverables, and a PR on the wrong repository (protocol §10)."
      );
    }
    if (r === "pmo" || r === "orchestrator") {
      parts.push(
        "Keep declaring (PMO) and estimating (Orchestrator planning) a tight repo-qualified footprint. The flag does not cancel footprint as a scope boundary."
      );
    }
  }

  if (flags.ignoreBlockingIssues) {
    parts.push(
      "IGNORE_BLOCKING_ISSUES=true: the scheduler may have pulled this issue while Linear blockedBy blockers are still open, or while this issue still blocks others. Do not 🙋+Blocked for unmet Linear deps. Implement THIS issue. The Linear Blocked status is unchanged (human/circuit-breaker park)."
    );
    if (r === "pmo") {
      parts.push(
        "PMO: still translate real dependencies into Linear blockedBy/blocks. Do not omit relations because the scheduler is ignoring them — they remain facts for humans and for when the flag is turned off."
      );
    }
  }

  return parts.join("\n\n");
}

/** Appends the overlay after `base`, or returns `base` unchanged when both flags are off. */
export function appendPipelinePolicy(
  base: string,
  role: AgentRole | SchedulerRole,
  flags: DispatchGateFlags = dispatchGateFlags()
): string {
  const overlay = pipelinePolicyOverlay(role, flags);
  if (!overlay) return base;
  return `${base.trimEnd()}${SEPARATOR}${overlay}`;
}

/**
 * Cache key fragment for anything that bakes protocol/overlay at recipe-build
 * time (Goose `cachedGooseRecipe`). Include this whenever assembly reads hot
 * config — otherwise a Config-screen toggle keeps serving a stale recipe.
 * Optional `flags` is for tests; production callers omit it.
 */
export function recipeAssemblyKey(flags: DispatchGateFlags = dispatchGateFlags()): string {
  let language = "English";
  try {
    const { str } = require("../../config/service") as typeof import("../../config/service");
    language = str("AGENT_OUTPUT_LANGUAGE") || "English";
  } catch {
    /* tests / boot without config service */
  }
  return `lang=${language}|fp=${flags.ignoreFootprintLocks ? 1 : 0}|deps=${flags.ignoreBlockingIssues ? 1 : 0}`;
}
