// Editor de JSON dos campos livres (settings/MCPs do agente): validação ao
// vivo, botão "Validar & formatar" (beautify) e highlight de sintaxe SEM
// dependência nova — um <pre> colorido fica atrás de um <textarea> com texto
// transparente (mesma fonte/padding/quebra), truque clássico de overlay; o
// caret e a seleção continuam sendo os nativos do textarea.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { IconBraces, IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TokenKind = "key" | "string" | "number" | "boolean" | "null" | "punct" | "plain";

const TOKEN_CLASS: Record<TokenKind, string> = {
  key: "text-sky-700 dark:text-sky-400",
  string: "text-emerald-700 dark:text-emerald-400",
  number: "text-amber-700 dark:text-amber-500",
  boolean: "text-purple-700 dark:text-purple-400",
  null: "text-rose-700 dark:text-rose-400",
  punct: "text-muted-foreground",
  plain: "text-foreground",
};

// Um passe de regex sobre o texto CRU (não sobre o parse): funciona igual com
// JSON inválido no meio da digitação — o highlight nunca "pisca" pra apagado.
const TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}[\],:])/g;

function highlight(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const push = (kind: TokenKind, text: string) => {
    out.push(
      <span key={key++} className={TOKEN_CLASS[kind]}>
        {text}
      </span>
    );
  };
  for (const m of source.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) push("plain", source.slice(last, idx));
    if (m[1] !== undefined) {
      push("key", m[1]);
      push("punct", m[2]);
    } else if (m[3] !== undefined) push("string", m[3]);
    else if (m[4] !== undefined) push("number", m[4]);
    else if (m[5] !== undefined) push("boolean", m[5]);
    else if (m[6] !== undefined) push("null", m[6]);
    else if (m[7] !== undefined) push("punct", m[7]);
    last = idx + m[0].length;
  }
  if (last < source.length) push("plain", source.slice(last));
  return out;
}

function describeParseError(source: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // V8/JSC embutem "position N" na mensagem — convertemos pra linha:coluna,
  // que é o que dá pra achar num textarea.
  const pos = msg.match(/position (\d+)/i);
  if (pos) {
    const n = Number(pos[1]);
    const before = source.slice(0, n);
    const line = before.split("\n").length;
    const col = n - before.lastIndexOf("\n");
    return `JSON inválido (linha ${line}, coluna ${col}): ${msg}`;
  }
  return `JSON inválido: ${msg}`;
}

export function JsonEditor({
  value,
  onChange,
  className,
  minHeightClass = "min-h-32",
}: {
  value: string;
  onChange(next: string): void;
  className?: string;
  /** Altura mínima (o textarea continua redimensionável). */
  minHeightClass?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [formatted, setFormatted] = useState(false);

  const parseError = useMemo(() => {
    if (!value.trim()) return null;
    try {
      JSON.parse(value);
      return null;
    } catch (e) {
      return describeParseError(value, e);
    }
  }, [value]);

  const tokens = useMemo(() => highlight(value), [value]);

  const format = () => {
    try {
      const parsed: unknown = JSON.parse(value);
      onChange(JSON.stringify(parsed, null, 2));
      setFormatted(true);
      setTimeout(() => setFormatted(false), 1_500);
    } catch {
      /* erro já visível pelo indicador ao vivo */
    }
  };

  const syncScroll = (el: HTMLTextAreaElement) => {
    if (preRef.current) {
      preRef.current.scrollTop = el.scrollTop;
      preRef.current.scrollLeft = el.scrollLeft;
    }
  };

  // Fonte/padding/quebra IDÊNTICOS entre o <pre> e o <textarea> — qualquer
  // divergência desalinha o caret do texto colorido.
  const sharedText = "p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words";

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" type="button" disabled={!!parseError} onClick={format}>
          <IconBraces className="size-3.5" /> Validar &amp; formatar
        </Button>
        {formatted && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <IconCheck className="size-3.5" /> formatado
          </span>
        )}
        {parseError ? (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <IconAlertTriangle className="size-3.5" /> inválido
          </span>
        ) : (
          value.trim() && !formatted && <span className="text-xs text-muted-foreground">JSON válido</span>
        )}
      </div>

      <div
        className={cn(
          "relative overflow-hidden rounded-md border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring/50",
          parseError && "border-destructive/60"
        )}
      >
        <pre ref={preRef} aria-hidden className={cn("pointer-events-none absolute inset-0 m-0 overflow-hidden", sharedText)}>
          {tokens}
          {"\n"}
        </pre>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={cn(
            "relative block w-full resize-y bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
            sharedText,
            minHeightClass
          )}
        />
      </div>

      {parseError && <p className="text-xs text-destructive">{parseError}</p>}
    </div>
  );
}
