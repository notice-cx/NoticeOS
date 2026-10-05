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
  /** The newest panel DAY collected for this asset ('YYYY-MM-DD'). */
  latestPanelDate: string | null;
  nowMs: number;
  className?: string;
}

/**
 * The asset page's statement of the same obligation the card marks (bead
 * `ro-elf`).
 *
 * `PanelReviewBadge` is the whole answer on the Wall, where the operator only
 * GLANCES: a glyph, a tone, a duration. But the card is a drill-down target —
 * an overdue badge is an instruction to open this page and act — and the page
 * has room the card does not, so it spends that room on the three facts the
 * badge could only fit into a hover title: WHICH panel day is owed, WHEN the
 * triage was due, and the BEAD to go and close.
 *
 * The badge itself leads, unchanged, because this is one fact stated at two
 * resolutions and not two facts: the same component, the same shared
 * `panelReviewState`, and `panelDayOf` for the day, so the words beside the
 * marker can never name a different day than the marker.
 *
 * Absence is inherited too, and it follows the LANDING rather than the panel
 * file (`ro-1tu`): an asset whose weekly DataForSEO collection has not landed
 * inside the window, or that has no review filed yet, renders NOTHING — no row,
 * no dash, no empty state. An asset with no `config/serp-panel.json` entry is
 * NOT one of those cases — it collects five report families every Monday and
 * owes the same read — so it renders the row, in its own noun (`ro-z0g`): the
 * label says signal collection, matching the title of the bead the row links to.
 *
 * Only the overdue row leaves the quiet surface, taking the same error tint the
 * badge does, so a missed weekly obligation reads as a problem from across the
 * page while an asset doing the right thing on schedule costs it one muted
 * line. No status word appears anywhere: the state is the glyph's and the
 * tone's job, and everything written here is a date or an id.
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
  // The deadline is the operator's, so it is stated only while it is still
  // theirs. On a finished review it is history the page would have to explain.
  //
  // Stated as the UTC calendar DAY the deadline falls on, sliced rather than
  // parsed: the panel day beside it is a provider `report_date` in UTC, and a
  // viewer's timezone moving one of the two into a neighboring day would put
  // two dates on one row that no longer describe the same week. The exact
  // instant is not lost — the badge counts against it to the millisecond.
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
      {/* The next action, in the only vocabulary that can be acted on: the
          bead id, ready to paste into `bd show`. The Tower has no write path to
          the hub and is not getting one, so this is a pointer, never a button. */}
      <code className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {review.beadId}
      </code>
    </div>
  );
}
