import { useState, type CSSProperties } from "react";
import { formatInt, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// A short run of days as bars: the newest settled day in the series' own ink,
// the days before it in neutral ink, an optional dashed baseline (the usual
// level) across them. The eye reads "where does today sit in its recent
// history" before it reads a number. A day still being counted is hatched, a
// day nobody reported is an empty slot, and a measured zero is a stub, so none
// of the three can pass for another. Asset contributions, when supplied,
// split every bar into named identity colours.

export interface BarStripPoint {
  t: string;
  /** null: nobody reported this day. */
  v: number | null;
  /** Reported values by asset; absent keys are missing readings, never zero. */
  contributions?: Readonly<Record<string, number>>;
}

export interface BarStripContributor {
  id: string;
  name: string;
  tone: string;
}

export interface BarStripProps {
  data: readonly BarStripPoint[];
  /** The series' identity ink for the highlighted bar: `text-financial-revenue`,
   * `text-traffic`. The other bars are neutral. */
  tone: string;
  /** Stack every day by asset, with the same identity colours in its legend. */
  contributors?: readonly BarStripContributor[];
  /** Which bar is "now": the newest settled day by default. */
  highlight?: string;
  /** The first day the provider has not finished counting. */
  provisionalFrom?: string | null;
  /** The usual level, drawn as a dashed rule with its label at the right. */
  baseline?: { value: number; label: string } | null;
  format?: (value: number) => string;
  /** A ceiling shared with strips drawn beside this one, so two strips compare
   * bar for bar; the strip still grows past it if one of its own bars does. */
  max?: number;
  /** Days some of the series' sources did not report: drawn outlined, so a
   * short bar reads as an incomplete count rather than a bad day. */
  partial?: readonly string[];
  /** What the strip shows, in the operator's words: "Revenue a day, last 14 days". */
  ariaLabel: string;
  className?: string;
}

export function BarStrip({
  data,
  tone,
  contributors = [],
  highlight,
  provisionalFrom = null,
  baseline = null,
  format = formatInt,
  max = 0,
  partial = [],
  ariaLabel,
  className,
}: BarStripProps) {
  const [hover, setHover] = useState<number | null>(null);
  const settled = data.filter((point) => point.v !== null && (provisionalFrom === null || point.t < provisionalFrom));
  const now = highlight ?? settled.at(-1)?.t ?? null;
  const values = data.map((point) => point.v ?? 0);
  const top = Math.max(...values, baseline?.value ?? 0, max, 1);
  const shown = hover === null ? null : data[hover] ?? null;
  const nowPoint = data.find((point) => point.t === now) ?? null;
  const partialDays = new Set(partial);
  const split = (point: BarStripPoint) => contributors.flatMap((source) => {
    const value = point.contributions?.[source.id];
    return value === undefined ? [] : [`${source.name} ${format(value)}`];
  }).join(" · ");

  return (
    <>
    <div
      className={cn("@container/strip relative flex h-12 flex-col", className)}
      data-bar-strip=""
      onPointerLeave={() => setHover(null)}
    >
        <div role="img" aria-label={[stripSummary(ariaLabel, data, nowPoint, baseline, format, partialDays.size), nowPoint ? split(nowPoint) : ""].filter(Boolean).join("; ")} className={cn("relative flex min-h-0 flex-1 items-end", data.length > 20 ? "gap-0.5" : "gap-1")}>
          {data.map((point, index) => {
            const provisional = provisionalFrom !== null && point.t >= provisionalFrom;
            const incomplete = !provisional && point.v !== null && partialDays.has(point.t);
            const isNow = point.t === now;
            const height = point.v === null ? 100 : Math.max(0, (point.v / top) * 100);
            return (
              <span
                key={point.t}
                aria-hidden
                data-bar={point.t}
                title={`${formatSeriesDate(point.t)} · ${point.v === null ? "not reported" : format(point.v)}${split(point) ? ` · ${split(point)}` : ""}`}
                data-state={point.v === null ? "unreported" : provisional ? "provisional" : incomplete ? "partial" : isNow ? "now" : "settled"}
                onPointerEnter={() => setHover(index)}
                className={cn(
                  "relative flex h-full min-w-0 flex-1 items-end",
                  point.v === null && "rounded-xs text-muted-foreground/60 viz-hatch",
                )}
              >
                {point.v === null ? null : (
                  <span
                    className={cn(
                      "viz-grow-y flex w-full flex-col-reverse overflow-hidden rounded-t-xs",
                      // A measured zero is a stub on the floor, never an empty slot.
                      point.v === 0 ? "h-0.5 bg-muted-foreground/50" : undefined,
                      contributors.length > 0 ? undefined : isNow ? tone : "text-spark",
                      provisional ? "chart-bar-provisional bg-current/20" : point.v === 0 || contributors.length > 0 ? undefined : isNow ? "bg-current viz-glow" : "bg-current/30",
                      contributors.length === 0 && hover === index && !isNow && "bg-current/60",
                      incomplete && "outline-1 -outline-offset-1 outline-dashed outline-warn/80",
                    )}
                    style={point.v === 0 ? ({ "--viz-i": index } as CSSProperties) : ({ height: `${height}%`, "--viz-i": index } as CSSProperties)}
                  >
                    {contributors.map((source) => {
                      const value = point.contributions?.[source.id];
                      if (value === undefined || value <= 0 || !point.v) return null;
                      return (
                        <span
                          key={source.id}
                          data-contributor={source.id}
                          className={cn("block w-full shrink-0 bg-current", source.tone, provisional && "opacity-30")}
                          style={{ height: `${(value / point.v) * 100}%` }}
                        />
                      );
                    })}
                  </span>
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
        <div className="mt-1 flex shrink-0 items-baseline justify-between gap-2 text-micro tabular-nums text-muted-foreground" aria-hidden>
          {shown ? (
            <span className="flex min-w-0 gap-x-[0.35em] text-foreground">
              <span className="whitespace-nowrap">{formatSeriesDate(shown.t)} · {shown.v === null ? "not reported" : format(shown.v)}</span>
              {split(shown) ? <span className="truncate" title={split(shown)}>{split(shown)}</span> : null}
              {provisionalFrom !== null && shown.t >= provisionalFrom ? <>{" "}<span className="whitespace-nowrap">· still counting</span></> : partialDays.has(shown.t) ? <>{" "}<span className="whitespace-nowrap">· not every source reported</span></> : null}
            </span>
          ) : (
            <>
              <span className="whitespace-nowrap">{data[0] ? formatSeriesDate(data[0].t) : ""}</span>
              {/* Shown only where the strip has room for it beside both dates; the
                  dashed rule and the strip's name still carry it. */}
              {baseline ? <span className="hidden whitespace-nowrap @[15rem]/strip:inline">{baseline.label}</span> : null}
              <span className="whitespace-nowrap">{data.at(-1) ? formatSeriesDate(data.at(-1)!.t) : ""}</span>
            </>
          )}
        </div>
    </div>
      {contributors.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted-foreground" data-bar-legend="">
          {contributors.map((source) => (
            <span key={source.id} className="inline-flex min-w-0 items-center gap-1">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-xs bg-current", source.tone)} />
              <span className="[overflow-wrap:anywhere]">{source.name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </>
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
  partialCount = 0,
): string {
  if (data.length === 0) return `${label}: nothing reported yet`;
  const parts = [`${label}, ${formatSeriesDate(data[0]!.t)} to ${formatSeriesDate(data.at(-1)!.t)}`];
  if (now && now.v !== null) parts.push(`${formatSeriesDate(now.t)} ${format(now.v)}`);
  if (baseline) parts.push(`usual ${format(baseline.value)}`);
  const missing = data.filter((point) => point.v === null).length;
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? "day" : "days"} not reported`);
  if (partialCount > 0) parts.push(`${partialCount} ${partialCount === 1 ? "day" : "days"} missing a source`);
  return parts.join("; ");
}
