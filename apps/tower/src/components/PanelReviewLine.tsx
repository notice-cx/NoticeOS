import {
  type PanelReview,
  panelDayOf,
  panelReviewNouns,
  panelReviewState,
} from "@shared/wall";
import { formatCalendarDate } from "@/lib/format";
import { PanelReviewBadge } from "@/components/PanelReviewBadge";
import { cn } from "@/lib/utils";

export interface PanelReviewLineProps {
  /** The asset's review obligation, or null — which renders nothing. */
  review: PanelReview | null;
  /** The newest panel day collected for this asset ('YYYY-MM-DD'). */
  latestPanelDate: string | null;
  nowMs: number;
  className?: string;
}

/**
 * The asset page's statement of the obligation `PanelReviewBadge` marks on the
 * Wall, adding which panel day is owed, when triage was due and the task to
 * close. It shares the badge's state and day derivation, so the two never
 * disagree, and it renders nothing exactly when the badge does.
 */
export function PanelReviewLine({
  review,
  latestPanelDate,
  nowMs,
  className,
}: PanelReviewLineProps) {
  const state = panelReviewState(review, latestPanelDate, nowMs);
  if (state === "none" || !review) return null;

  const panelDay = panelDayOf(review, latestPanelDate, state);
  // Shown only while open. Sliced, not parsed: the panel day beside it is a
  // UTC `report_date`, and a local-time parse could shift one into a
  // neighbouring day.
  const due = state === "reviewed" ? null : review.dueAt;

  return (
    <div
      data-panel-review-line={state}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs",
        state === "overdue"
          ? "border-error/40 bg-error-soft"
          : "border-border bg-background/40",
        className,
      )}
    >
      <PanelReviewBadge
        review={review}
        latestPanelDate={latestPanelDate}
        nowMs={nowMs}
      />
      <span className="font-medium">
        {panelReviewNouns(review).label}
        {panelDay ? (
          <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">
            {formatCalendarDate(panelDay)}
          </span>
        ) : null}
      </span>
      {due ? (
        <span className="tabular-nums text-muted-foreground">
          due {formatCalendarDate(due.slice(0, 10))}
        </span>
      ) : null}
      {/* The task id, ready to paste into the task CLI. */}
      <code className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {review.beadId}
      </code>
    </div>
  );
}
