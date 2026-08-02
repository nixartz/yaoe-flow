// Escolha de modelo por harness. Existe porque texto livre aqui era uma
// armadilha: o Cursor só aceita os ids parametrizados que ele mesmo enumera
// (`default[]`, `claude-opus-5[thinking=true,effort=high]`), e um "auto"
// digitado à mão só falhava no MEIO do run, sem a dashboard nunca dizer o que
// era válido. Quando o harness enumera (capabilities.modelSelection = "list" +
// sonda da detecção), viramos select; quando não, seguimos no campo livre —
// goose/hermes resolvem modelo por env/recipe, e travar a escolha ali seria
// pior que deixar aberto.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconLoader2, IconPencil, IconList } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { harnessApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

// Radix Select não aceita item com value vazio — sentinelas pros dois casos
// que não são "um modelo da lista".
const DEFAULT_SENTINEL = "__default__";
const CUSTOM_SENTINEL = "__custom__";

export function ModelPicker({
  harnessId,
  value,
  onChange,
}: {
  harnessId: string;
  value: string;
  onChange(next: string): void;
}) {
  const query = useQuery({
    queryKey: ["harness-models", harnessId],
    queryFn: () => harnessApi.models(harnessId),
  });
  // Valor fora da lista (ou lista ainda não carregada) começa em texto livre,
  // pra nunca "sumir" com o que já estava salvo no agente.
  const [custom, setCustom] = useState(false);

  const models = query.data?.models ?? [];
  const enumerates = models.length > 0;
  const known = enumerates && value !== "" && models.some((m) => m.id === value);
  const freeText = custom || (enumerates && value !== "" && !known) || !enumerates;

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="model" />
        <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
          <IconLoader2 className="size-3.5 animate-spin" /> modelos…
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {freeText ? (
        <div className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={enumerates ? "id do modelo (fora da lista do harness)" : "model (vazio = default do harness)"}
          />
          {enumerates && (
            <Button
              size="sm"
              variant="ghost"
              className="whitespace-nowrap text-xs"
              onClick={() => {
                setCustom(false);
                if (!models.some((m) => m.id === value)) onChange("");
              }}
            >
              <IconList className="size-3.5" /> escolher da lista
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            value={value === "" ? DEFAULT_SENTINEL : value}
            onValueChange={(next) => {
              if (next === CUSTOM_SENTINEL) {
                setCustom(true);
                return;
              }
              onChange(next === DEFAULT_SENTINEL ? "" : next);
            }}
          >
            <SelectTrigger className="w-full max-w-xl">
              <SelectValue placeholder="escolha o modelo" />
            </SelectTrigger>
            <SelectContent className="max-w-2xl">
              <ScrollArea className="max-h-72">
                <SelectItem value={DEFAULT_SENTINEL}>
                  (vazio) — default do harness{query.data?.defaultModelId ? `: ${query.data.defaultModelId}` : ""}
                </SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex items-baseline gap-2">
                      <span>{m.name ?? m.id}</span>
                      {m.name && m.name !== m.id && <span className="font-mono text-[10px] text-muted-foreground">{m.id}</span>}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SENTINEL}>
                  <span className="flex items-center gap-1">
                    <IconPencil className="size-3.5" /> outro (digitar id manualmente)
                  </span>
                </SelectItem>
              </ScrollArea>
            </SelectContent>
          </Select>
          <Badge variant="outline" className="whitespace-nowrap text-[10px]">
            {models.length} modelos
          </Badge>
        </div>
      )}
      <ModelHint
        enumerates={enumerates}
        modelSelection={query.data?.modelSelection}
        checkedAt={query.data?.checkedAt}
        unknownValue={enumerates && value !== "" && !known}
      />
    </div>
  );
}

function ModelHint({
  enumerates,
  modelSelection,
  checkedAt,
  unknownValue,
}: {
  enumerates: boolean;
  modelSelection?: "list" | "flag" | "none";
  checkedAt?: number;
  unknownValue: boolean;
}) {
  if (unknownValue) {
    return (
      <p className="text-xs text-warning">
        Este id não está na lista que o harness enumerou — ele pode ser recusado no início do run. Escolha da lista se não
        souber o formato exato.
      </p>
    );
  }
  if (enumerates) {
    return (
      <p className="text-xs text-muted-foreground">
        Lista vinda do próprio harness{checkedAt ? ` (sondada em ${formatDateTime(checkedAt)})` : ""}. Para atualizar, use
        "Re-detectar" na tela Harness.
      </p>
    );
  }
  if (modelSelection === "none") {
    return <p className="text-xs text-muted-foreground">Este harness não aceita escolha de modelo — o valor é ignorado.</p>;
  }
  if (modelSelection === "list") {
    return (
      <p className="text-xs text-muted-foreground">
        Este harness enumera modelos, mas a lista ainda não foi sondada (CLI ausente ou não logado). Rode "Re-detectar" na
        tela Harness.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Este harness não enumera modelos via protocolo — o valor vai como está (env/recipe do CLI).
    </p>
  );
}
