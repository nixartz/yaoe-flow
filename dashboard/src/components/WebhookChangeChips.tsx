import { IconArrowRight, IconPlus, IconMinus } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import type { WebhookChange } from "@/lib/webhookChange";
import { cn } from "@/lib/utils";

/** Chips de mudança Linear: status before→after e labels +/-. */
export function WebhookChangeChips({
  change,
  summaryFallback,
  className,
}: {
  change: WebhookChange;
  summaryFallback?: string;
  className?: string;
}) {
  if (!change.hasStructuredDiff) {
    if (!summaryFallback) return <span className="text-muted-foreground">—</span>;
    return <span className={cn("text-sm text-muted-foreground", className)}>{summaryFallback}</span>;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {(change.stateFrom || change.stateTo) && (
        <span className="inline-flex items-center gap-1">
          {change.stateFrom && (
            <Badge variant="outline" className="font-normal">
              {change.stateFrom}
            </Badge>
          )}
          <IconArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {change.stateTo && (
            <Badge variant="default" className="font-normal">
              {change.stateTo}
            </Badge>
          )}
          {!change.stateFrom && !change.stateTo && (
            <Badge variant="secondary" className="font-normal">
              Estado alterado
            </Badge>
          )}
        </span>
      )}
      {change.labelsAdded.map((name) => (
        <Badge key={`+${name}`} variant="success" className="gap-0.5 font-normal">
          <IconPlus className="size-3" aria-hidden />
          {name}
        </Badge>
      ))}
      {change.labelsRemoved.map((label, i) => (
        <Badge key={`-${i}`} variant="secondary" className="gap-0.5 font-normal">
          <IconMinus className="size-3" aria-hidden />
          {label}
        </Badge>
      ))}
      {change.titleChanged && (
        <Badge variant="outline" className="font-normal">
          Título alterado
        </Badge>
      )}
      {change.descriptionChanged && (
        <Badge variant="outline" className="font-normal">
          Descrição alterada
        </Badge>
      )}
      {change.projectChanged && (
        <Badge variant="outline" className="font-normal">
          Projeto alterado
        </Badge>
      )}
      {change.milestoneChanged && (
        <Badge variant="outline" className="font-normal">
          Milestone alterado
        </Badge>
      )}
    </div>
  );
}
