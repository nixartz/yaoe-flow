import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {Icon && <Icon className="size-5 text-muted-foreground" aria-hidden />}
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
