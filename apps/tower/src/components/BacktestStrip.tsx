import type { ReactNode } from "react";
import { CalendarOff, TriangleAlert } from "lucide-react";
import type { RuleBacktest, RuleBacktestDay } from "@noticeos/contract";
import { cn } from "@/lib/utils";

export interface BacktestStripProps {
  backtest: RuleBacktest;
  className?: string;
}

/**
 * WHAT A RULE SETTING WOULD HAVE DONE, as a shape (bead `ro-u072`).
 *
 * docs/15 principle 1 asks a rule edit to show "would have fired 3 times in the
 * last 30 days" before it saves. That sentence alone is not enough to decide
 * with, which is the doc 14 visuals rule in one line: three firings clustered in
 * one bad week is an incident that is now over, and three spread across the
 * month is a rule that will interrupt the operator again on Thursday. Same
 * number, opposite decisions. The strip is the thirty days laid out in order, so
 * WHERE is answered beside HOW MANY.
 *
 * TWO TRACKS, and the second one is the point. The upper track is the REPLAY —
 * what these settings would do. The lower track is REALITY — the days this rule
 * actually fired on, from stored `flags`. Reading them against each other
 * answers the question a pair of totals cannot: is the candidate quieter
 * everywhere, or quieter only on the days that were already the worst?
 *
 * NEUTRAL INK, on purpose. A replayed firing is not an open alert and a settled
 * one is not attention, so neither track may spend the severity palette (doc 14:
 * attention color is reserved for attention; the `chart-distorted` mark makes
 * the same choice). The two tracks are told apart by POSITION and shape, never
 * by an opacity step — the difference a screen across a room cannot carry.
 *
 * FOUR STATES, because "it did not fire" hides three different facts and a strip
 * that drew them alike would claim evidence nobody has: it ran and stayed quiet,
 * it could not run (no same-weekday cohort yet, or the metric was outside this
 * rule's volume regime), or the asset filed no pulse at all. A day with no
 * report is drawn as a HOLE, never as a quiet day (docs/17 rule 6: missing says
 * missing, and no derived visual is drawn over the hole).
 *
 * NO DISTORTED-DAY MARKS, deliberately. Those belong to provider-bucketed series
 * (doc 14, `distortedByTimeZoneChange`); this strip draws stored PULSE days, an
 * asset reporting its own counters, which a provider's reporting-timezone move
 * does not touch — the same boundary `packages/contract/src/rules.ts` states for
 * the baselines these days are judged against.
 */
export function BacktestStrip({ backtest, className }: BacktestStripProps) {
  const { days, wouldFire, firedInStore, judged, reported, windowDays } = backtest;

  if (reported === 0) {
    return (
      <div
        className={cn("flex items-center gap-2 text-xs leading-snug", className)}
        data-backtest-strip="no-reports"
      >
        <CalendarOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          No reports in the last <span className="tabular-nums">{windowDays}</span> days
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-backtest-strip={judged === 0 ? "unjudged" : "judged"}
    >
      {/* THE HEADLINE IS THE STATE (bead `ro-ujb9.96.6.7`). With no day
          judged, "Would have fired 0 times" is the one reading this strip must
          never give — it looks like a quiet rule — so the headline says the
          replay could not answer, and the dashed cells below show where. Why a
          given day could not be judged is on that day's hover. */}
      {judged === 0 ? (
        <p
          className="flex items-center gap-1.5 text-sm text-foreground"
          data-backtest-note="unjudged"
        >
          <TriangleAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          Not enough history to replay
        </p>
      ) : (
        <p className="text-sm text-foreground">
          Would have fired{" "}
          <span className="font-semibold tabular-nums">{wouldFire}</span>{" "}
          {wouldFire === 1 ? "time" : "times"} in the last{" "}
          <span className="tabular-nums">{windowDays}</span> days
        </p>
      )}

      <ol
        className="flex w-full items-stretch overflow-hidden rounded-sm"
        aria-label={`Each of the last ${windowDays} days, oldest first`}
        data-backtest-days
      >
        {days.map((day) => (
          <DayCell key={day.date} day={day} shaded={shaded(day.date, days)} />
        ))}
      </ol>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-backtest-reality>
          It really fired{" "}
          <span className="tabular-nums text-foreground">{firedInStore}</span>{" "}
          {firedInStore === 1 ? "time" : "times"}
        </span>
        <span aria-hidden>·</span>
        <span data-backtest-judged>
          <span className="tabular-nums">{judged}</span> of{" "}
          <span className="tabular-nums">{windowDays}</span> days could be judged
        </span>
      </p>

      <Legend />
    </div>
  );
}

/** The four marks, named. Words for the marks and nothing else — the counts are
 * stated once above, and a legend that repeated them would be the same facts
 * twice (doc 14, one representation per fact). */
function Legend() {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-wall-detail text-muted-foreground"
      data-backtest-legend
    >
      <LegendItem label="would fire">
        <span className="block h-3 w-1.5 rounded-[1px] bg-foreground" />
      </LegendItem>
      <LegendItem label="quiet">
        <span className="mt-auto block h-1 w-1.5 rounded-[1px] bg-muted-foreground/40" />
      </LegendItem>
      <LegendItem label="not judged">
        <span className="block h-3 w-1.5 rounded-[1px] border border-dashed border-border" />
      </LegendItem>
      <LegendItem label="no report">
        <span className="mt-auto block h-px w-1.5 bg-border" />
      </LegendItem>
      <LegendItem label="really fired">
        <span className="mt-auto block h-1 w-1.5 bg-muted-foreground" />
      </LegendItem>
    </ul>
  );
}

function LegendItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className="flex h-3 w-1.5 shrink-0 flex-col" aria-hidden>
        {children}
      </span>
      {label}
    </li>
  );
}

/** One day: the replay above the baseline, what really happened below it. */
function DayCell({ day, shaded }: { day: RuleBacktestDay; shaded: boolean }) {
  return (
    <li
      className={cn("flex min-w-[5px] flex-1 flex-col px-px", shaded && "bg-chart-week-band")}
      title={dayTitle(day)}
      data-backtest-day={day.state}
      data-backtest-stored={day.stored ? "" : undefined}
    >
      <span className="flex h-5 flex-col justify-end" aria-hidden>
        {day.state === "fired" ? (
          <span className="block h-full w-full rounded-[1px] bg-foreground" />
        ) : day.state === "quiet" ? (
          <span className="block h-1 w-full rounded-[1px] bg-muted-foreground/40" />
        ) : day.state === "unjudged" ? (
          <span className="block h-full w-full rounded-[1px] border border-dashed border-border" />
        ) : (
          <span className="block h-px w-full bg-border" />
        )}
      </span>
      <span className="mt-px flex h-1" aria-hidden>
        {day.stored ? <span className="block h-full w-full bg-muted-foreground" /> : null}
      </span>
    </li>
  );
}

/** The hover, which is where the words live: a mark and never a word on the
 * strip itself, the same shape docs/17 sets for the distorted-day mark. */
function dayTitle(day: RuleBacktestDay): string {
  const replay =
    day.state === "fired"
      ? `would fire — ${day.firings.map((firing) => firing.metric).join(", ")}`
      : day.state === "quiet"
        ? "would stay quiet"
        : day.state === "no-report"
          ? "no report filed"
          : day.reason === "out-of-regime"
            ? "not judged — the metric was outside this rule's volume range"
            : "not judged — fewer than four matching weekdays behind it";
  return `${day.date}: ${replay}${day.stored ? " · really fired" : ""}`;
}

/**
 * Sunday–Saturday calendar-week banding, with the NEWEST week unshaded and
 * parity alternating backwards from it (doc 14). Anchoring on the newest week
 * rather than the first visible date is what keeps the bands meaning "weeks"
 * rather than "seven cells from wherever this window happens to start".
 */
function shaded(date: string, days: RuleBacktestDay[]): boolean {
  const newest = days[days.length - 1]?.date;
  if (!newest) return false;
  return (sundayWeek(newest) - sundayWeek(date)) % 2 === 1;
}

/** The Sunday-start week a `YYYY-MM-DD` day falls in, as an integer. 1970-01-01
 * was a Thursday, hence the +4. */
function sundayWeek(date: string): number {
  const dayNumber = Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
  return Math.floor((dayNumber + 4) / 7);
}
