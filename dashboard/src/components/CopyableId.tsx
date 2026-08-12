import { useCallback, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Tipos de ID conhecidos na dashboard — sempre rotular o que o valor representa. */
export type IdKind =
  | "issue"
  | "issue-uuid"
  | "run"
  | "agent"
  | "agent-version"
  | "connection"
  | "organization"
  | "webhook"
  | "session"
  | "harness"
  | "user"
  | "path"
  | "generic";

const KIND_LABEL: Record<IdKind, string> = {
  issue: "Issue (Linear)",
  "issue-uuid": "Issue ID (UUID Linear)",
  run: "Run ID",
  agent: "Agent ID",
  "agent-version": "Agent version ID",
  connection: "Connection ID",
  organization: "Organization ID",
  webhook: "Webhook event ID",
  session: "Session ID",
  harness: "Harness ID",
  user: "User ID",
  path: "Workspace path",
  generic: "ID",
};

/**
 * Exibe um ID com rótulo do tipo, valor completo (ou truncado em coluna com tooltip)
 * e botão de copiar. Nunca mostre um pedaço de UUID sem dizer o que é.
 */
export function CopyableId({
  value,
  kind,
  label,
  truncate = false,
  className,
}: {
  value: string | null | undefined;
  kind: IdKind;
  /** Sobrescreve o rótulo padrão do kind. */
  label?: string;
  /** Em colunas densas: mostra início…fim; tooltip e clipboard têm o valor completo. */
  truncate?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const kindLabel = label ?? KIND_LABEL[kind];

  const copy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard pode falhar sem permissão — silencioso */
    }
  }, [value]);

  if (!value) {
    return <span className={cn("text-xs text-muted-foreground", className)}>—</span>;
  }

  const display =
    truncate && value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;

  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs", className)}>
      <span className="shrink-0 text-muted-foreground">{kindLabel}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <code
            className={cn(
              "min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px] text-foreground",
              !truncate && "whitespace-nowrap"
            )}
            title={truncate ? value : undefined}
          >
            {display}
          </code>
        </TooltipTrigger>
        {truncate && (
          <TooltipContent side="top" className="max-w-md break-all font-mono text-[11px]">
            {value}
          </TooltipContent>
        )}
      </Tooltip>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={copied ? "Copiado" : `Copiar ${kindLabel}`}
        aria-label={copied ? "Copiado" : `Copiar ${kindLabel}`}
      >
        {copied ? <IconCheck className="size-3.5 text-success" aria-hidden /> : <IconCopy className="size-3.5" aria-hidden />}
      </button>
    </span>
  );
}
