import { IconLoader2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";

export function StickySaveBar({
  dirtyCount,
  onDiscard,
  onSave,
  saving,
  error,
  success,
  saveLabel = "Salvar alterações",
  discardLabel = "Descartar",
}: {
  dirtyCount: number;
  onDiscard: () => void;
  onSave: () => void;
  saving?: boolean;
  error?: string | null;
  success?: boolean;
  saveLabel?: string;
  discardLabel?: string;
}) {
  if (dirtyCount <= 0) return null;

  return (
    <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 border-t bg-background/95 px-6 py-3 backdrop-blur">
      <span className="text-sm">
        {dirtyCount === 1 ? "1 alteração pendente" : `${dirtyCount} alterações pendentes`}
      </span>
      {error && (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
      {success && !error && <span className="text-sm text-success">Salvo.</span>}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDiscard} disabled={saving}>
          {discardLabel}
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={saving}>
          {saving ? <IconLoader2 className="size-4 animate-spin" aria-hidden /> : null}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
