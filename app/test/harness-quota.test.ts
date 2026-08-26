import { describe, expect, test } from "bun:test";
import { errorMessage } from "../src/logger";
import { detectHarnessQuotaError, quotaReopenTarget } from "../src/agent/harness/quota";
import { config } from "../src/config";

// Regressão do bug reportado: Claude Code batendo o limite da assinatura
// ("Internal error: You've hit your limit · resets 10:10am
// (America/Sao_Paulo)", JSON-RPC -32603) não era reportado em lugar nenhum
// (error_message/notificação viravam "[object Object]") nem tratado (a issue
// ficava presa em In Progress até o reclaim por timeout de 45min).
describe("errorMessage (objeto plano do JSON-RPC ACP, não Error)", () => {
  test("Error normal usa .message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  test("objeto plano {code, message} do JSON-RPC vira uma string legível, não '[object Object]'", () => {
    const rpcError = { code: -32603, message: "Internal error: You've hit your limit · resets 10:10am (America/Sao_Paulo)" };
    expect(errorMessage(rpcError)).toBe("Internal error: You've hit your limit · resets 10:10am (America/Sao_Paulo) (code -32603)");
  });

  test("objeto sem message cai em String(e)", () => {
    expect(errorMessage({ foo: "bar" })).toBe("[object Object]");
  });

  test("valores primitivos", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("detectHarnessQuotaError", () => {
  test("mensagem normal (não-quota) retorna null", () => {
    expect(detectHarnessQuotaError("ECONNRESET")).toBeNull();
    expect(detectHarnessQuotaError("502 Bad Gateway")).toBeNull();
  });

  test("reconhece a mensagem real do Claude Code e calcula o próximo reset (HH:MMam na timezone)", () => {
    // "Agora" fixo bem antes das 10:10 em São Paulo (UTC-3 no período sem
    // horário de verão) — o reset deve cair HOJE, não amanhã.
    const now = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z = 09:00 em America/Sao_Paulo
    const info = detectHarnessQuotaError(
      "Internal error: You've hit your limit · resets 10:10am (America/Sao_Paulo)",
      now
    );
    expect(info).not.toBeNull();
    expect(info!.resetIsEstimate).toBe(false);
    expect(info!.resetAtMs).toBeGreaterThan(now);
    // 10:10 em America/Sao_Paulo (UTC-3, sem DST) = 13:10 UTC do mesmo dia.
    expect(new Date(info!.resetAtMs).toISOString()).toBe("2026-01-15T13:10:00.000Z");
  });

  test("horário já passado hoje na timezone → reset rola pro dia seguinte", () => {
    // 2026-01-15T20:00:00Z = 17:00 em America/Sao_Paulo — já passou das 10:10.
    const now = Date.UTC(2026, 0, 15, 20, 0, 0);
    const info = detectHarnessQuotaError("You've hit your limit · resets 10:10am (America/Sao_Paulo)", now);
    expect(info).not.toBeNull();
    expect(new Date(info!.resetAtMs).toISOString()).toBe("2026-01-16T13:10:00.000Z");
  });

  test("horário PM é convertido corretamente (12h → 24h)", () => {
    const now = Date.UTC(2026, 0, 15, 0, 0, 0); // meia-noite UTC = 21:00 do dia 14 em SP
    const info = detectHarnessQuotaError("usage limit reached · resets 3:45pm (America/Sao_Paulo)", now);
    expect(info).not.toBeNull();
    // 15:45 em America/Sao_Paulo = 18:45 UTC, no dia 15 (à frente do `now`).
    expect(new Date(info!.resetAtMs).toISOString()).toBe("2026-01-15T18:45:00.000Z");
  });

  test("12am/12pm (meia-noite/meio-dia) não viram 12h", () => {
    const now = Date.UTC(2026, 0, 15, 1, 0, 0); // 2026-01-14T22:00 em SP
    const info = detectHarnessQuotaError("quota exceeded, resets 12:00am (America/Sao_Paulo)", now);
    expect(info).not.toBeNull();
    // 00:00 em SP (UTC-3) = 03:00 UTC do mesmo dia civil.
    expect(new Date(info!.resetAtMs).toISOString()).toBe("2026-01-15T03:00:00.000Z");
  });

  test("timezone desconhecida do Intl cai no fallback estimado, sem lançar", () => {
    const now = Date.now();
    const info = detectHarnessQuotaError("You've hit your limit · resets 10:10am (Nowhere/Fake)", now);
    expect(info).not.toBeNull();
    expect(info!.resetIsEstimate).toBe(true);
    expect(info!.resetAtMs).toBe(now + config.reliability.quotaDefaultCooldownMs);
  });

  test("sem horário de reset na mensagem cai no cooldown default (estimativa)", () => {
    const now = Date.now();
    const info = detectHarnessQuotaError("insufficient_quota: account balance exhausted", now);
    expect(info).not.toBeNull();
    expect(info!.resetIsEstimate).toBe(true);
    expect(info!.resetAtMs).toBe(now + config.reliability.quotaDefaultCooldownMs);
  });

  test("outras frases de limite/quota reconhecidas (não só Claude)", () => {
    expect(detectHarnessQuotaError("monthly limit reached")).not.toBeNull();
    expect(detectHarnessQuotaError("Error: quota exceeded for this model")).not.toBeNull();
  });

  test("Cursor ACP [resource_exhausted] is quota (cooldown + immediate reopen), not a generic stall", () => {
    const now = Date.now();
    const info = detectHarnessQuotaError("erro de provider persistiu: [resource_exhausted] Error", now);
    expect(info).not.toBeNull();
    expect(info!.resetIsEstimate).toBe(true);
    expect(info!.resetAtMs).toBe(now + config.reliability.quotaDefaultCooldownMs);
    expect(detectHarnessQuotaError("resource exhausted")).not.toBeNull();
  });

  test("Connection stalled is NOT quota — generic dispatch-failure reopen, no harness cooldown", () => {
    expect(detectHarnessQuotaError("erro de provider persistiu: Connection stalled")).toBeNull();
  });
});

describe("quotaReopenTarget (mesmo destino do reclaim por timeout, disparado na hora)", () => {
  test("mapeia cada fase ocupada pro seu reopen — espelha reclaimStale() em scheduler.ts", () => {
    const S = config.states;
    expect(quotaReopenTarget(S.refining)).toBe(S.todo);
    expect(quotaReopenTarget(S.inProgress)).toBe(S.reopened);
    expect(quotaReopenTarget(S.inReview)).toBe(S.codeReview);
    expect(quotaReopenTarget(S.pendingMerge)).toBe(S.reopened);
  });

  test("estado sem reopen conhecido retorna null (caller só comenta, não move)", () => {
    expect(quotaReopenTarget(config.states.completed)).toBeNull();
    expect(quotaReopenTarget(config.states.blocked)).toBeNull();
    expect(quotaReopenTarget("Some Unknown State")).toBeNull();
  });
});
