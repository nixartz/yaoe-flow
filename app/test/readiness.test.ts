import { describe, expect, test } from "bun:test";
import { deriveStatus, pickBlockedComment, scoreBlockedComment } from "../src/readiness/status";
import type { ReadinessReason } from "../src/readiness/types";

function r(code: ReadinessReason["code"], detail = ""): ReadinessReason {
  return { code, detail };
}

describe("readiness deriveStatus", () => {
  test("ready quando só ready", () => {
    expect(deriveStatus([r("ready")])).toBe("ready");
  });

  test("waiting_human tem prioridade", () => {
    expect(deriveStatus([r("waiting_human"), r("no_capacity")])).toBe("waiting_human");
  });

  test("regra dura vence capacidade", () => {
    expect(deriveStatus([r("deps_unsatisfied"), r("no_capacity")])).toBe("blocked_by_rule");
  });

  test("estimating antes de capacity", () => {
    expect(deriveStatus([r("estimating_footprint"), r("no_capacity")])).toBe("estimating");
  });

  test("só capacity → waiting_capacity", () => {
    expect(deriveStatus([r("no_capacity")])).toBe("waiting_capacity");
  });
});

describe("readiness pickBlockedComment", () => {
  test("vazio → null", () => {
    expect(pickBlockedComment([])).toBeNull();
  });

  test("prefere circuit breaker a Retry", () => {
    const picked = pickBlockedComment([
      "🤖 **Orchestrator** · Reliability\n\n🔁 Retry 1/3: re-despachando para correção após retrabalho.",
      "🤖 **Orchestrator** · Scope-check\n\n🚧 Arquivos fora do footprint declarado (repo): `- src/x.ts`\n\nMovendo para Reopened.",
      "🤖 **Orchestrator** · Reliability\n\n🛑 Circuit breaker: 3 ciclos de retrabalho sem aprovação. Pausando para decisão humana.",
    ]);
    expect(picked).toContain("Circuit breaker");
    expect(picked).not.toContain("Retry 1/3");
  });

  test("fora do footprint vence Retry quando não há circuit breaker", () => {
    const picked = pickBlockedComment([
      "🔁 Retry 2/3: re-despachando para correção após retrabalho.",
      "🚧 Arquivos fora do footprint declarado (my-repo):\n- `src/foo.ts`",
    ]);
    expect(picked).toMatch(/fora do footprint/i);
  });

  test("score: circuit breaker > scope-check > retry", () => {
    const retry = scoreBlockedComment("Retry 1/3: re-despachando", 0, 3);
    const scope = scoreBlockedComment("Arquivos fora do footprint declarado", 1, 3);
    const cb = scoreBlockedComment("Circuit breaker: 3 ciclos", 2, 3);
    expect(cb).toBeGreaterThan(scope);
    expect(scope).toBeGreaterThan(retry);
  });
});
