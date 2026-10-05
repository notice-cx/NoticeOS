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
  /** The newest panel DAY collected for this asset ('YYYY-MM-DD'). */
  latestPanelDate: string | null;
  nowMs: number;
  className?: string;
}

/**
 * Has this asset's newest collection been triaged? (bead `ro-rkp`)
 *
 * AgeBadge's chassis, three states apart: the panel is a weekly bill, and a
 * panel nobody reads is that bill spent on a report nobody opened — nom's went
 * three weeks unread (`nom-f1c.1`), which is the whole reason this marker
 * exists on the surface the operator actually glances at.
 *
 * TWO encodings, never one, and never a status word (doc 14): the GLYPH carries
 * the state — hourglass waiting, clipboard-check done, warning triangle late —
 * and the tone escalates only for the late one, where `error` makes it read as
 * a problem across a room. Pending and reviewed stay muted on purpose; a
 * asset doing the right thing on schedule should cost the Wall nothing but
 * a small gray pill.
 *
 * The visible text is a DURATION, never prose, so the badge says what an age
 * badge says: how long. Which direction that duration runs is the glyph's job.
 * Absence is a state too, and the loudest one available: no collection landed
 * inside the window, no review filed, or a snapshot too old to carry the field
 * all render nothing whatsoever, because a marker on every card saying "nothing
 * to review here" would be noise across the entire portfolio.
 *
 * The NOUN is the review's, not this component's (bead `ro-z0g`): an asset
 * with no `config/serp-panel.json` entry still buys five report families every
 * Monday and still owes the read, so its marker says signal collection — the
 * same word its own bead title carries — while a panel asset reads exactly
 * as it always has.
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
  // The day the badge is ABOUT — one shared derivation, because the asset
  // page states the same day in words beside this badge (bead `ro-elf`).
  const landed = panelDayOf(review, latestPanelDate, state);
  const noun = panelReviewNouns(review);
  // The hover is the badge's facts, not a sentence: which review, which
  // task, which collection day (ro-ujb9.96.6.5).
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
