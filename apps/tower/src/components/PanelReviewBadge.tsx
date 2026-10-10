import { ClipboardCheck, Hourglass, TriangleAlert } from "lucide-react";
import { formatAge } from "@shared/freshness";
import {
  type PanelReview,
  panelDayOf,
  panelReviewNouns,
  panelReviewState,
} from "@shared/wall";
import { cn } from "@/lib/utils";

export interface PanelReviewBadgeProps {
  /** The asset's review obligation, or null — which renders nothing. */
  review: PanelReview | null;
  /** The newest panel day collected for this asset ('YYYY-MM-DD'). */
  latestPanelDate: string | null;
  nowMs: number;
  className?: string;
}

/**
 * Has this asset's newest collection been triaged? The glyph carries the state
 * (hourglass pending, clipboard-check done, triangle late), only the late one
 * takes the error tone, and the text is a duration. No collection, no review
 * filed, or an old snapshot renders nothing. The noun comes from the review,
 * so an asset without a SERP panel reads "signal collection".
 */
export function PanelReviewBadge({
  review,
  latestPanelDate,
  nowMs,
  className,
}: PanelReviewBadgeProps) {
  const state = panelReviewState(review, latestPanelDate, nowMs);
  if (state === "none" || !review) return null;

  const dueMs = review.dueAt ? Date.parse(review.dueAt) : Number.NaN;
  const closedMs = review.closedAt ? Date.parse(review.closedAt) : Number.NaN;
  // Shared with `PanelReviewLine`, which states the same day in words.
  const landed = panelDayOf(review, latestPanelDate, state);
  const noun = panelReviewNouns(review);
  const facts = (label: string) =>
    [label, `task ${review.beadId}`, landed ? `${noun.collected} ${landed}` : null]
      .filter(Boolean)
      .join(" · ");

  const face =
    state === "overdue"
      ? {
          Icon: TriangleAlert,
          tone: "bg-error-soft text-error",
          age: formatAge(Number.isNaN(dueMs) ? null : Math.max(0, nowMs - dueMs)),
          label: `${noun.label} review overdue`,
        }
      : state === "reviewed"
        ? {
            Icon: ClipboardCheck,
            tone: "bg-muted text-muted-foreground",
            age: formatAge(Number.isNaN(closedMs) ? null : Math.max(0, nowMs - closedMs)),
            label: `${noun.label} reviewed`,
          }
        : {
            Icon: Hourglass,
            tone: "bg-muted text-muted-foreground",
            age: formatAge(Number.isNaN(dueMs) ? null : Math.max(0, dueMs - nowMs)),
            label: `${noun.label} review pending`,
          };

  return (
    <span
      role="img"
      aria-label={`${face.label}, ${face.age}`}
      title={facts(face.label)}
      data-panel-review={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
        face.tone,
        className,
      )}
    >
      <face.Icon className="size-3" aria-hidden />
      {face.age}
    </span>
  );
}
