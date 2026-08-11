// "Aplicar SOUL padrão": re-imports the SOULs bundled with the running binary
// into the database (same core as the `yaoe-flow sync-souls` CLI command).
//
// Two phases on purpose: the dialog first shows the read-only plan — which role
// changes, from which version to which version — and only writes after the
// human confirms. The previous SOUL is never lost: the write appends a new
// version and activates it, so the old text stays in the agent's history.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { IconLoader2, IconRefreshDot, IconAlertTriangle } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoleBadge } from "@/components/RoleBadge";
import { agentsApi, ApiError, type SoulSyncApplied, type SoulSyncEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

function lines(n: number | null): string {
  return `${n ?? 0} ${n === 1 ? "linha" : "linhas"}`;
}

function seedIdentity(entry: SoulSyncEntry): string {
  return `${entry.seedHash ?? "—"} · ${lines(entry.seedLines)}`;
}

function PlanRow({ entry }: { entry: SoulSyncEntry }) {
  return (
    <div className="flex items-start gap-2 border-b py-2 last:border-b-0">
      <RoleBadge role={entry.role} />
      <div className="min-w-0 flex-1 text-xs">
        {entry.status === "outdated" && (
          <>
            <p className="text-foreground">
              <span className="font-medium">{entry.agentName}</span>{" "}
              <span className="font-mono">v{entry.currentVersion}</span> →{" "}
              <span className="font-mono font-medium text-primary">v{entry.nextVersion}</span>
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {entry.currentHash} ({lines(entry.currentLines)}) → {seedIdentity(entry)}
            </p>
          </>
        )}
        {entry.status === "up-to-date" && (
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{entry.agentName}</span> já roda a SOUL deste binário (
            <span className="font-mono">v{entry.currentVersion}</span> · {entry.currentHash})
          </p>
        )}
        {entry.status === "no-agent" && (
          <p className="text-muted-foreground">Sem agente ativo neste papel — nada a atualizar.</p>
        )}
        {entry.status === "no-seed" && (
          <p className="text-muted-foreground">
            <span className="font-mono">agents/{entry.soulFile}</span> não vem embutida neste binário.
          </p>
        )}
      </div>
      {entry.status === "outdated" && (
        <Badge variant="warning" className="shrink-0 text-[10px]">
          Desatualizada
        </Badge>
      )}
    </div>
  );
}

function AppliedRow({ applied }: { applied: SoulSyncApplied }) {
  return (
    <div className="flex items-center gap-2 border-b py-2 text-xs last:border-b-0">
      <RoleBadge role={applied.role} />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{applied.agentName}</span>{" "}
        <span className="font-mono">v{applied.previousVersion}</span> →{" "}
        <span className="font-mono font-medium text-primary">v{applied.newVersion}</span>
      </p>
      <span className="shrink-0 text-muted-foreground">versão anterior mantida no histórico</span>
    </div>
  );
}

export function SoulSyncButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState<SoulSyncApplied[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = useQuery({ queryKey: ["agents", "soul-sync"], queryFn: agentsApi.soulSyncPlan });
  const entries = plan.data?.plan ?? [];
  const outdated = entries.filter((e) => e.status === "outdated");

  const apply = useMutation({
    mutationFn: () => agentsApi.soulSyncApply(),
    onSuccess: (res) => {
      setApplied(res.applied);
      setError(null);
      // Prefix invalidation: refreshes the agent cards AND the plan above.
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Falha ao aplicar as SOULs padrão"),
  });

  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setApplied(null);
      setError(null);
      apply.reset();
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="gap-1"
        disabled={plan.isLoading}
        onClick={() => setOpen(true)}
      >
        <IconRefreshDot className="size-3.5" aria-hidden />
        Aplicar SOUL padrão
        {outdated.length > 0 && (
          <Badge variant="warning" className="ml-1 text-[10px]">
            {outdated.length}
          </Badge>
        )}
      </Button>

      <DialogPrimitive.Root open={open} onOpenChange={close}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 animate-in fade-in-0" />
          <DialogPrimitive.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2",
              "rounded-lg border bg-background p-5 shadow-lg animate-in fade-in-0 zoom-in-95"
            )}
          >
            <DialogPrimitive.Title className="text-base font-semibold">
              {applied ? "SOULs padrão aplicadas" : "Aplicar as SOULs deste binário?"}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description asChild>
              <div className="mt-2 text-sm text-muted-foreground">
                {applied
                  ? "Cada papel abaixo passou a rodar a SOUL embutida nesta versão. Nenhum reinício é necessário — o próximo despacho já usa a nova versão."
                  : "Compara a SOUL de cada papel no banco com a versão embutida neste binário. Onde houver diferença, uma NOVA versão ativa é criada."}
              </div>
            </DialogPrimitive.Description>

            <div className="mt-4 max-h-[45vh] overflow-y-auto rounded-md border px-3">
              {applied
                ? applied.map((a) => <AppliedRow key={a.role} applied={a} />)
                : entries.map((e) => <PlanRow key={e.role} entry={e} />)}
              {!applied && entries.length === 0 && (
                <p className="py-3 text-xs text-muted-foreground">Nenhum papel encontrado.</p>
              )}
            </div>

            {!applied && outdated.length > 0 && (
              <div className="mt-3 flex gap-2 rounded-md border border-warning/20 bg-warning/10 p-3 text-xs text-foreground">
                <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <div className="flex flex-col gap-1">
                  <p>
                    A SOUL atual de cada papel continua no histórico (Agents → editar → versões) e pode ser reativada a
                    qualquer momento.
                  </p>
                  <p>
                    Edições feitas aqui na dashboard <strong>não são mescladas</strong>: o texto embutido substitui a
                    versão ativa.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              {applied ? (
                <Button type="button" size="sm" onClick={() => close(false)}>
                  Fechar
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={apply.isPending}
                    onClick={() => close(false)}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={apply.isPending || outdated.length === 0}
                    onClick={() => apply.mutate()}
                  >
                    {apply.isPending ? <IconLoader2 className="size-4 animate-spin" aria-hidden /> : null}
                    {outdated.length === 0
                      ? "Tudo atualizado"
                      : `Aplicar em ${outdated.length} ${outdated.length === 1 ? "papel" : "papéis"}`}
                  </Button>
                </>
              )}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
