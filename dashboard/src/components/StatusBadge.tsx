import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "@/lib/api";
import { IconLoader2, IconCheck, IconX, IconSend, IconClockPause, IconPlayerStopFilled } from "@tabler/icons-react";

const CONFIG: Record<RunStatus, { label: string; variant: "default" | "success" | "destructive" | "secondary"; icon: React.ReactNode }> = {
  running: { label: "Executando", variant: "default", icon: <IconLoader2 className="size-3 animate-spin" /> },
  completed: { label: "Concluído", variant: "success", icon: <IconCheck className="size-3" /> },
  failed: { label: "Falhou", variant: "destructive", icon: <IconX className="size-3" /> },
  dispatched: { label: "Despachado", variant: "secondary", icon: <IconSend className="size-3" /> },
  timeout: { label: "Timeout", variant: "destructive", icon: <IconClockPause className="size-3" /> },
  cancelled: { label: "Encerrado", variant: "secondary", icon: <IconPlayerStopFilled className="size-3" /> },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const c = CONFIG[status] ?? CONFIG.dispatched;
  return (
    <Badge variant={c.variant}>
      {c.icon}
      {c.label}
    </Badge>
  );
}
