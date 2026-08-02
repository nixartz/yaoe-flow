// Link run/webhook → Linear. Preferir identifier amigável; UUID só como fallback.
import { useQuery } from "@tanstack/react-query";
import { IconExternalLink } from "@tabler/icons-react";
import { CopyableId } from "@/components/CopyableId";
import { linearApi } from "@/lib/api";
import { cn } from "@/lib/utils";

export function useLinearWorkspace(): string | null {
  const { data } = useQuery({
    queryKey: ["linear-workspace"],
    queryFn: linearApi.workspace,
    staleTime: Infinity,
    retry: false,
  });
  return data?.urlKey ?? null;
}

function useLinearIssueUrl(identifier: string | null | undefined, organizationKey?: string | null): string | null {
  const fallbackKey = useLinearWorkspace();
  const urlKey = organizationKey || fallbackKey;
  if (!identifier || !urlKey) return null;
  return `https://linear.app/${urlKey}/issue/${identifier}`;
}

/** Só o ícone (compat com call sites antigos). */
export function LinearIssueLink({
  identifier,
  organizationKey,
  className,
}: {
  identifier: string | null;
  organizationKey?: string | null;
  className?: string;
}) {
  const href = useLinearIssueUrl(identifier, organizationKey);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Abrir ${identifier} no Linear`}
      onClick={(e) => e.stopPropagation()}
      className={className ?? "inline-flex items-center text-muted-foreground hover:text-foreground"}
    >
      <IconExternalLink className="size-3.5" />
      <span className="sr-only">Abrir no Linear</span>
    </a>
  );
}

/** Identifier amigável + link textual “Abrir no Linear”. */
export function IssueIdentity({
  identifier,
  issueId,
  organizationKey,
  title,
  className,
  linkLabel = "Abrir no Linear",
  /** Quando true, mostra também o UUID Linear completo com copiar. */
  showIssueUuid = false,
}: {
  identifier: string | null | undefined;
  /** UUID Linear da issue — usado no link fallback e opcionalmente exibido. */
  issueId?: string | null;
  organizationKey?: string | null;
  title?: string | null;
  className?: string;
  linkLabel?: string;
  showIssueUuid?: boolean;
}) {
  const friendly = identifier?.trim() || null;
  const href = useLinearIssueUrl(friendly, organizationKey);

  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {friendly ? (
          <span className="truncate font-medium" title={friendly}>
            {friendly}
          </span>
        ) : issueId ? (
          <CopyableId value={issueId} kind="issue-uuid" />
        ) : (
          <span>—</span>
        )}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <IconExternalLink className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{linkLabel}</span>
          </a>
        )}
      </div>
      {title && <span className="truncate text-xs text-muted-foreground">{title}</span>}
      {showIssueUuid && friendly && issueId && (
        <CopyableId value={issueId} kind="issue-uuid" className="mt-0.5" />
      )}
    </div>
  );
}
