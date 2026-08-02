import * as DialogPrimitive from "@radix-ui/react-dialog";
import { IconLoader2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  variant = "default",
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  pending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 animate-in fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border bg-background p-5 shadow-lg animate-in fade-in-0 zoom-in-95"
          )}
        >
          <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
            {description}
          </DialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={variant === "destructive" ? "destructive" : "default"}
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? <IconLoader2 className="size-4 animate-spin" aria-hidden /> : null}
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
