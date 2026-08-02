import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconArrowLeft,
  IconLoader2,
  IconCheck,
  IconHistory,
  IconUpload,
  IconDownload,
  IconRotate,
  IconTrash,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { JsonEditor } from "@/components/JsonEditor";
import { ModelPicker } from "@/components/ModelPicker";
import { McpServersEditor, normalizeMcpServersJson } from "@/components/McpServersEditor";
import { StickySaveBar } from "@/components/StickySaveBar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageError, PageSkeleton } from "@/components/PageStates";
import { RoleBadge } from "@/components/RoleBadge";
import { useBeforeUnload } from "@/hooks/useBeforeUnload";
import { agentsApi, ApiError, type AgentVersion, type AgentHarnessConfig, type AgentDetail } from "@/lib/api";
import { diffLines } from "@/lib/diff";
import { formatDateTime, harnessLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

function DiffView({ from, to }: { from: string; to: string }) {
  const ops = useMemo(() => diffLines(from, to), [from, to]);
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
      {ops.map((op, i) => (
        <div
          key={i}
          className={cn(
            op.type === "add" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
            op.type === "remove" && "bg-red-500/15 text-red-700 dark:text-red-400"
          )}
        >
          {op.type === "add" ? "+ " : op.type === "remove" ? "- " : "  "}
          {op.line}
        </div>
      ))}
    </pre>
  );
}

function IdentitySection({ data }: { data: AgentDetail }) {
  const qc = useQueryClient();
  const [name, setName] = useState(data.agent.name);
  const [description, setDescription] = useState(data.agent.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    setName(data.agent.name);
    setDescription(data.agent.description ?? "");
  }, [data.agent.name, data.agent.description, data.agent.updatedAt]);

  const dirty = name !== data.agent.name || description !== (data.agent.description ?? "");
  useBeforeUnload(dirty);

  const save = useMutation({
    mutationFn: () =>
      agentsApi.updateMeta(data.agent.id, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", data.agent.id] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      setError(null);
      setOk(true);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar");
      setOk(false);
    },
  });

  return (
    <div className={cn("rounded-lg border p-4", dirty && "border-primary/40 bg-accent/20")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="agent-name" className="text-sm font-medium">
            Nome
          </label>
          <Input id="agent-name" value={name} onChange={(e) => { setName(e.target.value); setOk(false); }} />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="agent-desc" className="text-sm font-medium">
            Descrição
          </label>
          <Textarea
            id="agent-desc"
            className="min-h-16"
            value={description}
            onChange={(e) => { setDescription(e.target.value); setOk(false); }}
            placeholder="Para que serve esta configuração"
          />
        </div>
      </div>
      {dirty && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {error && <span className="text-sm text-destructive">{error}</span>}
          {ok && !error && <span className="text-sm text-success">Salvo.</span>}
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setName(data.agent.name);
                setDescription(data.agent.description ?? "");
                setError(null);
                setOk(false);
              }}
            >
              Descartar
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconCheck className="size-4" />}
              Salvar identidade
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SoulTab({
  agentId,
  versions,
  activeVersionId,
}: {
  agentId: string;
  versions: AgentVersion[];
  activeVersionId: string | null;
}) {
  const qc = useQueryClient();
  const active = versions.find((v) => v.id === activeVersionId) ?? versions[0];
  const [draft, setDraft] = useState(active?.soulMarkdown ?? "");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<AgentVersion | null>(null);

  useEffect(() => {
    setDraft(active?.soulMarkdown ?? "");
  }, [active?.id, active?.soulMarkdown]);

  const dirty = draft !== (active?.soulMarkdown ?? "");
  useBeforeUnload(dirty);

  const save = useMutation({
    mutationFn: () =>
      agentsApi.createVersion(agentId, {
        soulMarkdown: draft,
        comment: comment.trim() || "editado pela dashboard",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      setComment("");
      setError(null);
      setOk(true);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar");
      setOk(false);
    },
  });

  const rollback = useMutation({
    mutationFn: (version: AgentVersion) =>
      agentsApi.createVersion(agentId, {
        soulMarkdown: version.soulMarkdown,
        comment: `rollback pra v${version.version}`,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      setRollbackTarget(null);
    },
  });

  const onImport = (file: File) => {
    file.text().then((text) => {
      setDraft(text);
      setComment("importado de arquivo");
      setOk(false);
    });
  };

  const compareVersion = versions.find((v) => v.id === compareId);

  return (
    <div className={cn("flex flex-col gap-3", dirty && "pb-20")}>
      <p className="text-sm text-muted-foreground">
        Instruções de comportamento do agente (markdown). Cada salvamento cria uma nova versão no histórico.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Versão ativa: v{active?.version ?? "–"}</span>
        <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => setShowHistory((s) => !s)}>
          <IconHistory className="size-3.5" aria-hidden />
          Histórico ({versions.length})
        </Button>
        <label className="inline-flex">
          <input
            type="file"
            accept=".md,text/markdown,text/plain"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
          <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" asChild>
            <span>
              <IconUpload className="size-3.5" aria-hidden />
              Importar
            </span>
          </Button>
        </label>
        {active && (
          <a href={agentsApi.exportVersionUrl(agentId, active.id)} download={`v${active.version}.SOUL.md`}>
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" type="button">
              <IconDownload className="size-3.5" aria-hidden />
              Exportar
            </Button>
          </a>
        )}
      </div>

      {showHistory && (
        <Card>
          <CardContent className="flex flex-col gap-1 p-3">
            {versions.map((v) => (
              <div
                key={v.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 py-1.5 text-xs last:border-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={v.id === activeVersionId ? "default" : "outline"} className="text-[10px]">
                    v{v.version}
                  </Badge>
                  <span>{v.comment}</span>
                  <span className="text-muted-foreground">{formatDateTime(v.createdAt)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setCompareId(v.id)}>
                    Comparar com atual
                  </Button>
                  {v.id !== activeVersionId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-[11px]"
                      onClick={() => setRollbackTarget(v)}
                    >
                      <IconRotate className="size-3" aria-hidden />
                      Restaurar
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {compareVersion && active && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Diff: v{compareVersion.version} → v{active.version}
          </p>
          <DiffView from={compareVersion.soulMarkdown} to={active.soulMarkdown} />
        </div>
      )}

      <label htmlFor="soul-editor" className="sr-only">
        Instruções do agente
      </label>
      <Textarea
        id="soul-editor"
        className="h-[28rem] font-mono text-xs"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOk(false);
        }}
      />

      {dirty && (
        <div className="flex flex-col gap-1">
          <label htmlFor="soul-comment" className="text-xs font-medium text-muted-foreground">
            Comentário da versão
          </label>
          <Input
            id="soul-comment"
            placeholder="O que mudou nesta versão? (obrigatório)"
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              setError(null);
            }}
          />
        </div>
      )}

      <StickySaveBar
        dirtyCount={dirty ? 1 : 0}
        discardLabel="Descartar"
        saveLabel="Salvar nova versão"
        saving={save.isPending}
        error={error || (dirty && !comment.trim() ? "Informe um comentário do que mudou" : null)}
        success={ok}
        onDiscard={() => {
          setDraft(active?.soulMarkdown ?? "");
          setComment("");
          setError(null);
          setOk(false);
        }}
        onSave={() => {
          if (!comment.trim()) {
            setError("Informe um comentário do que mudou");
            return;
          }
          save.mutate();
        }}
      />

      <ConfirmDialog
        open={!!rollbackTarget}
        onOpenChange={(o) => !o && setRollbackTarget(null)}
        title="Restaurar versão anterior?"
        description={
          rollbackTarget
            ? `Isso cria uma nova versão com o conteúdo de v${rollbackTarget.version}. A versão atual permanece no histórico.`
            : ""
        }
        confirmLabel="Restaurar"
        pending={rollback.isPending}
        onConfirm={() => rollbackTarget && rollback.mutate(rollbackTarget)}
      />
    </div>
  );
}

function knownSettingsForm(
  harnessId: string,
  settingsJson: string,
  onChange: (json: string) => void
): ReactNode {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(settingsJson || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }

  const set = (key: string, value: string) => {
    const next = { ...obj };
    if (value === "") delete next[key];
    else next[key] = value;
    onChange(JSON.stringify(next, null, 2));
  };

  if (harnessId === "goose") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="gs-provider">
            Provider
          </label>
          <Input
            id="gs-provider"
            className="h-9"
            value={String(obj.provider ?? "")}
            placeholder="openrouter"
            onChange={(e) => set("provider", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="gs-base">
            Base URL
          </label>
          <Input
            id="gs-base"
            className="h-9 font-mono text-xs"
            value={String(obj.baseUrl ?? "")}
            onChange={(e) => set("baseUrl", e.target.value)}
          />
        </div>
      </div>
    );
  }

  if (harnessId === "hermes") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="hm-url">
            URL da API
          </label>
          <Input
            id="hm-url"
            className="h-9 font-mono text-xs"
            value={String(obj.baseUrl ?? obj.url ?? "")}
            onChange={(e) => set("baseUrl", e.target.value)}
          />
        </div>
      </div>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      Sem formulário específico para {harnessLabel(harnessId)}. Use o JSON avançado se precisar de parâmetros extras.
    </p>
  );
}

function HarnessTab({
  agentId,
  activeHarnessId,
  harnessConfigs,
  harnessIds,
}: {
  agentId: string;
  activeHarnessId: string;
  harnessConfigs: AgentHarnessConfig[];
  harnessIds: string[];
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(activeHarnessId);
  const config = harnessConfigs.find((c) => c.harnessId === selected);
  const [model, setModel] = useState(config?.model ?? "");
  const [settingsJson, setSettingsJson] = useState(config?.settingsJson ?? "{}");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const baselineModel = config?.model ?? "";
  const baselineSettings = config?.settingsJson ?? "{}";
  const dirty = model !== baselineModel || settingsJson !== baselineSettings;
  useBeforeUnload(dirty);

  const setActive = useMutation({
    mutationFn: () => agentsApi.activateHarness(agentId, selected),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      setConfirmActivate(false);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      agentsApi.updateHarnessConfig(agentId, selected, {
        model: model || null,
        settingsJson,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      setError(null);
      setOk(true);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar");
      setOk(false);
    },
  });
  const del = useMutation({
    mutationFn: () => agentsApi.deleteHarnessConfig(agentId, selected),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      setConfirmDelete(false);
      setModel("");
      setSettingsJson("{}");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Falha ao apagar"),
  });

  const onSelectHarness = (value: string) => {
    if (dirty && !window.confirm("Há alterações não salvas neste harness. Trocar mesmo assim?")) return;
    setSelected(value);
    const cfg = harnessConfigs.find((c) => c.harnessId === value);
    setModel(cfg?.model ?? "");
    setSettingsJson(cfg?.settingsJson ?? "{}");
    setOk(false);
    setError(null);
  };

  return (
    <div className={cn("flex flex-col gap-3", dirty && "pb-20")}>
      <p className="text-sm text-muted-foreground">
        Escolha a ferramenta de execução e o modelo. Cada ferramenta guarda a própria configuração mesmo quando não está ativa.
      </p>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Ferramenta de execução">
        {harnessIds.map((id) => {
          const configured = harnessConfigs.some((c) => c.harnessId === id);
          return (
            <Button
              key={id}
              size="sm"
              role="radio"
              aria-checked={selected === id}
              variant={selected === id ? "default" : configured ? "outline" : "ghost"}
              className="h-8 text-xs"
              onClick={() => onSelectHarness(id)}
            >
              {harnessLabel(id)}
              {id === activeHarnessId && (
                <Badge variant="secondary" className="ml-1 text-[9px]">
                  ativa
                </Badge>
              )}
            </Button>
          );
        })}
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-semibold">{harnessLabel(selected)}</h3>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Modelo</span>
            <ModelPicker
              harnessId={selected}
              value={model}
              onChange={(v) => {
                setModel(v);
                setOk(false);
              }}
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Parâmetros</span>
            {knownSettingsForm(selected, settingsJson, (j) => {
              setSettingsJson(j);
              setOk(false);
            })}
            <button
              type="button"
              className="flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setAdvanced((a) => !a)}
              aria-expanded={advanced}
            >
              {advanced ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
              JSON avançado
            </button>
            {advanced && (
              <JsonEditor
                value={settingsJson}
                onChange={(v) => {
                  setSettingsJson(v);
                  setOk(false);
                }}
                minHeightClass="min-h-32"
              />
            )}
          </div>

          <div className="flex flex-wrap gap-2 border-t pt-3">
            {selected !== activeHarnessId && (
              <Button size="sm" variant="outline" onClick={() => setConfirmActivate(true)} disabled={setActive.isPending}>
                Usar esta ferramenta
              </Button>
            )}
            {selected !== activeHarnessId && config && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <IconTrash className="size-3.5" aria-hidden />
                Apagar configuração
              </Button>
            )}
          </div>
        </div>
      </div>

      <StickySaveBar
        dirtyCount={dirty ? 1 : 0}
        onDiscard={() => {
          setModel(baselineModel);
          setSettingsJson(baselineSettings);
          setError(null);
          setOk(false);
        }}
        onSave={() => save.mutate()}
        saving={save.isPending}
        error={error}
        success={ok}
        saveLabel="Salvar execução"
      />

      <ConfirmDialog
        open={confirmActivate}
        onOpenChange={setConfirmActivate}
        title="Trocar ferramenta ativa?"
        description={`Os próximos despachos deste agente usarão ${harnessLabel(selected)}. A configuração das outras ferramentas é preservada.`}
        confirmLabel="Usar esta ferramenta"
        pending={setActive.isPending}
        onConfirm={() => setActive.mutate()}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Apagar configuração?"
        description={`Remove modelo, parâmetros e MCPs salvos para ${harnessLabel(selected)} neste agente.`}
        confirmLabel="Apagar"
        variant="destructive"
        pending={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}

function McpsTab({
  agentId,
  harnessId,
  config,
}: {
  agentId: string;
  harnessId: string;
  config: AgentHarnessConfig | undefined;
}) {
  const qc = useQueryClient();
  const [json, setJson] = useState(config?.mcpServersJson ?? "[]");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    setJson(config?.mcpServersJson ?? "[]");
  }, [config?.mcpServersJson, harnessId]);

  const dirty = json !== (config?.mcpServersJson ?? "[]");
  useBeforeUnload(dirty);

  const save = useMutation({
    mutationFn: () =>
      agentsApi.updateHarnessConfig(agentId, harnessId, {
        mcpServersJson: normalizeMcpServersJson(json),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      setError(null);
      setOk(true);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar");
      setOk(false);
    },
  });

  return (
    <div className={cn("flex flex-col gap-3", dirty && "pb-20")}>
      <p className="text-xs text-muted-foreground">
        Integrações da ferramenta ativa ({harnessLabel(harnessId)}).
      </p>
      <McpServersEditor
        value={json}
        onChange={(v) => {
          setJson(v);
          setOk(false);
        }}
      />
      <StickySaveBar
        dirtyCount={dirty ? 1 : 0}
        onDiscard={() => {
          setJson(config?.mcpServersJson ?? "[]");
          setError(null);
          setOk(false);
        }}
        onSave={() => save.mutate()}
        saving={save.isPending}
        error={error}
        success={ok}
        saveLabel="Salvar integrações"
      />
    </div>
  );
}

export function AgentEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => agentsApi.get(id!),
    enabled: !!id,
  });

  if (isLoading) return <PageSkeleton rows={6} />;
  if (isError || !data) {
    return <PageError message="Agente não encontrado." onRetry={() => refetch()} />;
  }

  const activeHarnessConfig = data.harnessConfigs.find((c) => c.harnessId === data.agent.activeHarnessId);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" className="h-8 gap-1 px-2" onClick={() => navigate("/agents")}>
          <IconArrowLeft className="size-4" aria-hidden />
          Agents
        </Button>
        <RoleBadge role={data.agent.role} />
        {data.agent.isActive ? (
          <Badge variant="default">Ativa</Badge>
        ) : (
          <Badge variant="outline">Inativa</Badge>
        )}
        <Badge variant="secondary">{harnessLabel(data.agent.activeHarnessId)}</Badge>
      </div>

      <IdentitySection data={data} />

      <Tabs defaultValue="soul">
        <TabsList>
          <TabsTrigger value="soul">Comportamento</TabsTrigger>
          <TabsTrigger value="harness">Execução</TabsTrigger>
          <TabsTrigger value="mcps">Integrações</TabsTrigger>
        </TabsList>
        <TabsContent value="soul">
          <SoulTab agentId={data.agent.id} versions={data.versions} activeVersionId={data.agent.activeVersionId} />
        </TabsContent>
        <TabsContent value="harness">
          <HarnessTab
            agentId={data.agent.id}
            activeHarnessId={data.agent.activeHarnessId}
            harnessConfigs={data.harnessConfigs}
            harnessIds={data.harnessIds}
          />
        </TabsContent>
        <TabsContent value="mcps">
          <McpsTab agentId={data.agent.id} harnessId={data.agent.activeHarnessId} config={activeHarnessConfig} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
