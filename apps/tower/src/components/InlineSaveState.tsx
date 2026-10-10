import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StatusSubject } from "@/components/StateChip";
import { cn } from "@/lib/utils";

/** Where a save made beside a field stands. `idle` draws nothing. */
export type InlineSave =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; undoing?: boolean; onUndo: () => void }
  | { state: "refused"; refusal: string };

/**
 * A save's outcome beside the field that made it: "Saving…", "Saved" with
 * Undo, or "Not saved" with the refusal's own words (truncated; the whole
 * refusal is on hover and to a screen reader). Error ink only on a refusal.
 */
export function InlineSaveState({
  save,
  subject,
  className,
}: {
  save: InlineSave;
  /**
   * The field this outcome is about, e.g. `field:Time zone`, drawn as
   * `data-status-for`: two fields saved on one screen are two subjects.
   */
  subject: StatusSubject;
  className?: string;
}) {
  if (save.state === "idle") return null;
  if (save.state === "saving") {
    return (
      <span
        role="status"
        className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}
        data-save-state="saving"
        data-status-for={subject}
      >
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
        Saving…
      </span>
    );
  }
  if (save.state === "saved") {
    return (
      <span
        role="status"
        className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}
        data-save-state="saved"
        data-status-for={subject}
      >
        <Check aria-hidden className="size-3.5 text-foreground" />
        Saved
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.undoing === true}
          onClick={save.onUndo}
        >
          {save.undoing ? "Undoing…" : "Undo"}
        </Button>
      </span>
    );
  }
  return (
    <span
      role="alert"
      title={save.refusal}
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-error", className)}
      data-save-state="refused"
      data-status-for={subject}
    >
      <X aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">Not saved</span>
      <span className="min-w-0 truncate">· {save.refusal}</span>
    </span>
  );
}
