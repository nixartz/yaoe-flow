import { IconPlus, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Editor de Record<string, string> — linhas chave/valor editáveis. */
export function KeyValueEditor({
  idPrefix,
  value,
  onChange,
  keyPlaceholder = "chave",
  valuePlaceholder = "valor",
  addLabel = "Adicionar",
}: {
  idPrefix: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const entries = Object.entries(value);

  const setAt = (index: number, key: string, val: string) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      if (i === index) {
        if (key.length > 0) next[key] = val;
      } else if (k.length > 0) {
        next[k] = v;
      }
    });
    onChange(next);
  };

  const removeAt = (index: number) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      if (i !== index && k.length > 0) next[k] = v;
    });
    onChange(next);
  };

  const add = () => {
    let i = 1;
    let key = `CHAVE_${i}`;
    while (key in value) {
      i += 1;
      key = `CHAVE_${i}`;
    }
    onChange({ ...value, [key]: "" });
  };

  return (
    <div className="flex flex-col gap-2">
      {entries.length === 0 && <p className="text-xs text-muted-foreground">Nenhum par ainda.</p>}
      {entries.map(([k, v], index) => (
        <div key={`${idPrefix}-${index}`} className="flex flex-wrap items-center gap-2">
          <Input
            id={`${idPrefix}-k-${index}`}
            className="h-8 min-w-[8rem] flex-1 font-mono text-xs"
            value={k}
            placeholder={keyPlaceholder}
            aria-label={`Chave ${index + 1}`}
            onChange={(e) => setAt(index, e.target.value, v)}
          />
          <Input
            id={`${idPrefix}-v-${index}`}
            className="h-8 min-w-[8rem] flex-1 font-mono text-xs"
            value={v}
            placeholder={valuePlaceholder}
            aria-label={`Valor ${index + 1}`}
            onChange={(e) => setAt(index, k, e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-destructive"
            onClick={() => removeAt(index)}
            aria-label={`Remover par ${index + 1}`}
          >
            <IconTrash className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" className="h-8 w-fit gap-1" onClick={add}>
        <IconPlus className="size-3.5" aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

/**
 * Lista de strings (um por linha). Não filtra linhas vazias no onChange —
 * assim Enter e vírgulas funcionam; quem serializa filtra com `compactStringList`.
 */
export function StringListEditor({
  id,
  value,
  onChange,
  placeholder,
  className,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Textarea
      id={id}
      className={className ?? "min-h-16 font-mono text-xs"}
      value={value.join("\n")}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? [] : e.target.value.split("\n"))}
    />
  );
}

/** Remove entradas vazias / só-espaço antes de gravar no JSON. */
export function compactStringList(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter(Boolean);
}

export function compactRecord(obj: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!obj) return undefined;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.trim();
    if (!key) continue;
    next[key] = v;
  }
  return Object.keys(next).length ? next : undefined;
}
