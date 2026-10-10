import type { ReactNode } from "react";
import { CalendarOff, TriangleAlert } from "lucide-react";
import type { RuleBacktest, RuleBacktestDay } from "@noticeos/contract";
import { cn } from "@/lib/utils";

export interface BacktestStripProps {
  backtest: RuleBacktest;
  className?: string;
}

/**
 * What a rule setting would have done over thirty days, as a shape: three
 * firings in one bad week and three spread across the month are the same
 * count and opposite decisions. The upper track replays the candidate
 * settings; the lower is the days the rule actually fired, from stored `flags`.
 * Neutral ink, since neither is open attention; the tracks differ by position.
 * Four day states: quiet, fired, could not run, and no report (a hole, never a
 * quiet day). No distorted-day marks: pulse days are the asset's own counters,
 * untouched by a provider's reporting-timezone move.
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
      {/* With no day judged, "Would have fired 0 times" would read as a quiet
          rule, so the headline says the replay could not answer. */}
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

/** The four marks, named. The counts are stated once above, not repeated here. */
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

/** The hover, where the words live: the strip itself draws only marks. */
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
 * Sunday–Saturday week banding, with the newest week unshaded and parity
 * alternating backwards from it, so bands mean weeks rather than "seven cells
 * from wherever this window starts".
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
