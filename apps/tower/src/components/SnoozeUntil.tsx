import { BellOff, BellRing } from "lucide-react";
import { formatAge } from "@shared/freshness";
import { snoozeEnded } from "@shared/snooze";
import { formatCalendarDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface SnoozeUntilProps {
  /** flags.snooze_until — the instant the condition returns. */
  until: string;
  nowMs: number;
  className?: string;
}

/**
 * WHEN A PARKED ALERT COMES BACK, as a glyph and a date (`ro-c7qq`).
 *
 * The 2026-09-04 rule for the SaaS desk: a state carries the visual that makes
 * it legible at a glance. "Snoozed" is a status word — it says an operator once
 * clicked something, and leaves the only fact that matters ("for how much
 * longer?") to be read out of an ISO timestamp. So the chip leads with a
 * struck bell, states the calendar date, and puts the REMAINING time beside it
 * in tabular numerals, which is the number that decides whether this is parked
 * or effectively forgotten.
 *
 * It has two states because a snooze has two, and the second is the one worth
 * designing: an EXPIRED snooze is an open alert again — same id, same evidence —
 * and its row has to say "this came back" rather than keep claiming silence.
 * The glyph flips to a ringing bell and the date becomes a past date, so a row
 * the operator quieted three weeks ago and is now looking at again explains
 * itself without a legend. Unsnooze writes the same shape (it ends the snooze
 * NOW rather than erasing it), so one chip covers both ways back.
 *
 * Registry entry rather than a route-local span: two surfaces render it — the
 * `/alerts` Snoozed list and the asset page's alert history — and the whole
 * point is that they say it identically.
 */
export function SnoozeUntil({ until, nowMs, className }: SnoozeUntilProps) {
  const ended = snoozeEnded(until, nowMs);
  const at = new Date(until);
  const date = Number.isNaN(at.getTime()) ? until : formatCalendarDate(until.slice(0, 10));
  const distance = formatAge(Math.abs(at.getTime() - nowMs));
  const Glyph = ended ? BellRing : BellOff;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-px text-xs font-medium",
        ended
          ? "border-warn/40 bg-warn/10 text-warn"
          : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
      data-snooze-state={ended ? "ended" : "active"}
      // The exact instant on hover, like every time on the desk. The state is
      // already the glyph and the words: a struck bell "quiet until", a ringing
      // one "back since".
      title={Number.isNaN(at.getTime()) ? until : at.toISOString()}
    >
      <Glyph className="size-3.5" aria-hidden />
      <span>{ended ? "back since" : "quiet until"}</span>
      <span className="tabular-nums">{date}</span>
      <span className="tabular-nums opacity-70">{ended ? `${distance} ago` : `in ${distance}`}</span>
    </span>
  );
}
