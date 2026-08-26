// Quota/rate-limit do PROVIDER por trás de um harness (ex.: Claude Code CLI
// "You've hit your limit · resets 10:10am (America/Sao_Paulo)", JSON-RPC
// -32603). Isto é DIFERENTE do budget interno (§7.4, agent/harness/budget.ts,
// baseado em gasto observado nos `runs`): aqui é o PRÓPRIO provider recusando
// a call porque a conta/assinatura já bateu o teto dele — retry imediato é
// sempre inútil até o reset, então o tratamento é: (1) parar de despachar
// ESSE harness na connection até lá (mesmo padrão do cooldown de rate limit
// do Linear em linear.ts), e (2) devolver a issue à fila IMEDIATAMENTE em vez
// de deixá-la presa "In Progress" até o reclaim por timeout (até 45min).
import { config } from "../../config";
import { log } from "../../logger";
import { activeAgentForRole } from "../../db/agents";
import * as locks from "../../locks";
import type { LinearContext } from "../../db/linearConnections";
import type { SchedulerRole } from "../recipe/defaults";
import type { HarnessId } from "./types";
import { occupiedReopenTarget, reopenOccupiedIssue } from "../../occupied-reclaim";

export interface HarnessQuotaInfo {
  /** Mensagem original do provider (pro comentário no Linear / notificação). */
  message: string;
  /** Epoch ms a partir do qual o harness pode ser despachado de novo. */
  resetAtMs: number;
  /** true = não deu pra parsear um horário de reset; `resetAtMs` é um fallback conservador. */
  resetIsEstimate: boolean;
}

// Frases observadas de "provider recusou por quota/limite da conta" — cobre
// Claude Code (assinatura), Cursor `[resource_exhausted]`, e frases genéricas
// (OpenAI-style `insufficient_quota`, limites diário/semanal/mensal). NÃO
// cobre `rate.?limit`/429/503 (já tratados como TRANSIENT_REJECT em
// acp/client.ts — esses geralmente voltam em segundos, não até um reset fixo).
const QUOTA_PATTERNS: RegExp[] = [
  /you'?ve hit your limit/i,
  /usage limit reached/i,
  /quota exceeded/i,
  /insufficient_quota/i,
  /(?:monthly|weekly|daily) limit reached/i,
  /\[resource_exhausted\]/i,
  /resource.?exhausted/i,
];

// Ex.: "resets 10:10am (America/Sao_Paulo)" ou "resets at 3:45 PM (UTC)".
const RESET_CLOCK_RE = /resets?\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*([ap]m)\s*\(([^)]+)\)/i;

/**
 * Epoch ms (UTC) que, formatado em `timeZone`, mostra exatamente
 * `y-mo-d h:mi:s`. Truque padrão sem lib de timezone: chuta um epoch,
 * formata-o na zona alvo, mede a diferença pro alvo e corrige — converge em
 * 1-2 iterações (a 2ª cobre a borda rara de troca de DST no meio do chute).
 */
function wallTimeInZoneToEpoch(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const shown = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    guess += target - shown;
  }
  return guess;
}

/**
 * (y, mo, d) + 1 dia, como ARITMÉTICA DE CALENDÁRIO pura (não wall-clock):
 * `Date.UTC` normaliza estouro de dia/mês sozinho (ex.: 31/jan + 1 → 1/fev).
 * Nada aqui toca em fuso horário real — é só incremento de data.
 */
function addOneCalendarDay(y: number, mo: number, d: number): { y: number; mo: number; d: number } {
  const dt = new Date(Date.UTC(y, mo - 1, d + 1));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Próxima ocorrência futura (hoje ou amanhã) de `hh:mm` na `timeZone`, relativa a `now`. */
function nextOccurrenceOf(hour24: number, minute: number, timeZone: string, now: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = Object.fromEntries(dtf.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    let y = Number(parts.year);
    let mo = Number(parts.month);
    let d = Number(parts.day);
    let candidate = wallTimeInZoneToEpoch(y, mo, d, hour24, minute, timeZone);
    if (candidate <= now) {
      // Já passou hoje na zona alvo — o reset é amanhã (dia seguinte NA ZONA,
      // não +24h de epoch, que pode cair no dia errado perto de troca de DST).
      ({ y, mo, d } = addOneCalendarDay(y, mo, d));
      candidate = wallTimeInZoneToEpoch(y, mo, d, hour24, minute, timeZone);
    }
    return candidate;
  } catch {
    // Nome de timezone inválido/desconhecido pro Intl — cai no fallback do caller.
    return null;
  }
}

function parseResetClock(message: string, now: number): number | null {
  const m = RESET_CLOCK_RE.exec(message);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const minute = Number(m[2]);
  const timeZone = m[4].trim();
  return nextOccurrenceOf(hour, minute, timeZone, now);
}

/**
 * Reconhece um erro de quota/limite do PROVIDER na mensagem (já normalizada
 * por `errorMessage()` — objeto JSON-RPC vira string). `null` = não é isso
 * (deixa o caller tratar como falha genérica).
 */
export function detectHarnessQuotaError(message: string, now = Date.now()): HarnessQuotaInfo | null {
  if (!QUOTA_PATTERNS.some((re) => re.test(message))) return null;
  const parsed = parseResetClock(message, now);
  if (parsed !== null) return { message, resetAtMs: parsed, resetIsEstimate: false };
  return { message, resetAtMs: now + config.reliability.quotaDefaultCooldownMs, resetIsEstimate: true };
}

/**
 * Same destinations as reclaimStale() inactivity timeouts — reused for
 * quota and generic harness-failure reopen. Kept as `quotaReopenTarget`
 * so existing tests/callers keep compiling.
 */
export const quotaReopenTarget = occupiedReopenTarget;

/**
 * Gate do scheduler (mesmo padrão de `isActiveHarnessPausedForRole`,
 * agent/harness/budget.ts): o harness ATIVO do papel está em cooldown de
 * quota NESTA connection? Checar ANTES de moveState/acquireLock — depois de
 * moveState já é tarde (a issue já teria sido movida pro estado ocupado).
 * Retorna o `resetAtMs` (pra log/debug) ou `null` se pode despachar.
 */
export async function activeHarnessQuotaCooldownForRole(
  connectionId: string,
  role: SchedulerRole
): Promise<number | null> {
  const active = activeAgentForRole(role);
  if (!active) return null;
  const resetAtMs = await locks.getHarnessQuotaCooldown(connectionId, active.harnessId as HarnessId);
  if (resetAtMs && resetAtMs > Date.now()) return resetAtMs;
  return null;
}

/** Texto humano pro comentário no Linear / notificação. */
export function formatQuotaReset(resetAtMs: number): string {
  return new Date(resetAtMs).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/**
 * Reação a um erro de quota já detectado e classificado (dispatch.ts's
 * catch, chamado com best-effort — falha aqui NUNCA deve mascarar o erro
 * original que já está sendo propagado pelo caller):
 *  1. Seta o cooldown do harness NESTA connection (novos dispatches esperam).
 *  2. Comenta no Linear com a mensagem original do provider + previsão de reset.
 *  3. Devolve a issue pro estado de retrabalho (mesmo destino do reclaim por
 *     timeout) IMEDIATAMENTE — sem isso ela ficaria presa na fase ocupada
 *     (In Progress/etc.) até IN_PROGRESS_TIMEOUT_MS (default 45min) reclamar.
 */
export async function reactToHarnessQuotaError(
  ctx: LinearContext,
  issueId: string,
  harnessId: string,
  info: HarnessQuotaInfo
): Promise<void> {
  await locks.setHarnessQuotaCooldown(ctx.connectionId, harnessId, info.resetAtMs);
  logQuotaCooldownSet(harnessId, ctx.connectionId, info);

  const resetLabel = formatQuotaReset(info.resetAtMs);
  const etaNote = info.resetIsEstimate
    ? `No reset clock from the provider — next attempt after ~${resetLabel} (estimate; see \`HARNESS_QUOTA_DEFAULT_COOLDOWN_MS\`).`
    : `Next attempt from ${resetLabel}.`;

  await reopenOccupiedIssue(
    ctx,
    issueId,
    `🤖 **Orchestrator** · \`yaoe-flow\` · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · Reliability\n\n` +
      `⏳ The harness "${harnessId}" hit the provider usage limit:\n\n> ${info.message}\n\n${etaNote}\n\n` +
      `Returning the issue to the retry queue so the seat is not held until the inactivity timeout. The scheduler resumes after the cooldown.`
  );
}

function logQuotaCooldownSet(harnessId: string, connectionId: string, info: HarnessQuotaInfo): void {
  log.agent.warn(
    { harnessId, connectionId, resetAtMs: info.resetAtMs, resetIsEstimate: info.resetIsEstimate },
    "harness quota cooldown set"
  );
}
