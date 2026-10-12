import { useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { SurfaceAnnotation, SurfaceSpan } from "@shared/surface";
import { ChartEventMarkers } from "@/components/ChartEventMarkers";
import { axisLabelWidth } from "@/components/surface/HeroChart";
import { FitLabel } from "@/components/viz/FitLabel";
import { formatCalendarRange, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dateRange, landmarks, type Measure, type MeasureDay, type MeasureGap } from "@/routes/asset-detail/overview-measures";

// The Overview's hero chart: one measure's days as bars over the page's range,
// read against its yardstick (the window before it as a dashed level, or an
// alert rule's normal as a band), with what happened on the same axis: shipped
// changes marked above the plot, and the alert, the windows being watched and
// the days nobody reported shaded in it and named in lanes under the axis. The
// newest complete day wears the measure's ink and the best and lowest days are
// named at their bars, so the picture reads before any number does.

export interface OverviewChartProps {
  measure: Measure;
  /** The measure's identity ink: `text-financial-revenue`, `text-traffic`. */
  tone: string;
  changes: readonly SurfaceAnnotation[];
  /** Windows being watched on this measure. */
  watches: readonly SurfaceSpan[];
  /** Where the alert drawn on this measure opens. */
  alertTo?: string;
  /** The header's one link out, at its right. */
  action?: ReactNode;
  className?: string;
}

type BarState = "settled" | "now" | "alert" | "counting" | "partial" | "missed" | "none";

const ALERT_INK = { error: "text-error", warn: "text-warn" } as const;

/** A scale top a short axis label states exactly. */
function niceTop(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((one) => value / power <= one) ?? 10;
  return step * power;
}

/** Inclusive index range of a span on the drawn days; null when it misses them. */
function placed(days: readonly MeasureDay[], start: string, end: string): { from: number; to: number } | null {
  if (days.length === 0 || end < days[0]!.t || start > days.at(-1)!.t) return null;
  const from = days.findIndex((day) => day.t >= start);
  const to = days.findLastIndex((day) => day.t <= end);
  return from < 0 || to < from ? null : { from, to };
}

function gapWords(gap: MeasureGap): string {
  return `${gap.who ? `${gap.who} not reported` : "Not reported"} · ${dateRange(gap.start, gap.end)}`;
}

export function OverviewChart({ measure, tone, changes, watches, alertTo, action, className }: OverviewChartProps) {
  const instructions = useId();
  const [active, setActive] = useState<number | null>(null);
  const { days, provisionalFrom, alert, usual, normal, gaps, format, axis } = measure;
  const n = days.length;
  const { best, worst, newest } = landmarks(measure);
  const values = days.flatMap((day) => (day.v === null ? [] : [day.v]));
  const top = niceTop(Math.max(...values, usual?.value ?? 0, normal?.high ?? 0, 0) * 1.15);
  const ticks = [0, top / 2, top];
  const gutter = Math.max(...ticks.map((tick) => axisLabelWidth(axis(tick))));
  const y = (value: number) => `${Math.min(100, Math.max(0, (value / top) * 100))}%`;
  const x = (index: number) => ((index + 0.5) / n) * 100;
  const left = (index: number) => `${(index / n) * 100}%`;
  const width = (from: number, to: number) => `${((to - from + 1) / n) * 100}%`;
  const alertAt = alert ? placed(days, alert.since, days.at(-1)!.t) : null;
  const watchAt = watches.flatMap((span) => {
    const at = placed(days, span.start, span.end);
    return at ? [{ span, at }] : [];
  });
  const gapAt = gaps.flatMap((gap) => {
    const at = placed(days, gap.start, gap.end);
    return at ? [{ gap, at }] : [];
  });
  const marks = changes
    .flatMap((change) => {
      const index = days.findIndex((day) => day.t === change.date);
      return index < 0 ? [] : [{ change, index }];
    })
    .sort((a, b) => a.index - b.index);

  const stateOf = (day: MeasureDay, index: number): BarState => {
    if (day.v === null) return day.missing.length > 0 ? "missed" : "none";
    if (day.missing.length > 0) return "partial";
    if (provisionalFrom !== null && day.t >= provisionalFrom) return "counting";
    if (day === newest) return "now";
    if (alertAt && index >= alertAt.from) return "alert";
    return "settled";
  };
  // An alert older than the range says when it began rather than start at the edge.
  const alertWords = alert ? `${alert.onset < days[0]!.t ? `Since ${formatSeriesDate(alert.onset)} · ` : ""}${alert.headline}` : "";
  const nowInk = alert && alertAt && newest && days.indexOf(newest) >= alertAt.from ? ALERT_INK[alert.severity] : tone;

  const summary = [
    `${measure.name}, ${formatCalendarRange(days[0]!.t, days.at(-1)!.t)}`,
    newest ? `newest ${formatSeriesDate(newest.t)} ${format(newest.v!)}` : null,
    best ? `best ${formatSeriesDate(best.t)} ${format(best.v!)}` : null,
    worst ? `lowest ${formatSeriesDate(worst.t)} ${format(worst.v!)}` : null,
    usual ? usual.label : null,
    normal ? `normal range ${format(normal.low)} to ${format(normal.high)}` : null,
    alert ? `alert since ${formatSeriesDate(alert.onset)}: ${alert.headline}` : null,
    ...gaps.map(gapWords),
  ].filter(Boolean).join("; ");

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") return setActive(null);
    if (event.key === "Home") return setActive(0);
    if (event.key === "End") return setActive(n - 1);
    const from = active ?? n - 1;
    setActive(Math.max(0, Math.min(n - 1, from + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    setActive(Math.max(0, Math.min(n - 1, Math.floor(((event.clientX - box.left) / box.width) * n))));
  };

  // A label beside each change's mark while the next mark leaves room for it.
  const labelled = marks.filter((mark, i) => {
    const next = marks[i + 1];
    return !next || x(next.index) - x(mark.index) >= 22;
  });

  return (
    <figure data-overview-chart={measure.key} className={cn("@container m-0 flex min-w-0 flex-col gap-3", className)}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-foreground">{measure.name}</span>
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatCalendarRange(days[0]!.t, days.at(-1)!.t)}</span>
          {measure.sources.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground" data-overview-chart-key="">
              <span aria-hidden className={cn("h-2.5 w-1.5 rounded-[1px] bg-current", tone)} />
              {measure.sources.join(" + ")}
            </span>
          ) : null}
        </span>
        {action}
      </figcaption>

      <div className="flex gap-2">
        <div aria-hidden className="shrink-0" style={{ width: gutter }}>
          <div className="h-5" />
          <div className="relative h-44 @3xl:h-56">
            {ticks.map((tick) => (
              <span key={tick} className="absolute right-0 translate-y-1/2 whitespace-nowrap text-micro tabular-nums text-muted-foreground" style={{ bottom: y(tick) }}>
                {axis(tick)}
              </span>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative">
        {/* Shipped changes: a mark above the plot that opens its own note. */}
        <div aria-hidden className="relative h-5">
          {labelled.map(({ change, index }) => (
            <FitLabel
              key={`${change.date}-${change.label}`}
              data-overview-change-label=""
              className={cn("pointer-events-none absolute top-0 hidden max-w-[40%] text-micro text-muted-foreground @xl:block", x(index) > 70 && "-translate-x-full")}
              style={{ left: x(index) > 70 ? `calc(${x(index)}% - 14px)` : `calc(${x(index)}% + 14px)` }}
            >
              {change.label}
            </FitLabel>
          ))}
        </div>

        <div
          className="relative h-44 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring @3xl:h-56"
          tabIndex={0}
          role="group"
          aria-label={`${measure.name} by day, ${formatSeriesDate(days[0]!.t)} to ${formatSeriesDate(days.at(-1)!.t)}`}
          aria-describedby={instructions}
          onKeyDown={step}
          onFocus={(event) => { if (event.target === event.currentTarget) setActive((current) => current ?? n - 1); }}
          onBlur={() => setActive(null)}
          onPointerMove={point}
          onPointerDown={point}
          onPointerLeave={(event) => { if (event.pointerType !== "touch") setActive(null); }}
        >
          {ticks.map((tick) => (
            <span key={tick} aria-hidden className="absolute inset-x-0 border-t border-viz-grid" style={{ bottom: y(tick) }} />
          ))}

          {watchAt.map(({ span, at }) => (
            <span key={`watch-${span.start}-${span.label}`} aria-hidden data-overview-span="watch"
              className="absolute inset-y-0 border-x border-dashed border-muted-foreground/40 bg-foreground/[0.04]"
              style={{ left: left(at.from), width: width(at.from, at.to) }} />
          ))}
          {gapAt.filter(({ gap }) => gap.partial).map(({ gap, at }) => (
            <span key={`gap-${gap.start}`} aria-hidden data-overview-span="partial"
              className="viz-hatch absolute inset-y-0 text-muted-foreground"
              style={{ left: left(at.from), width: width(at.from, at.to) }} />
          ))}
          {alert && alertAt ? (
            <span aria-hidden data-overview-span="alert"
              className={cn("absolute inset-y-0 border-t-2 border-l border-current bg-current/10", ALERT_INK[alert.severity])}
              style={{ left: left(alertAt.from), width: width(alertAt.from, alertAt.to) }} />
          ) : null}

          {normal ? (
            <span aria-hidden data-overview-normal=""
              className="absolute inset-x-0 border-y border-muted-foreground/30 bg-muted-foreground/15"
              style={{ bottom: y(normal.low), height: `calc(${y(normal.high)} - ${y(normal.low)})` }} />
          ) : null}

          <div role="img" aria-label={summary} className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0,1fr))` }}>
            {days.map((day, index) => {
              const state = stateOf(day, index);
              const lit = active === index;
              return (
                <span key={day.t} aria-hidden data-overview-day={day.t} data-state={state}
                  className={cn("relative flex h-full items-end justify-center", n > 45 ? "px-[8%]" : "px-[16%]")}>
                  {state === "missed" ? (
                    <span className="viz-hatch h-full w-full rounded-xs text-muted-foreground" />
                  ) : state === "none" ? null : (
                    <span
                      className={cn(
                        "viz-grow-y block w-full rounded-t-[3px]",
                        day.v === 0 && "h-0.5 rounded-none",
                        state === "settled" && cn("text-spark", lit ? "bg-current/70" : "bg-current/35"),
                        state === "alert" && cn(ALERT_INK[alert!.severity], lit ? "bg-current" : "bg-current/60"),
                        state === "now" && cn(nowInk, "viz-glow bg-current"),
                        state === "counting" && cn(tone, "chart-bar-provisional bg-current/15"),
                        state === "partial" && cn("text-spark border border-current", lit ? "bg-current/40" : "bg-current/15"),
                      )}
                      style={day.v === 0 ? ({ "--viz-i": index } as CSSProperties) : ({ height: y(day.v!), "--viz-i": index } as CSSProperties)}
                    />
                  )}
                </span>
              );
            })}
          </div>

          {usual ? (
            <>
              <span aria-hidden data-overview-usual="" className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted-foreground/80" style={{ bottom: y(usual.value) }} />
              <span aria-hidden className="pointer-events-none absolute left-1 rounded-xs bg-card/85 px-1 text-micro whitespace-nowrap text-muted-foreground" style={{ bottom: `calc(${y(usual.value)} + 2px)` }}>
                {usual.label}
                {normal ? ` · range ${format(normal.low)}–${format(normal.high)}` : ""}
              </span>
            </>
          ) : null}

          {marks.map(({ change, index }) => (
            <span key={`line-${change.date}-${change.label}`} aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l border-dashed border-chart-distorted/70"
              style={{ left: `${x(index)}%` }} />
          ))}

          <Landmarks days={days} best={best} worst={worst} newest={newest} x={x} y={y} format={format} nowInk={nowInk} />

          {active !== null && days[active] ? (
            <Readout
              subject={`readout:${instructions}`}
              day={days[active]}
              at={x(active)}
              measure={measure}
              counting={provisionalFrom !== null && days[active].t >= provisionalFrom}
              spans={[
                ...(alert && alertAt && active >= alertAt.from ? ["Alert open"] : []),
                ...watchAt.filter(({ at }) => active >= at.from && active <= at.to).map(({ span }) => span.label),
              ]}
              changes={marks.filter((mark) => mark.index === active).map((mark) => mark.change.label)}
            />
          ) : null}
        </div>

        {/* The marks' own layer spans the lane and the plot, so a mark opens
            from its glyph or anywhere along its line. */}
        {marks.length > 0 ? (
          <ChartEventMarkers lineTargets events={marks.map(({ change, index }) => ({ ...change, position: x(index) }))} />
        ) : null}
        </div>

        <div aria-hidden className="relative mt-1 flex h-4 justify-between text-micro tabular-nums text-muted-foreground">
          <span className="whitespace-nowrap">{formatSeriesDate(days[0]!.t)}</span>
          {n > 6 ? <span className="whitespace-nowrap">{formatSeriesDate(days[Math.floor((n - 1) / 2)]!.t)}</span> : null}
          <span className="whitespace-nowrap">{formatSeriesDate(days.at(-1)!.t)}</span>
        </div>

        {alert && alertAt ? (
          <Lane at={[alertAt]} n={n} ink={ALERT_INK[alert.severity]} kind="alert">
            {alertTo ? (
              <Link to={alertTo} className="pointer-events-auto rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                {alertWords}
              </Link>
            ) : alertWords}
          </Lane>
        ) : null}
        {watchAt.map(({ span, at }) => (
          <Lane key={`watch-row-${span.start}-${span.label}`} at={[at]} n={n} ink="text-muted-foreground" kind="watch">
            {span.label}
          </Lane>
        ))}
        {gapAt.length > 0 ? (
          <Lane at={gapAt.map(({ at }) => at)} n={n} ink="text-muted-foreground" kind="gap">
            {gapWords([...gapAt].sort((a, b) => b.gap.days - a.gap.days)[0]!.gap)}
            {gapAt.length > 1 ? ` · ${gapAt.length - 1} more` : ""}
          </Lane>
        ) : null}
        </div>
      </div>
      <span id={instructions} className="sr-only">Arrow keys step through the days; Home and End jump; Escape clears.</span>
    </figure>
  );
}

/** The best, the lowest and the newest complete day, named at their bars. */
function Landmarks({ days, best, worst, newest, x, y, format, nowInk }: {
  days: readonly MeasureDay[];
  best: MeasureDay | null;
  worst: MeasureDay | null;
  newest: MeasureDay | null;
  x: (index: number) => number;
  y: (value: number) => string;
  format: (value: number) => string;
  nowInk: string;
}) {
  const labels: { day: MeasureDay; text: string; ink: string; strong: boolean }[] = [];
  if (best) labels.push({ day: best, text: `Best · ${formatSeriesDate(best.t)} · ${format(best.v!)}`, ink: "text-foreground", strong: false });
  if (worst && worst !== newest) labels.push({ day: worst, text: `Lowest · ${formatSeriesDate(worst.t)} · ${format(worst.v!)}`, ink: "text-muted-foreground", strong: false });
  if (newest && newest !== best) {
    labels.push({ day: newest, text: newest === worst ? `Lowest · ${format(newest.v!)}` : format(newest.v!), ink: nowInk, strong: true });
  }
  return (
    <>
      {labels.map(({ day, text, ink, strong }) => {
        const at = x(days.indexOf(day));
        return (
          <span
            key={`${day.t}-${text}`}
            aria-hidden
            data-overview-landmark=""
            className={cn(
              "pointer-events-none absolute rounded-xs bg-card/85 px-1 whitespace-nowrap tabular-nums",
              strong ? "text-xs font-semibold" : "text-micro font-medium",
              ink,
              at > 85 ? "-translate-x-full" : at >= 15 && "-translate-x-1/2",
            )}
            style={{ left: at > 85 ? `calc(${at}% + 4px)` : at < 15 ? `calc(${at}% - 4px)` : `${at}%`, bottom: `calc(${y(day.v!)} + 4px)` }}
          >
            {text}
          </span>
        );
      })}
    </>
  );
}

/** One span's extent under the axis, with its name at its start. */
function Lane({ at, n, ink, kind, children }: {
  at: readonly { from: number; to: number }[];
  n: number;
  ink: string;
  kind: "alert" | "watch" | "gap";
  children: ReactNode;
}) {
  const first = at[0]!;
  const start = (first.from / n) * 100;
  const end = ((first.to + 1) / n) * 100;
  // A span that starts late in the window names itself leftward from its end.
  const fromEnd = start > 55;
  return (
    <div data-overview-lane={kind} className={cn("relative h-5 text-micro", ink)}>
        {at.map((one) => (
          <span key={one.from} aria-hidden
            className={cn("absolute top-0 h-1.5 border-x border-b border-current/60", kind === "gap" && "viz-hatch border-dashed")}
            style={{ left: `${(one.from / n) * 100}%`, width: `${((one.to - one.from + 1) / n) * 100}%` }} />
        ))}
        <FitLabel
          className={cn("absolute top-1.5 max-w-full font-medium", fromEnd && "text-end")}
          style={fromEnd ? { right: `${100 - end}%`, maxWidth: `${end}%` } : { left: `${start}%`, maxWidth: `${100 - start}%` }}
        >
          {kind === "alert" ? <span aria-hidden>△ </span> : kind === "watch" ? <span aria-hidden>◦ </span> : null}
          {children}
        </FitLabel>
    </div>
  );
}

function Readout({ subject, day, at, measure, counting, spans, changes }: {
  subject: string;
  day: MeasureDay;
  at: number;
  measure: Measure;
  counting: boolean;
  spans: readonly string[];
  changes: readonly string[];
}) {
  const value = day.v === null
    ? day.missing.length > 0 ? "not reported" : "nothing owed yet"
    : `${measure.format(day.v)}${measure.unit ? ` ${measure.unit}` : ""}`;
  return (
    <div
      role="status"
      data-status-for={subject}
      aria-atomic="true"
      className="pointer-events-none absolute top-1 z-10 grid min-w-36 max-w-64 -translate-x-1/2 gap-0.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs tabular-nums text-muted-foreground shadow-sm"
      style={{ left: `${Math.min(84, Math.max(16, at))}%` }}
    >
      <span className="font-semibold text-foreground">{formatSeriesDate(day.t)}</span>
      <span>
        <span className="font-semibold text-foreground">{value}</span>
        {counting ? " · still counting" : ""}
        {day.v !== null && day.missing.length > 0 ? ` · ${day.missing.join(" and ")} not reported` : ""}
      </span>
      {[...spans, ...changes].map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}
