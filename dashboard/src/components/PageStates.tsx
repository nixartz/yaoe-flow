import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 p-6", className)} aria-busy="true" aria-label="Carregando">
      <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-4 w-72 animate-pulse rounded-md bg-muted" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg border bg-muted/40" />
      ))}
    </div>
  );
}

export function PageError({
  message = "Falha ao carregar.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 p-6" role="alert">
      <p className="text-sm text-destructive">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-8">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
