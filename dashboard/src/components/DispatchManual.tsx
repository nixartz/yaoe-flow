// Dispatch manual: antecipa o tick pra UMA issue (respeita gates/deps/seats).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { IconBolt, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, dispatchApi } from "@/lib/api";

export function DispatchManual() {
  const [issue, setIssue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const run = useMutation({
    mutationFn: () => dispatchApi.now(issue.trim()),
    onSuccess: (res) => {
      setOk(!!res.dispatched);
      setMessage(res.dispatched ? "Despachado com sucesso." : res.reason ?? "Nada elegível para despachar agora.");
    },
    onError: (e) => {
      setOk(false);
      setMessage(e instanceof ApiError ? e.message : "Falha no despacho manual.");
    },
  });

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconBolt className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Iniciar por issue</p>
          <p className="text-xs text-muted-foreground">
            Antecipa o próximo ciclo do orquestrador para esta issue. Não ignora regras de capacidade, dependências ou footprint.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="dispatch-issue">
          Identificador da issue
        </label>
        <Input
          id="dispatch-issue"
          placeholder="Ex.: ENG-123"
          className="h-8 w-56"
          value={issue}
          onChange={(e) => {
            setIssue(e.target.value);
            setMessage(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && issue.trim() && run.mutate()}
        />
        <Button size="sm" className="h-8" disabled={run.isPending || !issue.trim()} onClick={() => run.mutate()}>
          {run.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : "Rodar agora"}
        </Button>
        {message && (
          <span className={`text-xs ${ok ? "text-success" : "text-muted-foreground"}`} role="status">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
