import type { ReactNode } from "react";
import { IconLock, IconLoader2, IconRefreshAlert, IconRotate } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LinearValidationResult, SettingEntry } from "@/lib/api";
import { ENUM_LABELS, msToUi, settingLabel, uiToMs, unitLabel } from "@/lib/settingsUi";
import { cn } from "@/lib/utils";

function SourceBadge({ entry }: { entry: SettingEntry }) {
  if (entry.source === "env") {
    return (
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <IconLock className="size-3" aria-hidden />
        Definido no ambiente
      </Badge>
    );
  }
  if (entry.source === "db") return <Badge variant="default" className="text-[10px]">Personalizado</Badge>;
  return <Badge variant="outline" className="text-[10px]">Padrão</Badge>;
}

export function SettingsField({
  entry,
  draft,
  onChange,
  validation,
  onReset,
  resetPending,
  compact,
  showTechnicalKey = true,
}: {
  entry: SettingEntry;
  draft: string | undefined;
  onChange: (value: string) => void;
  validation?: LinearValidationResult;
  onReset?: () => void;
  resetPending?: boolean;
  /** Densidade maior (ex.: card Harness). */
  compact?: boolean;
  showTechnicalKey?: boolean;
}) {
  const editable = entry.editable && entry.source !== "env";
  const value = draft !== undefined ? draft : entry.secret ? "" : entry.value;
  const dirty = draft !== undefined && draft !== (entry.secret ? "" : entry.value);
  const id = `setting-${entry.key}`;

  let control: ReactNode;

  if (!editable) {
    control = (
      <p className="break-all font-mono text-sm text-muted-foreground">
        {entry.secret ? "••••••••" : entry.value === "" ? "(vazio)" : entry.value}
      </p>
    );
  } else if (entry.type === "boolean") {
    const checked = value === "true";
    control = (
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={(c) => onChange(c ? "true" : "false")}
          aria-describedby={`${id}-desc`}
        />
        <span className="text-sm text-muted-foreground">{checked ? "Ligado" : "Desligado"}</span>
      </div>
    );
  } else if (entry.type === "enum" && entry.enumValues) {
    const labels = ENUM_LABELS[entry.key] ?? {};
    control = (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9 w-full max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {entry.enumValues.map((v) => (
            <SelectItem key={v} value={v}>
              {labels[v] ?? v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (entry.type === "duration_ms") {
    const parsed = Number(value || entry.defaultValue || "0");
    const { value: uiVal, unit } = msToUi(Number.isFinite(parsed) ? parsed : 0);
    control = (
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          className="h-9 w-28"
          name={id}
          autoComplete="off"
          value={Number.isFinite(Number(value)) ? msToUi(Number(value)).value : uiVal}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange(String(uiToMs(n, unit)));
          }}
        />
        <span className="text-sm text-muted-foreground">{unitLabel(unit)}</span>
      </div>
    );
  } else if (entry.type === "number") {
    control = (
      <Input
        id={id}
        type="number"
        className="h-9 w-40"
        name={id}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (entry.type === "json") {
    control = (
      <Textarea
        id={id}
        name={id}
        autoComplete="off"
        className="min-h-24 max-w-xl font-mono text-xs"
        value={value}
        placeholder={entry.defaultValue || "[]"}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        name={id}
        type={entry.secret ? "password" : "text"}
        className="h-9 max-w-md"
        value={value}
        placeholder={entry.secret ? "Novo valor do segredo" : entry.defaultValue || undefined}
        autoComplete={entry.secret ? "new-password" : "off"}
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div
      className={cn(
        compact ? "border-b border-border/40 py-3 last:border-0" : "border-b border-border/50 py-4 last:border-0",
        dirty && "bg-accent/30 -mx-2 rounded-md px-2"
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={editable ? id : undefined} className="text-sm font-medium">
            {settingLabel(entry.key)}
          </label>
          <p id={`${id}-desc`} className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            {entry.description}
          </p>
          {showTechnicalKey && (
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80" title="Chave técnica">
              {entry.key}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge entry={entry} />
          {entry.secret && <Badge variant="outline" className="text-[10px]">Segredo</Badge>}
          {entry.requiresRestart && (
            <Badge variant="warning" className="gap-1 text-[10px]">
              <IconRefreshAlert className="size-3" aria-hidden />
              Reinício
            </Badge>
          )}
          {validation && (
            <Badge variant={validation.ok ? "success" : "destructive"} className="text-[10px]">
              {validation.ok ? "OK no Linear" : "Não encontrado no Linear"}
            </Badge>
          )}
          {editable && entry.source === "db" && onReset && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-muted-foreground"
              title="Restaurar padrão"
              disabled={resetPending}
              onClick={onReset}
            >
              {resetPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconRotate className="size-3.5" />}
              <span className="sr-only">Restaurar padrão</span>
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2">{control}</div>
      {entry.requiresRestart && editable && (
        <p className="mt-1 flex items-center gap-1 text-xs text-warning">
          <IconRefreshAlert className="size-3.5" aria-hidden />
          Só vale após reiniciar o serviço
        </p>
      )}
    </div>
  );
}
