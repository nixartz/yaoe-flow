import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRobot, IconPlus, IconCheck, IconPower, IconLoader2, IconCopy, IconPencil } from "@tabler/icons-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { PageHeader } from "@/components/PageHeader";
import { RoleBadge } from "@/components/RoleBadge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SoulSyncButton } from "@/components/SoulSyncButton";
import { agentsApi, ApiError, type Agent, type AgentRole } from "@/lib/api";
import { HARNESS_OPTIONS, harnessLabel, roleLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

async function duplicateAgent(agent: Agent): Promise<Agent> {
  const detail = await agentsApi.get(agent.id);
  const activeVersion = detail.versions.find((v) => v.id === agent.activeVersionId) ?? detail.versions[0];
  const res = await agentsApi.create({
    role: agent.role,
    name: `${agent.name} (cópia)`,
    description: agent.description,
    soulMarkdown: activeVersion?.soulMarkdown ?? "",
    comment: `duplicado de "${agent.name}"`,
    harnessId: agent.activeHarnessId,
    activate: false,
  });
  return res.agent;
}

function CreateAgentSheet({
  open,
  onOpenChange,
  roles,
  defaultRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: AgentRole[];
  defaultRole: AgentRole;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [role, setRole] = useState<AgentRole>(defaultRole);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [soul, setSoul] = useState("");
  const [harnessId, setHarnessId] = useState<string>(HARNESS_OPTIONS[0].value);
  const [activate, setActivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setRole(defaultRole);
    setName("");
    setDescription("");
    setSoul("");
    setHarnessId(HARNESS_OPTIONS[0].value);
    setActivate(false);
    setError(null);
  };

  const create = useMutation({
    mutationFn: () =>
      agentsApi.create({
        role,
        name: name.trim(),
        description: description.trim() || null,
        soulMarkdown: soul,
        comment: "criado pela dashboard",
        harnessId,
        activate,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      reset();
      onOpenChange(false);
      navigate(`/agents/${res.agent.id}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Falha ao criar agente"),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        else setRole(defaultRole);
        onOpenChange(o);
      }}
    >
      <SheetContent className="max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Nova configuração</SheetTitle>
          <SheetDescription>
            Cada papel pode ter várias configurações; só uma fica ativa por vez. Você pode ajustar o comportamento depois.
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex flex-col gap-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="create-role" className="text-sm font-medium">
              Tipo do agente
            </label>
            <Select value={role} onValueChange={(v) => setRole(v as AgentRole)}>
              <SelectTrigger id="create-role" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="create-name" className="text-sm font-medium">
              Nome
            </label>
            <Input
              id="create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex.: PMO padrão"
              required
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="create-desc" className="text-sm font-medium">
              Descrição <span className="font-normal text-muted-foreground">(opcional)</span>
            </label>
            <Textarea
              id="create-desc"
              className="min-h-16"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Para que serve esta configuração"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="create-harness" className="text-sm font-medium">
              Ferramenta de execução
            </label>
            <Select value={harnessId} onValueChange={setHarnessId}>
              <SelectTrigger id="create-harness" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HARNESS_OPTIONS.map((h) => (
                  <SelectItem key={h.value} value={h.value}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="create-soul" className="text-sm font-medium">
              Instruções iniciais
            </label>
            <p className="text-xs text-muted-foreground">
              Texto que define o comportamento do agente (markdown). Pode editar e versionar depois.
            </p>
            <Textarea
              id="create-soul"
              className="min-h-40 font-mono text-xs"
              value={soul}
              onChange={(e) => setSoul(e.target.value)}
              placeholder="Cole ou escreva as instruções…"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="create-activate" checked={activate} onCheckedChange={setActivate} />
            <label htmlFor="create-activate" className="text-sm">
              Ativar ao criar (substitui a configuração ativa deste papel)
            </label>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={create.isPending || !name.trim() || !soul.trim()}>
              {create.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconCheck className="size-4" />}
              Criar
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function AgentCard({
  agent,
  hasOtherActive,
}: {
  agent: Agent;
  hasOtherActive: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);

  const activate = useMutation({
    mutationFn: () => agentsApi.activate(agent.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      setConfirmActivate(false);
    },
  });
  const deactivate = useMutation({
    mutationFn: () => agentsApi.deactivate(agent.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      setConfirmDeactivate(false);
    },
  });
  const duplicate = useMutation({
    mutationFn: () => duplicateAgent(agent),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      navigate(`/agents/${created.id}`);
    },
  });

  const isActive = !!agent.isActive;

  return (
    <>
      <Card className={cn(isActive ? "border-primary/50" : "opacity-90")}>
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium">{agent.name}</p>
              {agent.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
              )}
            </div>
            {isActive ? (
              <Badge variant="default" className="shrink-0 gap-1 text-[10px]">
                <IconCheck className="size-3" aria-hidden />
                Ativa
              </Badge>
            ) : (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                Inativa
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <RoleBadge role={agent.role} />
            <Badge variant="secondary" className="text-[10px]">
              {harnessLabel(agent.activeHarnessId)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
            <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => navigate(`/agents/${agent.id}`)}>
              <IconPencil className="size-3.5" aria-hidden />
              Editar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1"
              disabled={duplicate.isPending}
              onClick={() => duplicate.mutate()}
            >
              {duplicate.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconCopy className="size-3.5" />}
              Duplicar
            </Button>
            {isActive ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-8 gap-1 text-muted-foreground"
                onClick={() => setConfirmDeactivate(true)}
              >
                <IconPower className="size-3.5" aria-hidden />
                Desativar
              </Button>
            ) : (
              <Button
                size="sm"
                className="ml-auto h-8 gap-1"
                onClick={() => (hasOtherActive ? setConfirmActivate(true) : activate.mutate())}
                disabled={activate.isPending}
              >
                {activate.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconPower className="size-3.5" />}
                Ativar
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDeactivate}
        onOpenChange={setConfirmDeactivate}
        title="Desativar esta configuração?"
        description={`O papel ${roleLabel(agent.role)} ficará sem agente ativo até você ativar outra configuração. Novos despachos desse papel não rodarão.`}
        confirmLabel="Desativar"
        variant="destructive"
        pending={deactivate.isPending}
        onConfirm={() => deactivate.mutate()}
      />
      <ConfirmDialog
        open={confirmActivate}
        onOpenChange={setConfirmActivate}
        title="Trocar configuração ativa?"
        description={`Ativar “${agent.name}” desativa a configuração atualmente em uso neste papel.`}
        confirmLabel="Ativar"
        pending={activate.isPending}
        onConfirm={() => activate.mutate()}
      />
    </>
  );
}

export function Agents() {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["agents"], queryFn: agentsApi.list });
  const [creating, setCreating] = useState(false);

  const activeByRole = useMemo(() => {
    const map = new Map<AgentRole, boolean>();
    for (const a of data?.agents ?? []) {
      if (a.isActive) map.set(a.role, true);
    }
    return map;
  }, [data]);

  const sorted = useMemo(() => {
    const agents = data?.agents ?? [];
    const roleOrder = data?.roles ?? [];
    return [...agents].sort((a, b) => {
      const ai = roleOrder.indexOf(a.role);
      const bi = roleOrder.indexOf(b.role);
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      if (!!a.isActive !== !!b.isActive) return a.isActive ? -1 : 1;
      return a.name.localeCompare(b.name, "pt-BR");
    });
  }, [data]);

  if (isLoading) return <PageSkeleton rows={6} />;
  if (isError || !data) {
    return <PageError message="Falha ao carregar agentes." onRetry={() => refetch()} />;
  }

  const defaultRole = data.roles[0] ?? "pmo";

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        icon={IconRobot}
        title="Agents"
        description="Um agente ativo por papel (PMO, Dev, Reviewer, Orchestrator). Crie configurações alternativas, ative a desejada e edite instruções, ferramenta e integrações."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SoulSyncButton />
            <Button size="sm" className="gap-1" onClick={() => setCreating(true)}>
              <IconPlus className="size-3.5" aria-hidden />
              Nova configuração
            </Button>
          </div>
        }
      />

      {sorted.length === 0 ? (
        <EmptyState
          title="Nenhuma configuração ainda"
          description="Crie a primeira para os papéis começarem a receber trabalho."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <IconPlus className="size-3.5" aria-hidden />
              Nova configuração
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              hasOtherActive={!!activeByRole.get(a.role) && !a.isActive}
            />
          ))}
        </div>
      )}

      <CreateAgentSheet
        open={creating}
        onOpenChange={setCreating}
        roles={data.roles}
        defaultRole={defaultRole}
      />
    </div>
  );
}
