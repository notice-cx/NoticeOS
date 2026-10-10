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
 * When a parked alert comes back: a struck bell, the date and the time left.
 * An expired snooze is an open alert again, so it flips to a ringing bell and
 * "back since". Unsnooze ends the snooze now rather than erasing it, so one
 * chip covers both ways back.
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
      // The exact instant on hover, like every time on the desk.
      title={Number.isNaN(at.getTime()) ? until : at.toISOString()}
    >
      <Glyph className="size-3.5" aria-hidden />
      <span>{ended ? "back since" : "quiet until"}</span>
      <span className="tabular-nums">{date}</span>
      <span className="tabular-nums opacity-70">{ended ? `${distance} ago` : `in ${distance}`}</span>
    </span>
  );
}
