// Seletor de janela de tempo estilo CloudWatch/Grafana: presets relativos +
// custom (datetime-local). Devolve sempre {from, to} em epoch ms.
import { useState } from "react";
import { IconClock } from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface TimeRange {
  from: number;
  to: number;
  label: string;
}

const PRESETS: { label: string; ms: number }[] = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
  { label: "12h", ms: 12 * 60 * 60_000 },
  { label: "1d", ms: 24 * 60 * 60_000 },
];

export function relativeRange(label: string): TimeRange {
  const preset = PRESETS.find((p) => p.label === label) ?? PRESETS[2];
  const to = Date.now();
  return { from: to - preset.ms, to, label: preset.label };
}

function toLocalInputValue(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function TimeRangePicker({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(() => toLocalInputValue(value.from));
  const [customTo, setCustomTo] = useState(() => toLocalInputValue(value.to));

  return (
    <div className="flex items-center gap-1 rounded-md border p-1">
      <IconClock className="ml-1 size-4 text-muted-foreground" />
      {PRESETS.map((p) => (
        <button
          key={p.label}
          onClick={() => onChange(relativeRange(p.label))}
          className={cn(
            "rounded px-2 py-1 text-xs font-medium transition-colors",
            value.label === p.label ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
          )}
        >
          {p.label}
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              value.label === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
            )}
          >
            custom
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="flex flex-col gap-2">
            <label className="text-xs text-muted-foreground">
              De
              <Input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="mt-1" />
            </label>
            <label className="text-xs text-muted-foreground">
              Até
              <Input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="mt-1" />
            </label>
            <Button
              size="sm"
              onClick={() => {
                onChange({ from: new Date(customFrom).getTime(), to: new Date(customTo).getTime(), label: "custom" });
                setOpen(false);
              }}
            >
              Aplicar
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
