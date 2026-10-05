import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StatusSubject } from "@/components/StateChip";
import { cn } from "@/lib/utils";

/**
 * Where a save made beside a field stands (bead `ro-ujb9.96.7.12`).
 *
 * `idle` draws nothing: a field that has not been touched carries no state.
 */
export type InlineSave =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; undoing?: boolean; onUndo: () => void }
  | { state: "refused"; refusal: string };

/**
 * A SAVE'S OUTCOME, BESIDE THE FIELD THAT MADE IT (bead `ro-ujb9.96.7.12`).
 *
 * *Registry justification:* `KnobEditor` drew "Saved · Undo" inline since bead
 * `ro-ujb9.96.6.3`, and a table cell and a schedule row now save the same way;
 * three private copies of one state would drift into three wordings of it. This
 * is that state, once, after GitLab Pajamas' saving pattern
 * (docs/briefs/2026-09-23-inline-save.md#prior-art): "Saving…" while the write
 * is out, a check with "Saved" and an **Undo** once it landed, and — the part
 * that used to be a corner toast — "Not saved" with the refusal's own words
 * when it did not, so the operator reads the outcome where they made the
 * change. The words ride one line and truncate; the whole refusal is on hover
 * and to a screen reader.
 *
 * It spends no severity colour on success (a landed save is not an alert) and
 * the error ink only on a refusal, which IS one.
 */
export function InlineSaveState({
  save,
  subject,
  className,
}: {
  save: InlineSave;
  /**
   * The field this outcome is about, e.g. `field:Time zone`. A save's
   * state is a fact about ITS field, so two fields saved on one screen are two
   * subjects, not one status shown twice (doc 21 principle 3b). Drawn as
   * `data-status-for`, the attribute the flow gate reads a status's subject
   * from.
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
