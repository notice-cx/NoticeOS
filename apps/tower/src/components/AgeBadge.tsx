import { CalendarOff, CircleHelp, CircleSlash2, Clock, ClockAlert } from "lucide-react";
import { ageMs, formatAge, isAmber } from "@shared/freshness";
import { cn } from "@/lib/utils";

export interface AgeBadgeProps {
  /** Timestamp of the data this tile shows (ISO), or null if never received. */
  iso: string | null;
  /** The lane's expected cadence in hours; amber past 2× (doc 10). */
  cadenceHours: number;
  /** Injected for deterministic tests; defaults to now. */
  nowMs?: number;
  /** True when the tile is showing a last-good value after a failed fetch. */
  lastGood?: boolean;
  className?: string;
}

/** Every tile carries one of these. Turns amber once the data is older than 2×
 * its lane cadence — a stale tile that looks current is how silent failures
 * survive (doc 10 principle 2).
 *
 * THE BADGE OWNS THE ABSENT CASE (bead `ro-kukv.10`, doc 14 rule 6). A lane
 * that has never received anything has no age, and the badge used to print the
 * `formatAge` em-dash for it beside a clock titled "Data age" — a dash in a
 * value's slot reads as a rendering failure rather than as an absence, and the
 * honest word here is short and available. `formatAge` itself is deliberately
 * NOT changed: fifteen call sites interpolate it as "{age} ago", where a word
 * would produce "never ago", and its dash is the ordinary convention in the
 * dense cells those sites draw. The word lives where the fact does — the badge
 * knows it was handed no timestamp at all, and every one of those call sites
 * has a non-null timestamp or its own guard.
 *
 * A timestamp we were handed but cannot parse is a THIRD state and says so:
 * "never" would claim nothing ever arrived, which is a different and untrue
 * thing to tell an operator about a lane that reported into a bad row. */
export function AgeBadge({ iso, cadenceHours, nowMs = Date.now(), lastGood = false, className }: AgeBadgeProps) {
  const amber = isAmber(nowMs, iso, cadenceHours);
  const ms = ageMs(nowMs, iso);
  const state = ms !== null ? "aged" : iso ? "unreadable" : "never";
  /* STALE IS A GLYPH AS WELL AS AMBER (bead `ro-ujb9.14`): an old age and a
     fresh one used to share the plain clock and differ only in colour, with
     "Stale" in a hover title a keyboard, a phone and a screen reader never
     reached. A stale age draws the clock with the mark and says "stale" to a
     screen reader; an unreadable timestamp draws the question it is. */
  const Icon =
    state === "never" ? CalendarOff : state === "unreadable" ? CircleHelp : amber ? ClockAlert : Clock;
  return (
    <span
      data-age-state={state}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
        amber ? "bg-warn-soft text-warn" : "bg-muted text-muted-foreground",
        className,
      )}
      title={
        state === "never"
          ? "Never reported — nothing has ever arrived from this source"
          : state === "unreadable"
            ? "The stored timestamp for this source could not be read"
            : amber
              ? "Stale — data is older than 2× its expected cadence"
              : lastGood
                ? "Last-good value (last fetch failed)"
                : "Data age"
      }
    >
      <Icon className="size-3" aria-hidden data-age-glyph={state === "aged" && amber ? "stale" : state} />
      {state === "never" ? "never" : state === "unreadable" ? "unknown" : formatAge(ms)}
      {state === "aged" && amber ? <span className="sr-only"> · stale</span> : null}
      {lastGood ? " · last-good" : ""}
    </span>
  );
}

/**
 * THE THIRD ABSENCE: NONE IS OWED (bead `ro-ujb9.96.8`). An asset whose
 * Settings declare that it sends no nightly report has no age to show and
 * nothing late about it, so its nightly slot is this: the Not using slash the
 * source strip draws for a declined source, and the words, in the neutral
 * token — never amber, never "never". `ReportFreshness` and the asset header
 * draw this one mark.
 */
export function NoNightlyReport() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
      title="Sends no nightly report"
      data-nightly-report="none"
    >
      <CircleSlash2 aria-hidden className="size-3" />
      No report
    </span>
  );
}
