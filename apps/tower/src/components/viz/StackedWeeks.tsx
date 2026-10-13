import { useState, type CSSProperties } from "react";
import { formatInt, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// Weeks as columns, each split by who did the work: a quantity over time and
// its parts at once. Contributors are neutral inks, darkest first, never a
// colour of their own, so the chart reads as one quantity; each is named
// beside the newest settled week rather than in a legend. The week still
// running is outlined and dashed, so a short last column reads as unfinished
// rather than slow.

export interface StackedWeek {
  /** The week's first day, `YYYY-MM-DD`. */
  start: string;
  /** Still running. */
  current: boolean;
  counts: Readonly<Record<string, number>>;
}

export interface StackedWeeksProps {
  weeks: readonly StackedWeek[];
  /** The contributors, bottom of each column first. */
  keys: readonly string[];
  names: Readonly<Record<string, string>>;
  /** What one unit is: "tasks". */
  unit: string;
  ariaLabel: string;
  className?: string;
}

/** Darkest at the base, where the largest contributor sits. */
const INKS = ["bg-current/85", "bg-current/55", "bg-current/35", "bg-current/15"] as const;

export function StackedWeeks({ weeks, keys, names, unit, ariaLabel, className }: StackedWeeksProps) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = weeks.map((week) => keys.reduce((sum, key) => sum + (week.counts[key] ?? 0), 0));
  const top = Math.max(1, ...totals);
  const settled = weeks.findLastIndex((week) => !week.current);
  const shown = hover === null ? null : weeks[hover] ?? null;
  const ink = (index: number) => INKS[Math.min(index, INKS.length - 1)]!;
  // Each contributor named at the middle of its share of the newest settled week.
  let floor = 0;
  const labels = settled < 0 ? [] : keys.map((key, index) => {
    const value = weeks[settled]!.counts[key] ?? 0;
    const middle = floor + value / 2;
    floor += value;
    return { key, index, value, at: (middle / top) * 100 };
  }).filter((label) => label.value > 0);
  // Labels nearer than a line apart would overlap; push each above the last.
  for (let index = 1; index < labels.length; index++) {
    labels[index]!.at = Math.max(labels[index]!.at, labels[index - 1]!.at + 14);
  }

  return (
    <div className={cn("@container/weeks flex flex-col gap-2", className)} data-stacked-weeks="" onPointerLeave={() => setHover(null)}>
      <div className="flex min-h-0 flex-1 gap-3">
        <div role="img" aria-label={weeksSummary(ariaLabel, weeks, totals, keys, names, unit)} className="relative flex min-h-36 min-w-0 flex-1 gap-1.5 pt-5 @lg/weeks:gap-3 text-foreground">
          {weeks.map((week, index) => {
            const total = totals[index]!;
            const height = (total / top) * 100;
            return (
              <div
                key={week.start}
                aria-hidden
                data-week={week.start}
                data-state={week.current ? "counting" : index === settled ? "newest" : "settled"}
                onPointerEnter={() => setHover(index)}
                className="relative h-full min-w-0 flex-1"
              >
                <span
                  className={cn("viz-grow-y absolute inset-x-0 bottom-0 flex flex-col-reverse overflow-hidden rounded-t-sm", week.current && "outline-1 -outline-offset-1 outline-dashed outline-muted-foreground/70")}
                  style={{ height: `${height}%`, "--viz-i": index } as CSSProperties}
                >
                  {keys.map((key, keyIndex) => {
                    const value = week.counts[key] ?? 0;
                    if (value === 0 || total === 0) return null;
                    return (
                      <span
                        key={key}
                        data-segment={key}
                        className={cn("block w-full shrink-0", week.current ? "bg-current/15" : ink(keyIndex), hover === index && !week.current && "brightness-110")}
                        style={{ height: `${(value / total) * 100}%` }}
                      />
                    );
                  })}
                </span>
                <span className="absolute inset-x-0 text-center text-micro tabular-nums text-muted-foreground" style={{ bottom: `calc(${height}% + 2px)` }}>
                  {formatInt(total)}
                </span>
              </div>
            );
          })}
        </div>
        {labels.length > 0 ? (
          <div aria-hidden className="relative hidden w-28 shrink-0 pt-5 @md/weeks:block" data-weeks-labels="">
            <div className="absolute inset-x-0 bottom-0 top-5">
              {labels.map((label) => (
                <span
                  key={label.key}
                  className="absolute inset-x-0 flex translate-y-1/2 items-center gap-1.5 text-xs"
                  style={{ bottom: `${Math.min(label.at, 100)}%` }}
                >
                  <span className={cn("size-2 shrink-0 rounded-[2px] text-foreground", ink(label.index))} />
                  <span className="min-w-0 font-medium leading-tight text-foreground [overflow-wrap:anywhere]">{names[label.key] ?? label.key}</span>
                  <span className="tabular-nums text-muted-foreground">{formatInt(label.value)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div aria-hidden className="flex gap-1.5 @lg/weeks:gap-3 @md/weeks:pr-[7.75rem] text-micro tabular-nums text-muted-foreground">
        {shown ? (
          <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">
            Week of {formatSeriesDate(shown.start)} · {keys.filter((key) => (shown.counts[key] ?? 0) > 0)
              .map((key) => `${names[key] ?? key} ${formatInt(shown.counts[key]!)}`).join(" · ") || `no ${unit}`}
            {shown.current ? " · still counting" : ""}
          </span>
        ) : weeks.map((week, index) => (
          <span key={week.start} className="min-w-0 flex-1 whitespace-nowrap text-center">
            {index === weeks.length - 1 ? "This week" : index % 2 === weeks.length % 2 ? "" : formatSeriesDate(week.start)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The chart in words: its span, the newest settled week by contributor and the week still counting. */
export function weeksSummary(
  label: string,
  weeks: readonly StackedWeek[],
  totals: readonly number[],
  keys: readonly string[],
  names: Readonly<Record<string, string>>,
  unit: string,
): string {
  if (weeks.length === 0) return `${label}: no weeks yet`;
  const parts = [`${label}, weeks of ${formatSeriesDate(weeks[0]!.start)} to ${formatSeriesDate(weeks.at(-1)!.start)}`];
  const settled = weeks.findLastIndex((week) => !week.current);
  if (settled >= 0) {
    const split = keys.filter((key) => (weeks[settled]!.counts[key] ?? 0) > 0)
      .map((key) => `${names[key] ?? key} ${formatInt(weeks[settled]!.counts[key]!)}`).join(", ");
    parts.push(`week of ${formatSeriesDate(weeks[settled]!.start)} ${formatInt(totals[settled]!)} ${unit}${split ? ` (${split})` : ""}`);
  }
  const current = weeks.findIndex((week) => week.current);
  if (current >= 0) parts.push(`this week so far ${formatInt(totals[current]!)}`);
  return parts.join("; ");
}
