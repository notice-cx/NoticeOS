import type { AnnotationItem } from "@shared/annotations";
import { CORRELATION_WINDOW_HOURS, changesLabel } from "@shared/alert-language";
import { ANNOTATION_KIND } from "@/components/annotation-kind";
import { Drill } from "@/components/Drill";
import { cn } from "@/lib/utils";

export interface ChangeChipProps {
  /** Already correlated by the payload — the changes inside this alert's window. */
  changes: AnnotationItem[];
  /** The alert's fired_at; a single change is dated against it ("14h before"). */
  firedAt: string;
  /** Asset to drill into. Omit on the Wall, where nothing is clickable. */
  to?: string;
  interactive?: boolean;
  className?: string;
}

/**
 * The "something changed just before this" chip on an alert.
 *
 * A metric drop is a fact; a metric drop sitting next to a deploy from fourteen
 * hours earlier is an insight, and it is the one thing on the line that tells an
 * operator where to start looking. The correlation is done payload-side; this
 * only renders it, and renders NOTHING when nothing correlates — the common case
 * has to stay silent or the chip becomes chrome (doc 10 noise control).
 *
 * Deliberately not colored: it is context, not a state. Severity belongs to the
 * dot at the head of the line, and nothing else on the line may repeat it.
 */
export function ChangeChip({ changes, firedAt, to, interactive = false, className }: ChangeChipProps) {
  const label = changesLabel(changes, firedAt, CORRELATION_WINDOW_HOURS);
  if (!label) return null;

  // Mixed kinds get the generic glyph of the nearest change — the one whose
  // timing the operator will check first.
  const Icon = ANNOTATION_KIND[changes[0]!.kind].icon;
  const detail = changes[0]?.note ?? changes[0]?.ref ?? null;

  const body = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground",
        interactive && "transition-colors hover:border-foreground/30 hover:text-foreground",
        className,
      )}
      title={
        changes.length === 1 && detail
          ? `${label} — ${detail}`
          : `${changes.length} timeline events in the window before this alert`
      }
    >
      <Icon className="size-3 shrink-0" />
      {label}
    </span>
  );

  // The pill already reads as a target; Drill's underline would fight its border.
  return interactive && to ? (
    <Drill interactive to={to} className="hover:no-underline">
      {body}
    </Drill>
  ) : (
    body
  );
}
