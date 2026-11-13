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
 * Shows time remaining, time since review or time overdue in words as well as
 * glyphs. A finished review of an older collection supplies no deadline for
 * the new one. The collection day stays available to assistive technology.
 */
export function PanelReviewBadge({
  review,
  latestPanelDate,
  nowMs,
  className,
}: PanelReviewBadgeProps) {
  const state = panelReviewState(review, latestPanelDate, nowMs);
  if (state === "none" || !review) return null;

  const dueMs = review.status === "open" && review.dueAt ? Date.parse(review.dueAt) : Number.NaN;
  const closedMs = review.closedAt ? Date.parse(review.closedAt) : Number.NaN;
  // Shared with `PanelReviewLine`, which states the same day in words.
  const landed = panelDayOf(review, latestPanelDate, state);
  const noun = panelReviewNouns(review);
  const facts = (label: string) =>
    [label, `task ${review.taskId}`, landed ? `${noun.collected} ${landed}` : null]
      .filter(Boolean)
      .join(" · ");

  const face =
    state === "overdue"
      ? {
          Icon: TriangleAlert,
          tone: "bg-error-soft text-error",
          text: `${formatAge(Math.max(0, nowMs - dueMs))} late`,
          at: review.dueAt,
          label: `${noun.label} review overdue`,
        }
      : state === "reviewed"
        ? {
            Icon: ClipboardCheck,
            tone: "bg-muted text-muted-foreground",
            text: Number.isNaN(closedMs) ? "Reviewed" : `Reviewed ${formatAge(Math.max(0, nowMs - closedMs))} ago`,
            at: Number.isNaN(closedMs) ? null : review.closedAt,
            label: `${noun.label} reviewed`,
          }
        : {
            Icon: Hourglass,
            tone: "bg-muted text-muted-foreground",
            text: Number.isNaN(dueMs) ? "Review pending" : `${formatAge(Math.max(0, dueMs - nowMs))} left`,
            at: Number.isNaN(dueMs) ? null : review.dueAt,
            label: `${noun.label} review pending`,
          };

  return (
    <span
      role="img"
      aria-label={facts(`${face.label}, ${face.text}`)}
      title={facts(face.label)}
      data-panel-review={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
        face.tone,
        className,
      )}
    >
      <face.Icon className="size-3" aria-hidden />
      {face.at ? <time dateTime={face.at}>{face.text}</time> : face.text}
    </span>
  );
}
