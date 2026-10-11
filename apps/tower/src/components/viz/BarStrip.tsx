import { useState, type CSSProperties } from "react";
import { formatInt, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// A short run of days as bars: the newest settled day in the series' own ink,
// the days before it in neutral ink, an optional dashed baseline (the usual
// level) across them. The eye reads "where does today sit in its recent
// history" before it reads a number. A day still being counted is hatched, a
// day nobody reported is an empty slot, and a measured zero is a stub, so none
// of the three can pass for another.

export interface BarStripPoint {
  t: string;
  /** null: nobody reported this day. */
  v: number | null;
}

export interface BarStripProps {
  data: readonly BarStripPoint[];
  /** The series' identity ink for the highlighted bar: `text-financial-revenue`,
   * `text-traffic`. The other bars are neutral. */
  tone: string;
  /** Which bar is "now": the newest settled day by default. */
  highlight?: string;
  /** The first day the provider has not finished counting. */
  provisionalFrom?: string | null;
  /** The usual level, drawn as a dashed rule with its label at the right. */
  baseline?: { value: number; label: string } | null;
  format?: (value: number) => string;
  /** What the strip shows, in the operator's words: "Revenue a day, last 14 days". */
  ariaLabel: string;
  className?: string;
}

export function BarStrip({
  data,
  tone,
  highlight,
  provisionalFrom = null,
  baseline = null,
  format = formatInt,
  ariaLabel,
  className,
}: BarStripProps) {
  const [hover, setHover] = useState<number | null>(null);
  const settled = data.filter((point) => point.v !== null && (provisionalFrom === null || point.t < provisionalFrom));
  const now = highlight ?? settled.at(-1)?.t ?? null;
  const values = data.map((point) => point.v ?? 0);
  const top = Math.max(...values, baseline?.value ?? 0, 1);
  const shown = hover === null ? null : data[hover] ?? null;
  const nowPoint = data.find((point) => point.t === now) ?? null;

  return (
    <div
      className={cn("relative flex h-12 flex-col", className)}
      data-bar-strip=""
      onPointerLeave={() => setHover(null)}
    >
      <div role="img" aria-label={stripSummary(ariaLabel, data, nowPoint, baseline, format)} className={cn("relative flex min-h-0 flex-1 items-end", data.length > 20 ? "gap-0.5" : "gap-1")}>
        {data.map((point, index) => {
          const provisional = provisionalFrom !== null && point.t >= provisionalFrom;
          const isNow = point.t === now;
          const height = point.v === null ? 100 : Math.max(0, (point.v / top) * 100);
          return (
            <span
              key={point.t}
              aria-hidden
              data-bar={point.t}
              data-state={point.v === null ? "unreported" : provisional ? "provisional" : isNow ? "now" : "settled"}
              onPointerEnter={() => setHover(index)}
              className={cn(
                "relative flex h-full min-w-0 flex-1 items-end",
                point.v === null && "rounded-xs text-muted-foreground/60 viz-hatch",
              )}
            >
              {point.v === null ? null : (
                <span
                  className={cn(
                    "viz-grow-y block w-full rounded-t-xs",
                    // A measured zero is a stub on the floor, never an empty slot.
                    point.v === 0 ? "h-0.5 bg-muted-foreground/50" : undefined,
                    isNow ? tone : "text-spark",
                    provisional ? "chart-bar-provisional bg-current/20" : point.v === 0 ? undefined : isNow ? "bg-current viz-glow" : "bg-current/30",
                    hover === index && !isNow && "bg-current/60",
                  )}
                  style={point.v === 0 ? ({ "--viz-i": index } as CSSProperties) : ({ height: `${height}%`, "--viz-i": index } as CSSProperties)}
                />
              )}
            </span>
          );
        })}
        {baseline ? (
          <span
            aria-hidden
            data-bar-baseline=""
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted-foreground/70"
            style={{ bottom: `${(baseline.value / top) * 100}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-micro tabular-nums text-muted-foreground" aria-hidden>
        {shown ? (
          <span className="truncate text-foreground">
            {formatSeriesDate(shown.t)} · {shown.v === null ? "not reported" : format(shown.v)}
            {provisionalFrom !== null && shown.t >= provisionalFrom ? " · still counting" : ""}
          </span>
        ) : (
          <>
            <span className="whitespace-nowrap">{data[0] ? formatSeriesDate(data[0].t) : ""}</span>
            {baseline ? <span className="truncate">{baseline.label}</span> : null}
            <span className="whitespace-nowrap">{data.at(-1) ? formatSeriesDate(data.at(-1)!.t) : ""}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** The strip in words, for a reader who cannot see it: its span, the
 * highlighted day and the usual level. */
export function stripSummary(
  label: string,
  data: readonly BarStripPoint[],
  now: BarStripPoint | null,
  baseline: { value: number; label: string } | null,
  format: (value: number) => string,
): string {
  if (data.length === 0) return `${label}: nothing reported yet`;
  const parts = [`${label}, ${formatSeriesDate(data[0]!.t)} to ${formatSeriesDate(data.at(-1)!.t)}`];
  if (now && now.v !== null) parts.push(`${formatSeriesDate(now.t)} ${format(now.v)}`);
  if (baseline) parts.push(`usual ${format(baseline.value)}`);
  const missing = data.filter((point) => point.v === null).length;
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? "day" : "days"} not reported`);
  return parts.join("; ");
}
