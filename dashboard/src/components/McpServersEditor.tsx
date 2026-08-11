import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconGripVertical, IconPlus, IconTrash } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { JsonEditor } from "@/components/JsonEditor";
import {
  KeyValueEditor,
  StringListEditor,
  compactStringList,
  compactRecord,
} from "@/components/KeyValueEditor";
import { cn } from "@/lib/utils";

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

function mcpSummary(item: McpDraft): string {
  if (item.type === "builtin") return "builtin";
  if (item.type === "stdio") {
    const args = (item.args ?? []).filter(Boolean).join(" ");
    return args ? `${item.cmd} ${args}` : item.cmd || "—";
  }
  return item.uri || "—";
}

function newRowId(): string {
  return crypto.randomUUID();
}

function reconcileRowIds(prev: string[], length: number): string[] {
  if (prev.length === length) return prev;
  if (prev.length < length) {
    return [...prev, ...Array.from({ length: length - prev.length }, () => newRowId())];
  }
  return prev.slice(0, length);
}

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

function McpDetailPanel({
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
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{TYPE_LABEL[item.type]}</Badge>
        <span className="min-w-0 truncate text-sm font-medium">{item.name || "Sem nome"}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-7 shrink-0 gap-1 text-destructive"
          onClick={onRemove}
        >
          <IconTrash className="size-3.5" aria-hidden />
          Remover
        </Button>
      </div>

      <div className="grid gap-3">
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
            <div className="flex flex-col gap-1">
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
            <div className="flex flex-col gap-1">
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
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-envKeys`} className="text-xs font-medium text-muted-foreground">
                Nomes de variáveis de ambiente (envKeys)
              </label>
              <p className="text-[11px] text-muted-foreground">
                Nomes resolvidos em runtime (ex.: LINEAR_API_TOKEN). Não coloque o valor secreto aqui.
              </p>
              <StringListEditor
                id={`${id}-envKeys`}
                value={item.envKeys ?? []}
                onChange={(envKeys) => onChange({ ...item, envKeys })}
                placeholder={"LINEAR_API_TOKEN\nGITHUB_PERSONAL_ACCESS_TOKEN"}
              />
            </div>
            <div className="flex flex-col gap-1">
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
                className="h-9 w-full"
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
            <div className="flex flex-col gap-1">
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
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Headers HTTP</span>
              <p className="text-[11px] text-muted-foreground">
                Cabeçalhos enviados na requisição. Prefira referências a env quando possível.
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
                className="h-9 w-full"
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

function SortableMcpRow({
  id,
  item,
  selected,
  onSelect,
}: {
  id: string;
  item: McpDraft;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <TableRow
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      data-state={selected ? "selected" : undefined}
      className={cn("cursor-pointer", isDragging && "relative z-10 bg-background opacity-80 shadow-sm")}
      onClick={onSelect}
      aria-selected={selected}
    >
      <TableCell className="w-10 px-2">
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Reordenar ${item.name || "integração"}`}
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <IconGripVertical className="size-4" aria-hidden />
        </button>
      </TableCell>
      <TableCell className="max-w-[10rem] truncate font-medium">{item.name || "Sem nome"}</TableCell>
      <TableCell>
        <Badge variant="outline" className="font-normal">
          {TYPE_LABEL[item.type]}
        </Badge>
      </TableCell>
      <TableCell className="hidden max-w-[14rem] truncate font-mono text-xs text-muted-foreground xl:table-cell" title={mcpSummary(item)}>
        {mcpSummary(item)}
      </TableCell>
    </TableRow>
  );
}

function AddIntegrationSelect({ onAdd }: { onAdd: (presetId: string) => void }) {
  return (
    <Select value="" onValueChange={onAdd}>
      <SelectTrigger className="h-9 w-full max-w-64" aria-label="Adicionar integração">
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
  );
}

/** Altura mínima dos 3 painéis — cobre o formulário stdio completo (~660px). */
const MCP_PANEL_MIN_H = "min-h-[660px]";

export function McpServersEditor({
  value,
  onChange,
  selectedId,
  onSelectId,
  rowIds,
  onRowIdsChange,
}: {
  /** JSON string (mcpServersJson). */
  value: string;
  onChange: (json: string) => void;
  /** Controlled row selection — lifted by the caller so it survives e.g. a harness switch (see AgentEditor). */
  selectedId: string | null;
  onSelectId: (id: string | null) => void;
  /**
   * Controlled row ids — also lifted (not just `selectedId`): Radix `Tabs` unmounts inactive
   * `TabsContent` by default, so this component remounts on every tab switch. If `rowIds` stayed
   * component-local, a fresh remount would regenerate random ids and `selectedId` would never
   * match one again, silently resetting the selection despite being "persisted".
   */
  rowIds: string[];
  onRowIdsChange: (ids: string[]) => void;
}) {
  const parsed = useMemo(() => parseMcps(value), [value]);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const items = parsed.ok ? parsed.items : [];

  // Mantém IDs estáveis alinhados ao comprimento da lista (add/remove / JSON avançado).
  const syncedIds = reconcileRowIds(rowIds, items.length);
  if (syncedIds !== rowIds) {
    onRowIdsChange(syncedIds);
  }

  useEffect(() => {
    if (syncedIds.length === 0) {
      if (selectedId !== null) onSelectId(null);
      return;
    }
    if (!selectedId || !syncedIds.includes(selectedId)) onSelectId(syncedIds[0]!);
    // Only re-run when the row id set changes — re-validating `selectedId` here as a dep
    // would fight the controlled prop update this effect itself triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedIds]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const selectedIndex = selectedId ? syncedIds.indexOf(selectedId) : -1;
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  const updateItems = (next: McpDraft[], nextIds?: string[]) => {
    onChange(serializeMcps(next));
    if (nextIds) onRowIdsChange(nextIds);
    setAdvancedError(null);
  };

  /** Atualiza um item sem compactar (mantém linhas vazias enquanto edita). */
  const patchItem = (index: number, next: McpDraft) => {
    const copy = [...items];
    copy[index] = next;
    onChange(JSON.stringify(copy, null, 2));
    setAdvancedError(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = syncedIds.indexOf(String(active.id));
    const newIndex = syncedIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    updateItems(arrayMove(items, oldIndex, newIndex), arrayMove(syncedIds, oldIndex, newIndex));
  };

  const addPreset = (presetId: string) => {
    const preset = MCP_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const id = newRowId();
    updateItems([...items, preset.make()], [...syncedIds, id]);
    onSelectId(id);
  };

  const removeSelected = () => {
    if (selectedIndex < 0) return;
    const nextItems = items.filter((_, j) => j !== selectedIndex);
    const nextIds = syncedIds.filter((_, j) => j !== selectedIndex);
    updateItems(nextItems, nextIds);
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

      <div className="grid gap-3 lg:grid-cols-4">
        {/* Lista — 2/4 */}
        <div className={cn("flex flex-col gap-2 rounded-lg border p-3 lg:col-span-2", MCP_PANEL_MIN_H)}>
          <div className="flex flex-wrap items-center gap-2">
            <AddIntegrationSelect onAdd={addPreset} />
            {parsed.ok && (
              <span className="text-xs text-muted-foreground">
                {items.length === 0
                  ? "Nenhuma integração"
                  : `${items.length} ${items.length === 1 ? "integração" : "integrações"}`}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {!parsed.ok ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
                <p className="text-sm font-medium text-destructive">JSON inválido</p>
                <p className="text-xs text-muted-foreground">Corrija o JSON no painel à direita para listar as integrações.</p>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center">
                <p className="text-sm font-medium">Nenhuma integração configurada</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Adicione Linear, GitHub ou um servidor customizado para começar.
                </p>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={syncedIds} strategy={verticalListSortingStrategy}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10 px-2">
                          <span className="sr-only">Reordenar</span>
                        </TableHead>
                        <TableHead>Nome</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead className="hidden xl:table-cell">Destino</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item, i) => {
                        const id = syncedIds[i];
                        if (!id) return null;
                        return (
                          <SortableMcpRow
                            key={id}
                            id={id}
                            item={item}
                            selected={id === selectedId}
                            onSelect={() => onSelectId(id)}
                          />
                        );
                      })}
                    </TableBody>
                  </Table>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>

        {/* Detalhe — 1/4 */}
        <div className={cn("flex flex-col overflow-hidden rounded-lg border p-3 lg:col-span-1", MCP_PANEL_MIN_H)}>
          {parsed.ok && selectedItem && selectedIndex >= 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <McpDetailPanel
                item={selectedItem}
                index={selectedIndex}
                onChange={(next) => patchItem(selectedIndex, next)}
                onRemove={removeSelected}
              />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center">
              <p className="text-sm font-medium">Sem seleção</p>
              <p className="text-xs text-muted-foreground">
                {parsed.ok
                  ? "Selecione uma integração na tabela para editar os detalhes."
                  : "Corrija o JSON para editar integrações."}
              </p>
            </div>
          )}
        </div>

        {/* JSON — 1/4 */}
        <div className={cn("flex flex-col gap-2 rounded-lg border p-3 lg:col-span-1", MCP_PANEL_MIN_H)}>
          <span className="shrink-0 text-xs font-medium text-muted-foreground">JSON avançado</span>
          <JsonEditor
            className="min-h-0 flex-1"
            value={value}
            onChange={(v) => {
              onChange(v);
              const check = parseMcps(v);
              setAdvancedError(check.ok ? null : check.error);
            }}
            minHeightClass="min-h-[560px] h-full"
          />
          {advancedError && (
            <p className="shrink-0 text-sm text-destructive" role="alert">
              {advancedError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
