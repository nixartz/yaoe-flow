// Extrai apresentação legível de payloads ACP de tool_call (title/kind/rawInput/
// locations/content) — sem mudar o stream da API. O `tool_name` no banco muitas
// vezes É o title cru do ACP (comando inteiro / "MCP: tool"); aqui viramos
// label curta + seções de detalhe (args, resultado, permissão, arquivo).

export type ToolKind =
  | "read"
  | "edit"
  | "write"
  | "delete"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "mcp"
  | "other";

export interface ToolBodySection {
  label: string;
  text: string;
  isCode?: boolean;
}

export interface ToolPresentation {
  kind: ToolKind;
  /** Linha curta na timeline (PT): "Leu foo.tsx L1-44" / "MCP Linear · getIssueById" */
  summary: string;
  /** Verbo em PT pro agrupamento: "Leu", "Editou", "Chamou MCP"… */
  verb: string;
  /** Path/arquivo quando aplicável */
  fileName?: string;
  /** @deprecated prefer sections — mantido pra compat */
  bodyText?: string;
  bodyLabel?: string;
  bodyIsCode?: boolean;
  /** Detalhes ao expandir (permissão, args, resultado, arquivo…) */
  sections: ToolBodySection[];
}

interface AcpPayload {
  title?: string;
  kind?: string;
  toolCallId?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string; line?: number }>;
  content?: unknown;
  path?: string;
  command?: string;
  query?: string;
  pattern?: string;
  file_path?: string;
  target_file?: string;
  filePath?: string;
  _permission?: {
    selectedOptionId?: string;
    blockedLinearShell?: boolean;
  };
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const item = c as { type?: string; text?: string; content?: { type?: string; text?: string } };
    if (typeof item.text === "string") parts.push(item.text);
    else if (item.content && typeof item.content.text === "string") parts.push(item.content.text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

/** Extrai JSON de args embutidos em content ACP (` ```json ... ``` `). */
function extractJsonArgs(content: unknown): string | undefined {
  const text = extractTextFromContent(content);
  if (!text) return undefined;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fence ? fence[1] : text).trim();
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw.length < 2000 ? raw : undefined;
  }
}

function looksLikeCodeOrCommand(s: string): boolean {
  return s.length > 80 || s.includes("\n") || /^[`{[$]/.test(s.trim()) || /\b(function|const|import|export|curl|bash)\b/.test(s);
}

function isGenericMcpTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return t === "mcp: tool" || t === "mcp tool" || t === "tool" || t === "mcp";
}

/**
 * Parse títulos MCP do Cursor/ACP.
 * Aceita só o formato curto `server[-tool]: toolName` (ex.:
 * `linear-linear_getIssueById: linear_getIssueById`, `hindsight-recall: recall`).
 * NÃO usa `indexOf(": ")` solto — scripts shell têm `:` o tempo todo.
 */
export function parseMcpTitle(title: string): { server: string; tool: string } | null {
  if (!title || isGenericMcpTitle(title)) return null;
  // Shell/código longo nunca é label MCP
  if (title.length > 120 || title.includes("\n") || /^[`$]/.test(title.trim())) return null;

  if (/^mcp\b/i.test(title)) {
    const rest = title.replace(/^mcp:?\s*/i, "").trim();
    return rest && rest.length < 80 ? { server: "MCP", tool: rest } : null;
  }

  // server[-anything]: toolName — ambos identificadores curtos
  const m = title.match(/^([a-zA-Z][\w.-]{0,80}):\s+([a-zA-Z_][\w./-]{0,80})$/);
  if (!m) return null;
  const left = m[1];
  const right = m[2];
  let server = left;
  if (left.endsWith(`-${right}`)) {
    server = left.slice(0, -(right.length + 1));
  } else if (left.includes("-")) {
    const first = left.split("-")[0];
    if (left === `${first}-${right}`) server = first;
    else if (left.endsWith(right)) server = left.slice(0, -right.length).replace(/-$/, "") || first;
    else server = first;
  }
  if (!server || server.length > 40) return null;
  return { server: formatServerName(server), tool: formatToolName(right) };
}

function formatServerName(s: string): string {
  const known: Record<string, string> = {
    linear: "Linear",
    hindsight: "Hindsight",
    github: "GitHub",
    gh: "GitHub",
    cursor: "Cursor",
    playwright: "Playwright",
    filesystem: "Filesystem",
  };
  const lower = s.toLowerCase();
  if (known[lower]) return known[lower];
  if (!s) return "MCP";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatToolName(t: string): string {
  return t.replace(/^(linear_|github_|gh_)/i, "");
}

function normalizeKind(raw: string | undefined, title: string, input: Record<string, unknown> | null): ToolKind {
  // Kind ACP explícito tem prioridade (shell execute não vira MCP por acidente)
  const k = (raw ?? "").toLowerCase();
  if (k === "read" || k === "read_file" || k === "view") return "read";
  if (k === "edit" || k === "edit_file" || k === "replace") return "edit";
  if (k === "write" || k === "write_file" || k === "create") return "write";
  if (k === "delete" || k === "remove") return "delete";
  if (k === "search" || k === "grep" || k === "glob" || k === "find") return "search";
  if (k === "execute" || k === "shell" || k === "terminal" || k === "run") return "execute";
  if (k === "think" || k === "thought") return "think";
  if (k === "fetch" || k === "web_fetch" || k === "http") return "fetch";

  if (parseMcpTitle(title) || isGenericMcpTitle(title)) return "mcp";

  const blob = `${title} ${JSON.stringify(input ?? {})}`.toLowerCase();
  if (input?.command || (looksLikeCodeOrCommand(title) && !title.includes("/"))) return "execute";
  if (/\b(read|view|cat)\b/.test(blob) || input?.path || input?.target_file || input?.file_path) {
    if (/\b(edit|write|replace|create)\b/.test(blob)) return "edit";
    if (!/\b(shell|bash|zsh|cmd|execute)\b/.test(blob)) return "read";
  }
  if (/\b(search|grep|glob|find)\b/.test(blob) || input?.pattern || input?.query || input?.glob) return "search";
  if (/\b(shell|bash|zsh|pnpm|npm|bun|curl|git)\b/.test(blob)) return "execute";
  return "other";
}

function pickPath(payload: AcpPayload, input: Record<string, unknown> | null): string | undefined {
  const fromLoc = payload.locations?.find((l) => l.path)?.path;
  if (fromLoc) return fromLoc;
  const candidates = [
    payload.path,
    payload.file_path,
    payload.target_file,
    payload.filePath,
    input?.path,
    input?.file_path,
    input?.target_file,
    input?.filePath,
    input?.file,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  if (payload.title && /^[\w./\\-]+\.\w{1,8}$/.test(payload.title.trim())) return payload.title.trim();
  // Title "Read path/to/file.ts" / "Edited src/foo.ts"
  if (payload.title) {
    const m = payload.title.match(/\b((?:\/|~\/|\.\/)?[\w./\\-]+\.\w{1,12})\b/);
    if (m) return m[1];
  }
  return undefined;
}

/** Quando o Cursor não manda path, tenta inferir do conteúdo (heading / path). */
function hintFromContent(contentText: string | undefined): string | undefined {
  if (!contentText) return undefined;
  const heading = contentText.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 60);
  const pathLine = contentText.match(/^(?:\/\/|#)\s*((?:\/|~\/|\.\/)?[\w./\\-]+\.\w{1,12})\s*$/m);
  if (pathLine) return basename(pathLine[1]);
  return undefined;
}

function lineHint(payload: AcpPayload, input: Record<string, unknown> | null): string {
  const loc = payload.locations?.[0];
  if (loc?.line != null) return ` L${loc.line}`;
  const start = input?.start_line ?? input?.startLine ?? input?.offset;
  const end = input?.end_line ?? input?.endLine ?? input?.limit;
  if (typeof start === "number" && typeof end === "number") return ` L${start}-${Number(start) + Number(end)}`;
  if (typeof start === "number") return ` L${start}`;
  return "";
}

function formatPermission(perm: AcpPayload["_permission"]): string | undefined {
  if (!perm?.selectedOptionId && !perm?.blockedLinearShell) return undefined;
  const id = (perm.selectedOptionId ?? "").toLowerCase();
  let decision = "autorizada";
  if (id.includes("reject") || id.includes("cancel")) decision = "negada";
  else if (id.includes("allow-always") || id.includes("allow_always")) decision = "autorizada (sempre)";
  else if (id.includes("allow")) decision = "autorizada (desta vez)";
  else if (id) decision = id.replace(/_/g, "-");
  const parts = [decision.charAt(0).toUpperCase() + decision.slice(1)];
  if (perm.blockedLinearShell) parts.push("shell→Linear bloqueado (política do orquestrador)");
  return parts.join(" · ");
}

function formatRawOutput(raw: unknown): { text: string; isCode: boolean; label: string } | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    return { text: raw, isCode: looksLikeCodeOrCommand(raw), label: "Resultado" };
  }
  const o = asObj(raw);
  if (!o) {
    try {
      return { text: JSON.stringify(raw, null, 2), isCode: true, label: "Resultado" };
    } catch {
      return undefined;
    }
  }

  if (typeof o.error === "string") {
    return { text: o.error, isCode: false, label: "Erro" };
  }
  if (o.success === true && Object.keys(o).length === 1) {
    return { text: "Sucesso", isCode: false, label: "Resultado" };
  }
  if (o.success === false) {
    const msg = typeof o.message === "string" ? o.message : typeof o.error === "string" ? o.error : "Falha";
    return { text: msg, isCode: false, label: "Erro" };
  }

  if ("stdout" in o || "stderr" in o || "exitCode" in o) {
    const lines: string[] = [];
    if (o.exitCode != null) lines.push(`exit ${o.exitCode}`);
    if (typeof o.stdout === "string" && o.stdout.trim()) lines.push(o.stdout.trimEnd());
    if (typeof o.stderr === "string" && o.stderr.trim()) {
      lines.push(lines.length ? "--- stderr ---" : "");
      lines.push(o.stderr.trimEnd());
    }
    return { text: lines.filter(Boolean).join("\n") || `exit ${o.exitCode ?? "?"}`, isCode: true, label: "Saída" };
  }

  if (typeof o.content === "string") {
    return { text: o.content, isCode: true, label: "Conteúdo" };
  }
  if (typeof o.output === "string") {
    return { text: o.output, isCode: looksLikeCodeOrCommand(o.output), label: "Resultado" };
  }
  if (typeof o.text === "string") {
    return { text: o.text, isCode: false, label: "Resultado" };
  }

  try {
    return { text: JSON.stringify(o, null, 2), isCode: true, label: "Resultado" };
  } catch {
    return undefined;
  }
}

function pushSection(sections: ToolBodySection[], label: string, text: string | undefined, isCode?: boolean) {
  if (!text?.trim()) return;
  sections.push({ label, text, isCode });
}

export function presentTool(toolName: string | null | undefined, payload: unknown): ToolPresentation {
  const p = (asObj(payload) ?? {}) as AcpPayload;
  const input = asObj(p.rawInput) ?? asObj(payload);
  const title = (typeof p.title === "string" && p.title && !isGenericMcpTitle(p.title) ? p.title : null) || toolName || "tool";
  const displayTitle = isGenericMcpTitle(title) && typeof p.title === "string" && !isGenericMcpTitle(p.title) ? p.title : title;
  const kind = normalizeKind(p.kind, displayTitle, input);
  const path = pickPath(p, input);
  const fileName = path ? basename(path) : undefined;
  const contentText = extractTextFromContent(p.content);
  const jsonArgs = extractJsonArgs(p.content);
  const out = formatRawOutput(p.rawOutput);
  const permText = formatPermission(p._permission);
  const sections: ToolBodySection[] = [];

  pushSection(sections, "Permissão", permText, false);

  if (kind === "mcp") {
    const mcp = parseMcpTitle(displayTitle);
    const summary = mcp
      ? `MCP ${mcp.server} · ${mcp.tool}`
      : isGenericMcpTitle(displayTitle)
        ? "Ferramenta MCP"
        : `MCP · ${displayTitle.slice(0, 60)}`;
    pushSection(sections, "Argumentos", jsonArgs ?? (contentText && contentText !== jsonArgs ? contentText : undefined), true);
    if (out) pushSection(sections, out.label, out.text, out.isCode);
    else if (!jsonArgs && !contentText) {
      const rawIn = asObj(p.rawInput);
      if (rawIn && Object.keys(rawIn).length > 0) {
        pushSection(sections, "Argumentos", JSON.stringify(rawIn, null, 2), true);
      }
    }
    return {
      kind: "mcp",
      summary,
      verb: "Chamou MCP",
      sections,
      bodyText: sections[0]?.text,
      bodyLabel: sections[0]?.label,
      bodyIsCode: sections[0]?.isCode,
    };
  }

  switch (kind) {
    case "read": {
      const hint = !path ? hintFromContent(typeof p.rawOutput === "object" ? (asObj(p.rawOutput)?.content as string) : contentText ?? out?.text) : undefined;
      const summary = path
        ? `Leu ${fileName}${lineHint(p, input)}`
        : hint
          ? `Leu arquivo · ${hint}`
          : "Leu arquivo";
      pushSection(sections, "Arquivo", path, false);
      const body = contentText ?? out?.text;
      pushSection(sections, "Conteúdo", body, true);
      return { kind, summary, verb: "Leu", fileName: fileName ?? hint, sections, bodyText: body, bodyLabel: "Conteúdo", bodyIsCode: true };
    }
    case "edit":
    case "write": {
      const summary = path
        ? `${kind === "write" ? "Escreveu" : "Editou"} ${fileName}`
        : kind === "write"
          ? "Escreveu arquivo"
          : "Editou arquivo";
      pushSection(sections, "Arquivo", path, false);
      const body =
        contentText ||
        (typeof input?.contents === "string" ? input.contents : undefined) ||
        (typeof input?.new_string === "string" ? input.new_string : undefined) ||
        out?.text ||
        (looksLikeCodeOrCommand(displayTitle) ? displayTitle : undefined);
      pushSection(sections, "Alterações", body, true);
      if (typeof input?.old_string === "string") pushSection(sections, "Antes", input.old_string, true);
      return {
        kind,
        summary,
        verb: kind === "write" ? "Escreveu" : "Editou",
        fileName,
        sections,
        bodyText: body,
        bodyLabel: "Alterações",
        bodyIsCode: true,
      };
    }
    case "search": {
      const q =
        (typeof input?.pattern === "string" && input.pattern) ||
        (typeof input?.query === "string" && input.query) ||
        (typeof input?.glob === "string" && input.glob) ||
        (displayTitle.length < 80 && !isGenericMcpTitle(displayTitle) ? displayTitle : "…");
      pushSection(sections, "Busca", String(q), false);
      pushSection(sections, "Resultados", contentText ?? out?.text, false);
      return {
        kind,
        summary: `Buscou ${q}`,
        verb: "Buscou",
        sections,
        bodyText: contentText ?? out?.text,
        bodyLabel: "Resultados",
      };
    }
    case "execute": {
      const cmd =
        (typeof input?.command === "string" && input.command) ||
        (typeof p.command === "string" && p.command) ||
        (looksLikeCodeOrCommand(displayTitle) ? displayTitle : undefined);
      pushSection(sections, "Comando", cmd, true);
      if (out) pushSection(sections, out.label, out.text, out.isCode);
      return {
        kind,
        summary: "Executou comando",
        verb: "Executou",
        sections,
        bodyText: cmd ?? out?.text,
        bodyLabel: "Comando",
        bodyIsCode: true,
      };
    }
    case "think":
      pushSection(sections, "Raciocínio", contentText ?? (displayTitle !== "Thought" ? displayTitle : undefined), false);
      return {
        kind,
        summary: "Raciocínio",
        verb: "Pensou",
        sections,
        bodyText: sections[0]?.text,
        bodyLabel: "Raciocínio",
      };
    case "fetch":
      pushSection(sections, "URL", typeof input?.url === "string" ? input.url : undefined, false);
      pushSection(sections, "Resposta", contentText ?? out?.text, false);
      return {
        kind,
        summary: displayTitle.length < 80 ? displayTitle : "Buscou URL",
        verb: "Buscou URL",
        sections,
        bodyText: contentText ?? out?.text,
        bodyLabel: "Resposta",
      };
    default: {
      const longTitle = looksLikeCodeOrCommand(displayTitle);
      pushSection(sections, "Detalhe", longTitle ? displayTitle : undefined, true);
      pushSection(sections, "Argumentos", jsonArgs, true);
      if (out) pushSection(sections, out.label, out.text, out.isCode);
      else if (!longTitle) pushSection(sections, "Dados", contentText, true);
      return {
        kind: "other",
        summary: longTitle ? "Executou ferramenta" : displayTitle.slice(0, 80),
        verb: "Usou ferramenta",
        fileName,
        sections,
        bodyText: sections.map((s) => s.text).join("\n\n") || undefined,
        bodyLabel: sections[0]?.label ?? "Dados",
        bodyIsCode: true,
      };
    }
  }
}

export function toolGroupSummary(tools: { presentation: ToolPresentation }[]): string {
  const counts: Partial<Record<ToolKind, number>> = {};
  for (const t of tools) {
    counts[t.presentation.kind] = (counts[t.presentation.kind] ?? 0) + 1;
  }
  const parts: string[] = [];
  const readN = (counts.read ?? 0) + (counts.fetch ?? 0);
  const editN = (counts.edit ?? 0) + (counts.write ?? 0) + (counts.delete ?? 0);
  if (readN) parts.push(`${readN} ${readN === 1 ? "arquivo" : "arquivos"}`);
  if (counts.search) parts.push(`${counts.search} ${counts.search === 1 ? "busca" : "buscas"}`);
  if (counts.execute) parts.push(`${counts.execute} ${counts.execute === 1 ? "comando" : "comandos"}`);
  if (editN) parts.push(`${editN} ${editN === 1 ? "edição" : "edições"}`);
  if (counts.mcp) parts.push(`${counts.mcp} ${counts.mcp === 1 ? "MCP" : "MCPs"}`);
  const other = (counts.other ?? 0) + (counts.think ?? 0);
  if (other && parts.length === 0) parts.push(`${other} ${other === 1 ? "ação" : "ações"}`);
  else if (other && !readN && !editN && !counts.search && !counts.execute && !counts.mcp) parts.push(`${other} ações`);

  if (parts.length === 0) return `${tools.length} ${tools.length === 1 ? "ação" : "ações"}`;
  if (counts.mcp && !readN && !editN && !counts.execute && !counts.search) return parts.join(", ");
  if (readN && !editN && !counts.execute && !counts.mcp) return `Explorou ${parts.join(", ")}`;
  if (editN && !counts.execute && !counts.mcp) return `Editou ${parts.join(", ")}`;
  if (counts.execute && parts.length === 1) return `Executou ${parts[0]}`;
  return parts.join(", ");
}
