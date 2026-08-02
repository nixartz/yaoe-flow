// Agrupa run_events numa hierarquia estilo Cursor:
// mensagem → thinking (colapsável) → grupo de tools (colapsável) → cada tool
// (colapsável com corpo legível). Sem mudar o stream da API.
//
// Importante: `session/request_permission` chega como tool_call_update com
// toolCallId em params.toolCall (não no topo). Sem merge por esse id, a
// timeline duplica "MCP: tool" + "linear-…: permissão".
import type { RunEvent } from "./api";
import { presentTool, toolGroupSummary, type ToolPresentation } from "./toolPresent";

export type ToolItem = {
  key: string;
  toolCallId?: string;
  toolName: string | null;
  toolStatus: string | null;
  live: boolean;
  presentation: ToolPresentation;
  payload: unknown;
  startTs: number;
  endTs: number;
};

export type TimelineSegment =
  | {
      type: "user_message" | "agent_message";
      key: string;
      text: string;
      startTs: number;
      endTs: number;
    }
  | {
      type: "thinking";
      key: string;
      text: string;
      startTs: number;
      endTs: number;
      durationLabel: string;
    }
  | {
      type: "tool_group";
      key: string;
      summary: string;
      tools: ToolItem[];
      startTs: number;
      endTs: number;
      anyLive: boolean;
    }
  | {
      type: "plan" | "other";
      key: string;
      label: string;
      text?: string;
      payload?: unknown;
      startTs: number;
      endTs: number;
    };

const SILENT = new Set(["usage_update", "session_info_update"]);

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isGenericToolName(name: string | null | undefined): boolean {
  if (!name) return true;
  const t = name.trim().toLowerCase();
  return t === "mcp: tool" || t === "mcp tool" || t === "tool" || t === "mcp";
}

function preferToolName(incoming: string | null | undefined, existing: string | null | undefined): string | null {
  if (isGenericToolName(incoming) && !isGenericToolName(existing)) return existing ?? null;
  if (!isGenericToolName(incoming)) return incoming ?? null;
  return existing ?? incoming ?? null;
}

function isTerminalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return (
    s === "completed" ||
    s === "success" ||
    s === "done" ||
    s === "failed" ||
    s === "error" ||
    s === "cancelled"
  );
}

function preferStatus(incoming: string | null | undefined, existing: string | null | undefined): string | null {
  // Terminal (completed/failed) sempre vence permissão/pending
  if (incoming && isTerminalStatus(incoming)) return incoming;
  if (existing && isTerminalStatus(existing) && incoming?.toLowerCase().startsWith("permission:")) {
    return existing;
  }
  return incoming ?? existing ?? null;
}

/** toolCallId no topo (ACP) OU em params.toolCall (permission envelope). */
export function toolCallIdOf(payload: unknown): string | undefined {
  const p = asObj(payload);
  if (!p) return undefined;
  if (typeof p.toolCallId === "string" && p.toolCallId) return p.toolCallId;
  const params = asObj(p.params);
  const tc = params ? asObj(params.toolCall) : null;
  if (tc && typeof tc.toolCallId === "string" && tc.toolCallId) return tc.toolCallId;
  return undefined;
}

function isPermissionEnvelope(payload: unknown): boolean {
  const p = asObj(payload);
  return p?.method === "session/request_permission";
}

function enrichFromPermission(existingPayload: unknown, permissionPayload: unknown): Record<string, unknown> {
  const perm = asObj(permissionPayload) ?? {};
  const params = asObj(perm.params);
  const tc = params ? asObj(params.toolCall) : null;
  const base = asObj(existingPayload) ?? {};
  const title =
    (typeof tc?.title === "string" && tc.title && !isGenericToolName(tc.title) ? tc.title : null) ||
    (typeof base.title === "string" && !isGenericToolName(base.title as string) ? (base.title as string) : null) ||
    (typeof tc?.title === "string" ? tc.title : undefined) ||
    base.title;

  return {
    ...base,
    title,
    kind: (typeof tc?.kind === "string" && tc.kind) || base.kind,
    content: tc?.content ?? base.content,
    toolCallId: (typeof tc?.toolCallId === "string" && tc.toolCallId) || base.toolCallId,
    status: (typeof tc?.status === "string" && tc.status) || base.status,
    _permission: {
      selectedOptionId: typeof perm.selectedOptionId === "string" ? perm.selectedOptionId : undefined,
      blockedLinearShell: Boolean(perm.blockedLinearShell) || undefined,
    },
  };
}

function hasUsefulValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function mergeAcpPayload(existing: unknown, update: unknown): Record<string, unknown> {
  const e = asObj(existing) ?? {};
  const u = asObj(update) ?? {};
  const permission = e._permission ?? u._permission;
  const title = preferToolName(
    typeof u.title === "string" ? u.title : null,
    typeof e.title === "string" ? e.title : null
  );

  return {
    ...e,
    ...u,
    title: title ?? u.title ?? e.title,
    content: hasUsefulValue(u.content) ? u.content : e.content,
    rawInput: hasUsefulValue(u.rawInput) ? u.rawInput : e.rawInput,
    rawOutput: u.rawOutput ?? e.rawOutput,
    locations: hasUsefulValue(u.locations) ? u.locations : e.locations,
    kind: u.kind ?? e.kind,
    _permission: permission,
  };
}

function isLiveStatus(status: string | null | undefined, runFinished: boolean): boolean {
  if (runFinished) return false;
  if (!status) return true;
  const s = status.toLowerCase();
  if (isTerminalStatus(s)) return false;
  if (s.startsWith("permission:")) return false;
  return s === "pending" || s === "in_progress" || s === "running" || s === "started";
}

function durationLabel(start: number, end: number): string {
  const ms = Math.max(0, end - start);
  if (ms < 1500) return "brevemente";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function mergeTool(existing: ToolItem, e: RunEvent, payload: unknown, runFinished: boolean): ToolItem {
  const status = preferStatus(e.tool_status, existing.toolStatus);
  let mergedPayload: unknown = existing.payload;
  if (isPermissionEnvelope(payload)) {
    mergedPayload = enrichFromPermission(existing.payload, payload);
  } else if (payload != null) {
    mergedPayload = mergeAcpPayload(existing.payload, payload);
  }
  const toolName = preferToolName(e.tool_name, existing.toolName);
  // Garante que o title no payload reflita o melhor nome (pra presentTool)
  const mergedObj = asObj(mergedPayload);
  if (mergedObj && toolName && !isGenericToolName(toolName)) {
    if (isGenericToolName(typeof mergedObj.title === "string" ? mergedObj.title : null)) {
      mergedPayload = { ...mergedObj, title: toolName };
    }
  }

  return {
    ...existing,
    toolCallId: existing.toolCallId ?? toolCallIdOf(mergedPayload) ?? toolCallIdOf(payload),
    toolName,
    toolStatus: status,
    live: isLiveStatus(status, runFinished),
    payload: mergedPayload,
    presentation: presentTool(toolName, mergedPayload),
    endTs: e.ts,
  };
}

/**
 * @param runFinished — true quando o run não está mais `running` (histórico).
 *   Força tools sem status final a aparecerem como concluídas, sem spinner.
 */
export function groupEvents(events: RunEvent[], runFinished = false): TimelineSegment[] {
  const flat: Array<
    | { kind: "msg"; role: "user" | "agent"; key: string; text: string; startTs: number; endTs: number }
    | { kind: "think"; key: string; text: string; startTs: number; endTs: number }
    | { kind: "tool"; item: ToolItem }
    | { kind: "misc"; type: "plan" | "other"; key: string; label: string; text?: string; payload?: unknown; startTs: number; endTs: number }
  > = [];

  let openMsg: (typeof flat)[number] | null = null;
  let openThink: Extract<(typeof flat)[number], { kind: "think" }> | null = null;
  const openTools = new Map<string, number>(); // id -> index in flat

  const flushMsg = () => {
    if (openMsg) {
      flat.push(openMsg);
      openMsg = null;
    }
  };
  const flushThink = () => {
    if (openThink) {
      flat.push(openThink);
      openThink = null;
    }
  };

  for (const e of events) {
    if (SILENT.has(e.kind)) continue;

    if (e.kind === "agent_message_chunk") {
      flushThink();
      if (openMsg && openMsg.kind === "msg" && openMsg.role === "agent") {
        openMsg.text += e.text ?? "";
        openMsg.endTs = e.ts;
      } else {
        flushMsg();
        openMsg = { kind: "msg", role: "agent", key: `msg-${e.id}`, text: e.text ?? "", startTs: e.ts, endTs: e.ts };
      }
      continue;
    }

    if (e.kind === "user_message") {
      flushThink();
      flushMsg();
      openMsg = {
        kind: "msg",
        role: "user",
        key: `user-${e.id}`,
        text: e.text ?? "",
        startTs: e.ts,
        endTs: e.ts,
      };
      continue;
    }

    if (e.kind === "agent_thought_chunk") {
      flushMsg();
      if (openThink) {
        openThink.text += e.text ?? "";
        openThink.endTs = e.ts;
      } else {
        openThink = { kind: "think", key: `think-${e.id}`, text: e.text ?? "", startTs: e.ts, endTs: e.ts };
      }
      continue;
    }

    if (e.kind === "tool_call" || e.kind === "tool_call_update") {
      flushMsg();
      flushThink();
      const payload = safeParse(e.payload_json);
      const callId = toolCallIdOf(payload) ?? e.tool_name ?? `anon-${e.id}`;
      const existingIdx = openTools.get(callId);
      if (existingIdx != null && flat[existingIdx]?.kind === "tool") {
        const slot = flat[existingIdx] as { kind: "tool"; item: ToolItem };
        slot.item = mergeTool(slot.item, e, payload, runFinished);
        continue;
      }

      // Permission órfã (sem tool_call prévio): materializa a partir do envelope
      let initialPayload = payload;
      let toolName = e.tool_name;
      if (isPermissionEnvelope(payload)) {
        initialPayload = enrichFromPermission({}, payload);
        const tcTitle = asObj(asObj(asObj(payload)?.params)?.toolCall)?.title;
        if (typeof tcTitle === "string") toolName = preferToolName(toolName, tcTitle);
      }

      const item: ToolItem = {
        key: `tool-${e.id}`,
        toolCallId: toolCallIdOf(initialPayload) ?? toolCallIdOf(payload),
        toolName,
        toolStatus: e.tool_status,
        live: isLiveStatus(e.tool_status, runFinished),
        presentation: presentTool(toolName, initialPayload),
        payload: initialPayload,
        startTs: e.ts,
        endTs: e.ts,
      };
      openTools.set(callId, flat.length);
      flat.push({ kind: "tool", item });
      continue;
    }

    flushMsg();
    flushThink();
    if (e.kind === "plan") {
      flat.push({
        kind: "misc",
        type: "plan",
        key: `plan-${e.id}`,
        label: "Plano",
        text: e.text ?? undefined,
        payload: safeParse(e.payload_json),
        startTs: e.ts,
        endTs: e.ts,
      });
      continue;
    }
    flat.push({
      kind: "misc",
      type: "other",
      key: `other-${e.id}`,
      label: e.kind,
      text: e.text ?? undefined,
      payload: safeParse(e.payload_json),
      startTs: e.ts,
      endTs: e.ts,
    });
  }
  flushMsg();
  flushThink();

  const segments: TimelineSegment[] = [];
  let toolBuf: ToolItem[] = [];

  const flushTools = () => {
    if (toolBuf.length === 0) return;
    segments.push({
      type: "tool_group",
      key: `tg-${toolBuf[0].key}`,
      summary: toolGroupSummary(toolBuf),
      tools: toolBuf,
      startTs: toolBuf[0].startTs,
      endTs: toolBuf[toolBuf.length - 1].endTs,
      anyLive: toolBuf.some((t) => t.live),
    });
    toolBuf = [];
  };

  for (const item of flat) {
    if (item.kind === "tool") {
      toolBuf.push(item.item);
      continue;
    }
    flushTools();
    if (item.kind === "msg") {
      segments.push({
        type: item.role === "user" ? "user_message" : "agent_message",
        key: item.key,
        text: item.text,
        startTs: item.startTs,
        endTs: item.endTs,
      });
    } else if (item.kind === "think") {
      segments.push({
        type: "thinking",
        key: item.key,
        text: item.text,
        startTs: item.startTs,
        endTs: item.endTs,
        durationLabel: durationLabel(item.startTs, item.endTs),
      });
    } else {
      segments.push({
        type: item.type,
        key: item.key,
        label: item.label,
        text: item.text,
        payload: item.payload,
        startTs: item.startTs,
        endTs: item.endTs,
      });
    }
  }
  flushTools();
  return segments;
}

/** Compat com imports antigos. */
export type TimelineNode = TimelineSegment;
export type TimelineBlock = TimelineSegment;
