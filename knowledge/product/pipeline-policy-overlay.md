---
type: "Product Knowledge"
title: "Pipeline-policy overlay (stopgap — redo this)"
description: "Hot operator flags that would contradict the SOUL are injected as a per-run overlay at prompt assembly, not baked into agents/*.SOUL.md. This file is the map for replacing that ad-hoc splice with a single assembler."
tags: [souls, protocol, prompt-assembly, config, overlay, refactor]
timestamp: "2026-08-26T00:00:00Z"
---

# Pipeline-policy overlay (stopgap — redo this)

This is **deliberately a stopgap**. The next time a Config flag would tell the *agent* to behave differently from the SOUL/protocol default, do **not** copy-paste another `if (config.x)` into `acpAdapter.ts`. Replace this whole shape with the assembler described under [Target shape](#target-shape).

## Why an overlay and not a SOUL edit

- SOULs + `COMMUNICATION_PROTOCOL.md` describe the **default product** (footprint = privilege ceiling; Linear `blockedBy` is real). `sync-souls` versions that text in the database.
- Flags such as `IGNORE_FOOTPRINT_LOCKS` / `IGNORE_BLOCKING_ISSUES` are **operator exceptions**, hot, default `false`. Baking the exception into `agents/*.SOUL.md` would weaken every install that leaves the flags off, and would require `sync-souls` on every toggle.
- The existing hot-prompt patterns are the model: `{{OUTPUT_LANGUAGE}}` inside `communicationProtocol()`, and dispatch-input lines (`authorizedOrgs:`, `pendingMergeIssues:`). Overlays belong to that family — **enforcement policy for this run** — not to personality text.

Do **not** grow this into a generic “config → rewrite SOUL paragraphs” compiler. Only flags that would otherwise make the **scheduler and the agent contradict each other** (scheduler skips a gate the Reviewer still enforces) earn an overlay.

## What ships today

Module: `app/src/agent/recipe/pipeline-policy.ts`

- `pipelinePolicyOverlay(role, flags?)` — English block, or `""` when both flags are off (zero extra tokens).
- `appendPipelinePolicy(base, role)` — concatenates with the same `\n\n---\n\n` separator adapters already use.
- `recipeAssemblyKey()` — `lang=…|fp=0|1|deps=0|1`; **must** be part of any recipe cache that bakes protocol/overlay at build time.

Role bullets (when the matching flag is on):

| Role | `IGNORE_FOOTPRINT_LOCKS` | `IGNORE_BLOCKING_ISSUES` |
| --- | --- | --- |
| Reviewer | Do not Reopen *solely* for files outside `## Footprint` (still 🛑 bugs/security/§14/wrong repo) | Do not `🙋`+Blocked for unmet Linear deps |
| Dev | Ceiling stays; expect parallel overlap / merge conflicts; do not Block on a colliding lock | Same unmet-deps line |
| PMO | Still declare a tight footprint | Still write `blockedBy`/`blocks` (facts for humans and for when the flag turns off) |
| Orchestrator | Still estimate a tight footprint | Unmet-deps line |

## Call sites today (the split to collapse)

Prompt assembly is **not** one function. Two families:

1. **Goose** (`app/src/agent/recipe/builder.ts` → `buildGooseRecipe`): `instructions = SOUL + protocol + overlay`. Cache key in `app/src/agent/harness/goose.ts` includes `recipeAssemblyKey()` so a Config toggle does not keep serving a stale deeplink.
2. **ACP / native** (`acpAdapter.ts`, `nativeStreamJson.ts`): first-turn text = `appendPipelinePolicy(SOUL) + role brief + user message`. **Protocol is not concatenated here.** `dispatch.ts` currently passes the SOUL only (`HarnessRunInput.systemPrompt`); Goose adds the protocol in the builder; ACP never does. That split is **pre-existing**, not introduced by the overlay. The field comment on `types.ts` points at this map.

Hermes HTTP (`hermes.ts`) sends only `promptText` (user message). It does **not** receive the overlay (known degradation; fire-and-report).

`buildSystemPrompt` in `builder.ts` concatenates SOUL + protocol + overlay + role brief — intended for non-Goose system prompts, but ACP adapters do not call it yet.

## Target shape (the redo)

One assembler, one call site:

```
dispatch.ts
  systemPrompt = assembleAgentInstructions({ soul, role })
                // SOUL + protocol + overlays (only those whose flags are on)

adapters
  must NOT append protocol or overlays again
  Goose recipe.instructions = input.systemPrompt
  ACP first turn     = input.systemPrompt + role brief + user message
```

Rules for the redo:

1. **SOUL/protocol stay the default.** Overlays are omitted when flags are off.
2. **Hot.** Assembly reads config getters per dispatch (same as `{{OUTPUT_LANGUAGE}}`). Any recipe cache keys on `recipeAssemblyKey()` (language + every overlay flag).
3. **Role-specific.** A Reviewer bullet must not leak into Dev.
4. **No SOUL compiler.** New overlay = new flag that would make scheduler vs agent disagree, plus a bullet in `pipelinePolicyOverlay`, plus a test in `app/test/pipeline-policy.test.ts`.
5. **ACP gets the protocol** as part of the assembler (fixes the documented-but-missing concatenation) — that is a prompt-size change; treat it as its own verification, not a silent side effect of adding the third overlay.

### Redo checklist (file by file)

Do this as its own change, not as a drive-by while adding a third flag. Until it lands, new enforcement flags still go next to `pipelinePolicyOverlay` / `appendPipelinePolicy` at the two families above, and `recipeAssemblyKey` must grow a bit.

1. **Assembler.** Introduce `assembleAgentInstructions({ soul, role })` (same module or a sibling of `pipeline-policy.ts`) = `SOUL + --- + protocol + (optional overlay)`. `appendPipelinePolicy` becomes an internal helper. `buildGooseRecipe` and `buildSystemPrompt` become thin wrappers over that function.
2. **`dispatch.ts`.** Set `systemPrompt: assembleAgentInstructions({ soul: resolution.soulMarkdown, role })` instead of passing the SOUL raw. Comment at that assignment today points here.
3. **Goose (`builder.ts` + `goose.ts`).** `recipe.instructions = input.systemPrompt` (already assembled). Do **not** concatenate protocol again. Keep `recipeAssemblyKey()` in `cachedGooseRecipe`'s key — a Config toggle must still miss the cache.
4. **ACP / native (`acpAdapter.ts`, `nativeStreamJson.ts`).** Stop calling `appendPipelinePolicy`. First turn = `input.systemPrompt + role brief + user message`. After this step the protocol **will** appear on ACP (it does not today) — budget tokens and run a real ACP smoke, not only unit tests.
5. **`HarnessRunInput.systemPrompt`.** Update the field comment to match the new contract (assembled instructions, adapters must not re-append protocol/overlay).
6. **Hermes (`hermes.ts`).** Still sends only `promptText`. Overlays will keep missing this harness unless `dispatch.ts` adds a compact `pipelinePolicy:` line to the user message (preferred over teaching Hermes a system prompt). Accepting the gap is valid; document it in the same OKF bundle.
7. **Tests.** Assert protocol appears **once** in Goose `instructions` and in the ACP first-turn fixture; overlay appears **once** when a flag is on and is absent when both are off; `recipeAssemblyKey` still changes with each flag. Keep the role-bullet matrix in `app/test/pipeline-policy.test.ts`.
8. **Do not** rewrite `agents/*.SOUL.md` or `COMMUNICATION_PROTOCOL.md` as part of the assembler move.

## Tests

`app/test/pipeline-policy.test.ts` — empty when flags off; independence of the two flags; Reviewer vs Dev vs PMO bullets; `worker` alias maps to Dev; `recipeAssemblyKey` encodes `fp`/`deps`.
