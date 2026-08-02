import { useMemo, useState } from "react";
import { IconPlus, IconTrash, IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JsonEditor } from "@/components/JsonEditor";
import {
  KeyValueEditor,
  StringListEditor,
  compactStringList,
  compactRecord,
} from "@/components/KeyValueEditor";

export type McpDraft =
  | { type: "builtin"; name: string }
  | {
      type: "stdio";
      name: string;
      cmd: string;
      args: string[];
      envKeys?: string[];
      envs?: Record<string, string>;
      timeout?: number;
    }
  | {
      type: "streamable_http";
      name: string;
      uri: string;
      headers?: Record<string, string>;
      timeout?: number;
    };

function parseMcps(json: string): { ok: true; items: McpDraft[] } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return { ok: false, error: "O JSON deve ser um array." };
    return { ok: true, items: parsed as McpDraft[] };
  } catch {
    return { ok: false, error: "JSON inválido." };
  }
}

function normalizeForSave(item: McpDraft): McpDraft {
  if (item.type === "builtin") return { type: "builtin", name: item.name.trim() || "developer" };
  if (item.type === "stdio") {
    const out: Extract<McpDraft, { type: "stdio" }> = {
      type: "stdio",
      name: item.name,
      cmd: item.cmd,
      args: compactStringList(item.args ?? []),
    };
    const keys = compactStringList(item.envKeys ?? []);
    if (keys.length) out.envKeys = keys;
    const envs = compactRecord(item.envs);
    if (envs) out.envs = envs;
    if (item.timeout != null && Number.isFinite(item.timeout) && item.timeout > 0) out.timeout = item.timeout;
    return out;
  }
  const out: Extract<McpDraft, { type: "streamable_http" }> = {
    type: "streamable_http",
    name: item.name,
    uri: item.uri,
  };
  const headers = compactRecord(item.headers);
  if (headers) out.headers = headers;
  if (item.timeout != null && Number.isFinite(item.timeout) && item.timeout > 0) out.timeout = item.timeout;
  return out;
}

function serializeMcps(items: McpDraft[]): string {
  return JSON.stringify(items.map(normalizeForSave), null, 2);
}

/** Compacta listas/records vazios antes de enviar à API. */
export function normalizeMcpServersJson(json: string): string {
  const parsed = parseMcps(json);
  if (!parsed.ok) return json;
  return serializeMcps(parsed.items);
}

const TYPE_LABEL: Record<McpDraft["type"], string> = {
  builtin: "Integrado",
  stdio: "Processo (stdio)",
  streamable_http: "HTTP",
};

// Presets prontos — espelham as configs conhecidas-boas dos agentes default
// (app/src/agent/recipe/defaults.ts e o wiring do Hindsight no builder).
// Segredos entram por NOME de variável (envKeys/placeholder) — nunca o valor.
interface McpPreset {
  id: string;
  label: string;
  description: string;
  make: () => McpDraft;
}

const MCP_PRESETS: McpPreset[] = [
  {
    id: "linear",
    label: "Linear",
    description: "Issues/comentários via @tacticlaunch/mcp-linear (LINEAR_API_TOKEN do run).",
    make: () => ({
      type: "stdio",
      name: "linear",
      cmd: "npx",
      args: ["-y", "@tacticlaunch/mcp-linear"],
      timeout: 300,
      envKeys: ["LINEAR_API_TOKEN"],
    }),
  },
  {
    id: "github",
    label: "GitHub (leitura/escrita)",
    description: "repos + pull_requests via github-mcp-server (GITHUB_PERSONAL_ACCESS_TOKEN).",
    make: () => ({
      type: "stdio",
      name: "github",
      cmd: "github-mcp-server",
      args: ["stdio"],
      timeout: 300,
      envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      envs: { GITHUB_TOOLSETS: "repos,pull_requests" },
    }),
  },
  {
    id: "github-ro",
    label: "GitHub (somente leitura)",
    description: "Só repos, com GITHUB_READ_ONLY=1 — ideal pra PMO/planejamento.",
    make: () => ({
      type: "stdio",
      name: "github",
      cmd: "github-mcp-server",
      args: ["stdio"],
      timeout: 300,
      envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      envs: { GITHUB_TOOLSETS: "repos", GITHUB_READ_ONLY: "1" },
    }),
  },
  {
    id: "developer",
    label: "Developer (integrado)",
    description: "Shell/arquivos/git do próprio harness (extension builtin).",
    make: () => ({ type: "builtin", name: "developer" }),
  },
  {
    id: "hindsight",
    label: "Hindsight (memória)",
    description: "Memória de agente via HTTP — Authorization resolvida de HINDSIGHT_API_KEY.",
    make: () => ({
      type: "streamable_http",
      name: "hindsight",
      uri: "http://hindsight:8888/mcp/orchestrator/",
      headers: { Authorization: "Bearer ${HINDSIGHT_API_KEY}" },
      timeout: 60,
    }),
  },
  {
    id: "custom",
    label: "Custom…",
    description: "Configuração manual: tipo, comando/URL, headers, envs.",
    make: () => ({ type: "stdio", name: "", cmd: "", args: [], envKeys: [], envs: {} }),
  },
];

function McpCard({
  item,
  index,
  onChange,
  onRemove,
}: {
  item: McpDraft;
  index: number;
  onChange: (next: McpDraft) => void;
  onRemove: () => void;
}) {
  const id = `mcp-${index}`;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{TYPE_LABEL[item.type]}</Badge>
        <span className="text-sm font-medium">{item.name || "Sem nome"}</span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 gap-1 text-destructive" onClick={onRemove}>
          <IconTrash className="size-3.5" aria-hidden />
          Remover
        </Button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-type`} className="text-xs font-medium text-muted-foreground">
            Tipo
          </label>
          <Select
            value={item.type}
            onValueChange={(t) => {
              if (t === "builtin") onChange({ type: "builtin", name: item.name || "developer" });
              else if (t === "stdio")
                onChange({
                  type: "stdio",
                  name: item.name || "",
                  cmd: "npx",
                  args: [],
                  envKeys: [],
                  envs: {},
                });
              else onChange({ type: "streamable_http", name: item.name || "", uri: "", headers: {} });
            }}
          >
            <SelectTrigger id={`${id}-type`} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="builtin">Integrado</SelectItem>
              <SelectItem value="stdio">Processo (stdio)</SelectItem>
              <SelectItem value="streamable_http">HTTP</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-xs font-medium text-muted-foreground">
            Nome
          </label>
          <Input
            id={`${id}-name`}
            className="h-9"
            value={item.name}
            onChange={(e) => onChange({ ...item, name: e.target.value })}
          />
        </div>

        {item.type === "stdio" && (
          <>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor={`${id}-cmd`} className="text-xs font-medium text-muted-foreground">
                Comando
              </label>
              <Input
                id={`${id}-cmd`}
                className="h-9 font-mono text-xs"
                value={item.cmd}
                onChange={(e) => onChange({ ...item, cmd: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor={`${id}-args`} className="text-xs font-medium text-muted-foreground">
                Argumentos (um por linha)
              </label>
              <StringListEditor
                id={`${id}-args`}
                value={item.args ?? []}
                onChange={(args) => onChange({ ...item, args })}
                placeholder={"-y\n@tacticlaunch/mcp-linear"}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor={`${id}-envKeys`} className="text-xs font-medium text-muted-foreground">
                Nomes de variáveis de ambiente (envKeys) — um por linha
              </label>
              <p className="text-[11px] text-muted-foreground">
                Nomes resolvidos do ambiente em runtime (ex.: LINEAR_API_TOKEN). Não coloque o valor secreto aqui.
              </p>
              <StringListEditor
                id={`${id}-envKeys`}
                value={item.envKeys ?? []}
                onChange={(envKeys) => onChange({ ...item, envKeys })}
                placeholder={"LINEAR_API_TOKEN\nGITHUB_PERSONAL_ACCESS_TOKEN"}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Valores fixos (envs)</span>
              <p className="text-[11px] text-muted-foreground">
                Pares chave/valor injetados no processo (ex.: GITHUB_TOOLSETS). Sem segredos.
              </p>
              <KeyValueEditor
                idPrefix={`${id}-envs`}
                value={item.envs ?? {}}
                onChange={(envs) => onChange({ ...item, envs })}
                keyPlaceholder="CHAVE"
                valuePlaceholder="valor"
                addLabel="Adicionar variável"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-timeout`} className="text-xs font-medium text-muted-foreground">
                Timeout (segundos)
              </label>
              <Input
                id={`${id}-timeout`}
                type="number"
                min={0}
                className="h-9 w-32"
                value={item.timeout ?? ""}
                placeholder="opcional"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    const { timeout: _t, ...rest } = item;
                    onChange(rest as typeof item);
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n)) return;
                  onChange({ ...item, timeout: n });
                }}
              />
            </div>
          </>
        )}

        {item.type === "streamable_http" && (
          <>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor={`${id}-uri`} className="text-xs font-medium text-muted-foreground">
                URL
              </label>
              <Input
                id={`${id}-uri`}
                className="h-9 font-mono text-xs"
                value={item.uri}
                onChange={(e) => onChange({ ...item, uri: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Headers HTTP</span>
              <p className="text-[11px] text-muted-foreground">
                Cabeçalhos enviados na requisição (Authorization, etc.). Prefira referências a env quando possível.
              </p>
              <KeyValueEditor
                idPrefix={`${id}-headers`}
                value={item.headers ?? {}}
                onChange={(headers) => onChange({ ...item, headers })}
                keyPlaceholder="Header-Name"
                valuePlaceholder="valor"
                addLabel="Adicionar header"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-http-timeout`} className="text-xs font-medium text-muted-foreground">
                Timeout (segundos)
              </label>
              <Input
                id={`${id}-http-timeout`}
                type="number"
                min={0}
                className="h-9 w-32"
                value={item.timeout ?? ""}
                placeholder="opcional"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    const { timeout: _t, ...rest } = item;
                    onChange(rest as typeof item);
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n)) return;
                  onChange({ ...item, timeout: n });
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function McpServersEditor({
  value,
  onChange,
}: {
  /** JSON string (mcpServersJson). */
  value: string;
  onChange: (json: string) => void;
}) {
  const parsed = useMemo(() => parseMcps(value), [value]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedError, setAdvancedError] = useState<string | null>(null);

  const items = parsed.ok ? parsed.items : [];

  const updateItems = (next: McpDraft[]) => {
    onChange(serializeMcps(next));
    setAdvancedError(null);
  };

  /** Atualiza um item sem compactar (mantém linhas vazias enquanto edita). */
  const patchItem = (index: number, next: McpDraft) => {
    const copy = [...items];
    copy[index] = next;
    onChange(JSON.stringify(copy, null, 2));
    setAdvancedError(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Integrações que este agente usa neste harness (Linear, GitHub, etc.). Segredos entram só pelo nome da variável —
        nunca são gravados aqui.
      </p>

      {!parsed.ok && (
        <p className="text-sm text-destructive" role="alert">
          {parsed.error} Use o JSON avançado para corrigir.
        </p>
      )}

      {parsed.ok && (
        <div className="flex flex-col gap-2">
          {items.length === 0 && (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Nenhuma integração configurada. Adicione Linear, GitHub ou um servidor customizado.
            </p>
          )}
          {items.map((item, i) => (
            <McpCard
              key={i}
              item={item}
              index={i}
              onChange={(next) => patchItem(i, next)}
              onRemove={() => updateItems(items.filter((_, j) => j !== i))}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value=""
              onValueChange={(id) => {
                const preset = MCP_PRESETS.find((p) => p.id === id);
                if (preset) updateItems([...items, preset.make()]);
              }}
            >
              <SelectTrigger className="h-9 w-64" aria-label="Adicionar integração">
                <span className="flex items-center gap-1 text-sm">
                  <IconPlus className="size-3.5" aria-hidden />
                  Adicionar integração…
                </span>
              </SelectTrigger>
              <SelectContent>
                {MCP_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <div className="flex flex-col">
                      <span>{p.label}</span>
                      <span className="text-[11px] text-muted-foreground">{p.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="border-t pt-2">
        <button
          type="button"
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
          JSON avançado
        </button>
        {advancedOpen && (
          <div className="mt-2 flex flex-col gap-2">
            <JsonEditor
              value={value}
              onChange={(v) => {
                onChange(v);
                const check = parseMcps(v);
                setAdvancedError(check.ok ? null : check.error);
              }}
              minHeightClass="min-h-48"
            />
            {advancedError && (
              <p className="text-sm text-destructive" role="alert">
                {advancedError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
