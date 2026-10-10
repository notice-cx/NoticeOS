import {
  useMemo,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_RANGE_DAYS,
  averageSeries,
  placeAnnotations,
  placeSpans,
  provisionalIndex,
  seriesGrain,
  shiftLabel,
  weekendSpans,
  type SurfaceAnnotation,
  type SurfaceSpan,
} from "@shared/surface";
import type { SeriesPoint } from "@shared/wall";
import { formatCalendarDate, formatInt, formatSeriesDate } from "@/lib/format";
import { pillControlClass } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SERIES_TONE_CLASS, type SeriesTone } from "@/components/surface/Sparkline";
import { ChartDot } from "@/components/surface/ChartMarks";
import { cn } from "@/lib/utils";
import { ChartEventMarkers } from "@/components/ChartEventMarkers";
import { InfoTooltip } from "@/components/InfoTooltip";
import { useChartLabelVisibility } from "@/hooks/useChartLabelVisibility";

export interface HeroSeries {
  /** What the legend and the toggle say. */
  name: string;
  points: readonly SeriesPoint[];
  tone?: SeriesTone;
  /** Identity, not confidence: use the same pattern in the line and its key. */
  lineStyle?: "solid" | "dashed" | "dotted";
  /** This provider's unfinished tail. Undefined inherits the chart boundary;
   * null explicitly means this series has no provisional observations. */
  provisionalFrom?: string | null;
  /** A reference the lead line is read against, not a second trend: drawn as
   * observed (never averaged), thinner, dotted and in quiet ink unless the
   * caller names a tone or pattern. */
  reference?: boolean;
}

const LINE_DASH = { solid: undefined, dashed: "8 5", dotted: "2 5" } as const;

/** Line weights in screen pixels. One table read by the plot and by the key,
 * so a key can never be bolder or fainter than the line it names. */
const WEIGHT = {
  lead: { width: 2.5, opacity: 1 },
  reference: { width: 1.5, opacity: 1 },
  raw: { width: 1, opacity: 0.5 },
} as const;
type Weight = keyof typeof WEIGHT;

function SeriesKey({ tone, lineStyle = "solid", weight = "lead", bars = false, outlined = false }: {
  tone: SeriesTone;
  lineStyle?: HeroSeries["lineStyle"];
  weight?: Weight;
  bars?: boolean;
  /** The key for a partial bar: outlines, as the plot draws a day only some
   * sources reported. */
  outlined?: boolean;
}) {
  return (
    <svg aria-hidden className={cn("h-3 w-6 shrink-0", SERIES_TONE_CLASS[tone])} viewBox="0 0 24 12">
      {bars ? <path d="M3 11V6H7V11ZM10 11V1H14V11ZM17 11V4H21V11Z" fill={outlined ? "none" : "currentColor"}
        stroke={outlined ? "currentColor" : undefined} strokeWidth={outlined ? 1.2 : undefined} /> : <line x1="1.5" x2="22.5" y1="6" y2="6" stroke="currentColor"
        strokeWidth={WEIGHT[weight].width} strokeOpacity={WEIGHT[weight].opacity}
        strokeDasharray={LINE_DASH[lineStyle]} strokeLinecap="round" />}
    </svg>
  );
}

/** The key for the hollow point every provisional series ends on. */
function ProvisionalKey() {
  return (
    <svg aria-hidden className="size-3 shrink-0 text-muted-foreground" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="3.5" className="fill-card stroke-current" strokeWidth={1.5} />
    </svg>
  );
}

/** One legend entry. With more than one series the entry is the toggle. */
const keyItemClass = "inline-flex items-center gap-1.5 text-xs";
const keyToggleClass = cn(
  keyItemClass,
  pillControlClass,
  "cursor-pointer rounded-md px-1.5 py-0.5 font-medium hover:bg-muted/60 motion-safe:transition-colors",
);

/** A daily observation is a line with its trailing average; a settled month
 * is an area; a count that only changes when something happens is a step,
 * because a diagonal would claim a value nobody measured. */
export type HeroVariant = "line" | "monthly" | "step" | "bars";

export interface HeroChartProps {
  /** One short line naming the measure and its grain. */
  title?: ReactNode;
  /** One figure beside the title. */
  titleAside?: ReactNode;
  series: readonly HeroSeries[];
  /** Periods of the series' own grain, from the page's `RangeSelector`. */
  range?: number;
  /** Explicit calendar end keeps missing trailing dates on the axis. */
  end?: string;
  /** Per-date coverage/context shown in the readout and data table. */
  notesByDate?: Readonly<Record<string, string>>;
  /** Incomplete observed bars use an outline as well as a text explanation. */
  partialDates?: readonly string[];
  height?: number;
  variant?: HeroVariant;
  /** Bold trailing average over the faint raw line. `line` only. */
  average?: boolean;
  averageWindow?: number;
  /** Fill under the leading line. Drawn only while one series is visible:
   * two overlapping translucent areas read as a third colour. */
  area?: boolean;
  weekends?: boolean;
  annotations?: readonly SurfaceAnnotation[];
  /** Watch windows shaded behind the series, each with one label at its start. */
  spans?: readonly SurfaceSpan[];
  provisionalFrom?: string | null;
  format?: (value: number) => string;
  /** Point details and table values; defaults to the axis format. */
  formatValue?: (value: number) => string;
  /** Per-series toggles. Default: on whenever there is more than one series. */
  toggles?: boolean;
  /** Make discrete observations explicit; gaps still break the line. */
  showPoints?: boolean;
  /** Anything the page owes this chart beyond what it draws about itself. */
  footnote?: ReactNode;
  emptyLabel?: string;
  ariaLabel?: string;
  className?: string;
}

/** The plot's own coordinate space, geometry only: every glyph on this chart
 * is HTML, so `preserveAspectRatio="none"` can stretch x to any width without
 * squeezing a letter. */
const VIEW_WIDTH = 1000;
const PAD_TOP = 10;
const PAD_BOTTOM = 6;

const GRID_LINES = 4;

/** Below this, quarters of the maximum are not numbers an integer format can
 * print distinctly, so the scale takes integer steps instead. */
const SMALL_DOMAIN = 5;

/** The axis labels' type size in px; the y gutter is measured from it. */
const AXIS_LABEL_PX = 12;

/** Room to the right of the last point, so the provisional cap drawn on the
 * final x is not sliced by the card's edge. */
const RIGHT_GUTTER = 7;

/**
 * How wide a tick label will draw, in px. The y gutter cannot be an `auto`
 * grid column, because its labels are absolutely positioned and the column
 * would collapse. The labels are `tabular-nums`: every digit is one fixed
 * advance (~0.6em) and a separator about half of one.
 */
export function axisLabelWidth(label: string, fontPx = AXIS_LABEL_PX): number {
  let em = 0;
  for (const glyph of label) {
    em += /\d/.test(glyph) ? 0.6 : /[.,'\s]/.test(glyph) ? 0.3 : 0.56;
  }
  return Math.ceil(em * fontPx);
}

/** A tick step a compact format prints exactly: 1, 2, 2.5, 4, 5 or 10 times a
 * power of ten. `8` is missing on purpose; see `isExactStep`. */
function niceStep(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const fraction = value / power;
  const nice =
    fraction <= 1 ? 1
    : fraction <= 2 ? 2
    : fraction <= 2.5 ? 2.5
    : fraction <= 4 ? 4
    : fraction <= 5 ? 5
    : 10;
  return nice * power;
}

/** A scale maximum: 1, 2, 2.5, 4, 5, 8 or 10 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const fraction = value / power;
  const nice =
    fraction <= 1 ? 1
    : fraction <= 2 ? 2
    : fraction <= 2.5 ? 2.5
    : fraction <= 4 ? 4
    : fraction <= 5 ? 5
    : fraction <= 8 ? 8
    : 10;
  return nice * power;
}

/** A step a compact format prints without rounding (2,500 is "2.5K"; 3,750
 * would be "3.8K", a lie about the scale). */
function isExactStep(step: number): boolean {
  if (!(step > 0)) return false;
  const fraction = step / 10 ** Math.floor(Math.log10(step));
  // Floating point: 2.5 arrives as 2.4999999999999996 often enough to matter.
  return [1, 2, 2.5, 4, 5, 10].some((one) => Math.abs(fraction - one) < 1e-9);
}

/** The tick values, bottom first. Floating-point residue is snapped away so a
 * zero tick prints as "0". */
function scaleTicks(bottom: number, top: number, steps: number): number[] {
  const gap = (top - bottom) / steps;
  return Array.from({ length: steps + 1 }, (_, at) => {
    const value = bottom + gap * at;
    return Math.abs(value) < gap * 1e-9 ? 0 : value;
  });
}

/**
 * A signed domain: the step is chosen first from the observed span and both
 * ends are rounded outward to whole steps, which puts zero on a tick by
 * construction. The first step the format can state exactly wins.
 */
function signedScale(min: number, max: number, format: (value: number) => string) {
  const span = Math.max(max, 0) - Math.min(min, 0);
  const small = span < SMALL_DOMAIN;
  for (const target of small ? [2, 1] : [GRID_LINES, 5, 3, 2]) {
    const step = small ? Math.max(1, Math.ceil(span / target)) : niceStep(span / target);
    const bottom = -Math.ceil(Math.max(0, -min) / step) * step;
    const top = Math.ceil(Math.max(0, max) / step) * step;
    const steps = Math.round((top - bottom) / step);
    // Rounding both ends outward can add a gap at each end, so a four-gap
    // candidate can arrive as six; beyond that the axis is a ladder.
    if (steps < 1 || steps > 6) continue;
    const labels = scaleTicks(bottom, top, steps).map(format);
    if (new Set(labels).size === labels.length) return { top, bottom, steps };
  }
  // The observed extremes with the line between them: two gaps always draw.
  const reach = Math.max(Math.max(max, 0), -Math.min(min, 0), 1);
  return { top: reach, bottom: -reach, steps: 2 };
}

/** A line whose lowest reading is at least this share of its highest is drawn
 * on a fitted scale; from zero it would be a flat band. */
const FIT_FLOOR_SHARE = 0.5;

/**
 * A fitted domain for a positive line that never comes near zero. The
 * labelled gutter carries the floor. Bars and steps never take it: a bar cut
 * off at a floor above zero says something false about the ratio of two days.
 */
function fittedScale(min: number, max: number, format: (value: number) => string) {
  const span = max - min;
  if (!(min > 0) || min < max * FIT_FLOOR_SHARE || span < SMALL_DOMAIN) return null;
  for (const target of [GRID_LINES, 5, 3, 2]) {
    const step = niceStep(span / target);
    if (!isExactStep(step)) continue;
    const bottom = Math.floor(min / step) * step;
    const top = Math.ceil(max / step) * step;
    const steps = Math.round((top - bottom) / step);
    if (steps < 2 || steps > 6 || bottom <= 0) continue;
    const labels = scaleTicks(bottom, top, steps).map(format);
    if (new Set(labels).size === labels.length) return { top, bottom, steps };
  }
  return null;
}

/**
 * The zero-based scale. Candidate gap counts are tried in order and the first
 * whose step the format prints exactly wins; a small domain takes integer
 * steps; distinct labels are the last gate, because a rounding format can
 * still collide. A series below zero goes to `signedScale` instead.
 */
function heroScale(min: number, max: number, format: (value: number) => string) {
  if (min < 0) return signedScale(min, max, format);
  const small = max < SMALL_DOMAIN;
  const top = small ? Math.max(1, Math.ceil(max)) : niceMax(max);
  for (const steps of small ? [top, 2, 1] : [GRID_LINES, 5, 3, 2, 1]) {
    // A small domain's steps must divide its top, or "integer steps" is a
    // promise the axis breaks on the way to the label.
    if (steps < 1 || (small && top % steps !== 0)) continue;
    if (!small && !isExactStep(top / steps)) continue;
    const labels = Array.from({ length: steps + 1 }, (_, at) => format((top / steps) * at));
    if (new Set(labels).size === labels.length) return { top, bottom: 0, steps };
  }
  return { top, bottom: 0, steps: 1 };
}

/**
 * The desk's one time-series surface; the Wall keeps its own chart components.
 * The x domain is every calendar period in the range, built from the range and
 * not from the points, so a missing day is a visible break and two providers
 * with different end dates share one axis. The y domain is zero-based for a
 * count, signed for a series that goes below zero, and fitted for a line that
 * never comes near zero; none of that is a prop, because it is a property of
 * the data.
 */
export function HeroChart({
  title,
  titleAside,
  series,
  range = DEFAULT_RANGE_DAYS,
  end: calendarEnd,
  notesByDate = {},
  partialDates = [],
  height = 240,
  variant = "line",
  average,
  averageWindow = 7,
  area = true,
  weekends = true,
  annotations = [],
  spans = [],
  provisionalFrom = null,
  format = formatInt,
  formatValue = format,
  toggles,
  showPoints = false,
  footnote,
  emptyLabel = "No series yet",
  ariaLabel,
  className,
}: HeroChartProps) {
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const [hoverIndex, setHoverIndex] = useState(-1);
  const [activeEvent, setActiveEvent] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const dateAxis = useRef<HTMLDivElement>(null);
  const instructionsId = useId();

  const drawsAverage = average ?? variant === "line";
  const showToggles = toggles ?? series.length > 1;

  const plot = useMemo(() => {
    const ends = series
      .map((one) => one.points.at(-1)?.t)
      .filter((label): label is string => label !== undefined);
    if ((ends.length === 0 && !calendarEnd) || range < 1) return null;

    const end = calendarEnd ?? ends.reduce((latest, one) => (one > latest ? one : latest));
    const start = shiftLabel(end, -(range - 1));

    const domain: string[] = [];
    for (let label = start; label <= end; label = shiftLabel(label, 1)) domain.push(label);
    if (domain.length === 0) return null;

    const lanes = series.map((one, index) => {
      const byLabel = new Map(one.points.map((point) => [point.t, point.v]));
      const raw = domain.map((label) => byLabel.get(label) ?? null);
      // The average is taken over the whole series and windowed afterwards, so
      // the first visible day carries a true figure when there is history
      // behind the window.
      const boundary = one.provisionalFrom === undefined ? provisionalFrom : one.provisionalFrom;
      const complete = boundary === null ? one.points : one.points.filter((point) => point.t < boundary);
      // Average only actual completed observations, never the shared calendar
      // axis. Otherwise another provider's newer dates fabricate a trailing
      // line here, and a missing middle day acquires a value of its own.
      const reference = one.reference === true;
      const smooth = drawsAverage && !reference;
      const smoothed = new Map((smooth ? averageSeries(complete, averageWindow) : [])
        .map((point) => [point.t, point.v]));
      return {
        name: one.name,
        smooth,
        reference,
        weight: (reference ? "reference" : "lead") as Weight,
        tone: one.tone ?? (reference ? "neutral" : "primary"),
        lineStyle: one.lineStyle ?? (reference ? "dotted" : (["solid", "dashed", "dotted"] as const)[index % 3]!),
        raw,
        average: domain.map((label) => smoothed.get(label) ?? null),
        averageReports: domain.map((label) => smoothed.has(label)
          ? complete.filter((point) => point.t >= shiftLabel(label, -(averageWindow - 1)) && point.t <= label).length
          : 0),
        provisionalAt: provisionalIndex(domain.map((t) => ({ t })), boundary),
        lastIndex: raw.reduce<number>((at, value, index) => (value === null ? at : index), -1),
      };
    });

    return { domain, lanes };
  }, [series, range, calendarEnd, drawsAverage, averageWindow, provisionalFrom]);

  const visibleDates = useChartLabelVisibility(dateAxis, plot?.domain.join(",") ?? "");

  if (!plot) {
    return (
      <div
        data-hero-chart=""
        className={cn(
          "flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground",
          className,
        )}
        style={{ height }}
        role="img"
        aria-label={emptyLabel}
      >
        {emptyLabel}
      </div>
    );
  }

  const { domain, lanes } = plot;
  const visible = lanes.filter((lane) => !hidden.includes(lane.name));
  const shown = visible.length > 0 ? visible : lanes;
  const grain = seriesGrain(domain.map((t) => ({ t, v: 0 })));

  const observed = shown
    .flatMap((lane) => [...lane.raw, ...lane.average])
    .filter((value): value is number => value !== null);
  // Lines and monthly lines fit a range far from zero; bars and steps cannot.
  const fitted = variant === "line" || variant === "monthly"
    ? fittedScale(Math.min(...observed), Math.max(...observed), format)
    : null;
  const { top, bottom, steps } = fitted ?? heroScale(
    Math.min(0, ...observed),
    Math.max(0, ...observed),
    format,
  );
  const ticks = scaleTicks(bottom, top, steps);
  // The gutter is the widest label the format actually produces, so no tick
  // loses its leading digits at any width the chart is drawn at.
  const gutter = Math.max(...ticks.map((value) => axisLabelWidth(format(value))));
  // The zero line is inside the plot: the area's baseline.
  const signed = bottom < 0;

  const plotHeight = height - PAD_TOP - PAD_BOTTOM;
  const xOf = (index: number) =>
    variant === "bars" ? ((index + 0.5) / domain.length) * VIEW_WIDTH
      : domain.length === 1 ? VIEW_WIDTH / 2 : (index / (domain.length - 1)) * VIEW_WIDTH;
  const yOf = (value: number) => PAD_TOP + (1 - (value - bottom) / (top - bottom)) * plotHeight;
  // The bottom of the plot box, which is `yOf(0)` only on a zero-based scale.
  const floor = PAD_TOP + plotHeight;
  const percentOf = (index: number) => (xOf(index) / VIEW_WIDTH) * 100;

  const windows = placeSpans(domain, spans);
  const marks = placeAnnotations(
    domain.map((t) => ({ t, v: 0 })),
    annotations,
  );
  const hasProvisional = shown.some((lane) => lane.provisionalAt >= 0 && lane.lastIndex >= lane.provisionalAt);
  const bands =
    weekends && variant === "line" ? weekendSpans(domain.map((t) => ({ t, v: 0 }))) : [];

  // A missing period breaks the line rather than being drawn through.
  const segments = (values: (number | null)[]) => {
    const runs: { index: number; value: number }[][] = [];
    let run: { index: number; value: number }[] = [];
    values.forEach((value, index) => {
      if (value === null) {
        if (run.length > 0) runs.push(run);
        run = [];
        return;
      }
      run.push({ index, value });
    });
    if (run.length > 0) runs.push(run);
    return runs;
  };

  const pathOf = (values: (number | null)[], stepped: boolean) =>
    segments(values)
      .map((run) =>
        run
          .map((point, at) => {
            const x = xOf(point.index);
            const y = yOf(point.value);
            if (at === 0) return `M${x} ${y}`;
            return stepped ? `H${x} V${y}` : `L${x} ${y}`;
          })
          .join(" "),
      )
      .join(" ");

  const areaOf = (values: (number | null)[], stepped: boolean) =>
    segments(values)
      .map((run) => {
        const body = run
          .map((point, at) => {
            const x = xOf(point.index);
            const y = yOf(point.value);
            if (at === 0) return `M${x} ${y}`;
            return stepped ? `H${x} V${y}` : `L${x} ${y}`;
          })
          .join(" ");
        // Toward zero, not the floor: a negative month fills downward from the
        // zero line. A fitted scale has no zero inside the plot and stops at
        // the labelled floor.
        const base = yOf(Math.max(0, bottom));
        return `${body} L${xOf(run.at(-1)!.index)} ${base} L${xOf(run[0]!.index)} ${base} Z`;
      })
      .join(" ");

  const axisLabels = domain.filter((_, index) => {
    const step = domain.length > 60 ? 14 : domain.length > 20 ? 7 : 1;
    return index === 0 || (domain.length - 1 - index) % step === 0;
  });

  const active = activeEvent === null && hoverIndex >= 0 && hoverIndex < domain.length ? hoverIndex : -1;
  const averageLabel = `${averageWindow}-${grain === "monthly" ? "month" : "day"} avg`;
  const averageCoverage = (reports: number) => reports > 0 && reports < averageWindow
    ? ` · ${reports}/${averageWindow} reported ${grain === "monthly" ? "months" : "days"}` : "";

  function onMove(event: ReactPointerEvent<HTMLDivElement>) {
    setActiveEvent(null);
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return setHoverIndex(0);
    const ratio = (event.clientX - box.left) / box.width;
    setHoverIndex(Math.max(0, Math.min(domain.length - 1, variant === "bars"
      ? Math.floor(ratio * domain.length) : Math.round(ratio * (domain.length - 1)))));
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    setActiveEvent(null);
    if (event.key === "Escape") return setHoverIndex(-1);
    if (event.key === "Home") return setHoverIndex(0);
    if (event.key === "End") return setHoverIndex(domain.length - 1);
    const current = active < 0 ? domain.length - 1 : active;
    setHoverIndex(Math.max(0, Math.min(domain.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1))));
  }

  function toggle(name: string) {
    setHidden((current) => {
      if (current.includes(name)) return current.filter((one) => one !== name);
      // The last visible line never hides.
      if (lanes.length - current.length <= 1) return current;
      return [...current, name];
    });
  }

  // A partial day is keyed beside the series it qualifies; which sources are
  // missing is the day's own readout.
  const partialShown = variant === "bars" ? domain.filter((date) => partialDates.includes(date)).length : 0;
  // One key per drawn mark. When exactly one series is averaged, its own entry
  // names the average, so the same glyph never appears twice.
  const smoothedShown = shown.filter((lane) => lane.smooth);
  const period = grain === "monthly" ? "month" : "day";
  const averageName = `${averageWindow}-${period} average`;
  const smoothedLanes = lanes.filter((lane) => lane.smooth);
  const foldInto = smoothedLanes.length === 1 ? smoothedLanes[0]!.name : null;
  const methodTone: SeriesTone = smoothedShown.length === 1 ? smoothedShown[0]!.tone : "primary";

  return (
    <figure data-hero-chart="" className={cn("m-0 flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {title ? <h3 className="m-0 text-[13px] font-semibold">{title}</h3> : null}
        {titleAside}
        <ul aria-label="Chart key" data-hero-key=""
          className="m-0 flex list-none flex-wrap items-center gap-x-3.5 gap-y-1 p-0 text-xs">
          {lanes.map((lane) => {
            const on = !hidden.includes(lane.name);
            const label = lane.name === foldInto ? `${lane.name} · ${averageName}` : lane.name;
            const key = <SeriesKey tone={lane.tone} lineStyle={lane.lineStyle} weight={lane.weight} bars={variant === "bars"} />;
            return (
              <li key={lane.name} data-hero-key-series={lane.name} className="flex items-center">
                {showToggles ? (
                  <button type="button" aria-pressed={on} onClick={() => toggle(lane.name)}
                    className={cn(keyToggleClass, on ? "text-foreground" : "text-muted-foreground line-through")}>
                    <span className={cn("inline-flex", !on && "opacity-35")}>{key}</span>
                    {label}
                  </button>
                ) : (
                  <span className={cn(keyItemClass, "font-medium text-foreground")}>{key}{label}</span>
                )}
              </li>
            );
          })}
          {partialShown > 0 && shown[0] ? (
            <li className={cn(keyItemClass, "text-muted-foreground")} data-legend-partial="">
              <SeriesKey tone={shown[0].tone} bars outlined />
              {partialShown} partial {partialShown === 1 ? "day" : "days"}
            </li>
          ) : null}
          {smoothedShown.length > 0 && foldInto === null ? (
            <li className={cn(keyItemClass, "text-muted-foreground")} data-hero-key-method="average">
              <SeriesKey tone={methodTone} weight="lead" />
              {averageName}
            </li>
          ) : null}
          {smoothedShown.length > 0 ? (
            <li className={cn(keyItemClass, "text-muted-foreground")} data-hero-key-method="raw">
              <SeriesKey tone={methodTone} weight="raw" />
              {grain === "monthly" ? "Monthly" : "Daily"}
            </li>
          ) : null}
          {footnote || hasProvisional ? (
            <li className="flex items-center">
              <InfoTooltip label={`About ${typeof title === "string" ? title : ariaLabel ?? "this chart"}`}
                trigger={hasProvisional ? <><ProvisionalKey />Provisional</> : undefined}>
                {hasProvisional ? <span>Marked periods are provisional: those reported values are not yet final.</span> : null}
                {footnote}
              </InfoTooltip>
            </li>
          ) : null}
        </ul>
      </div>

      {/* The y gutter is measured, not `auto` (see `axisLabelWidth`). */}
      <div
        className="grid gap-x-2"
        style={{
          gridTemplateColumns: `${gutter}px minmax(0,1fr)`,
          paddingInlineEnd: `${RIGHT_GUTTER}px`,
        }}
      >
        <div
          data-hero-gutter={gutter}
          className="relative h-(--hero-height) max-sm:h-[180px]"
          style={{ "--hero-height": `${height}px` } as CSSProperties}
          aria-hidden
        >
          {ticks.map((value, step) => (
            <span
              key={step}
              className="absolute right-0 -translate-y-1/2 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
              style={{ top: `${(yOf(value) / height) * 100}%` }}
            >
              {format(value)}
            </span>
          ))}
        </div>

        {/* The height is a custom property rather than an inline `height`, so
            the `max-sm` media query can still win. */}
        <div
          className="relative h-(--hero-height) rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-[180px]"
          style={{ "--hero-height": `${height}px` } as CSSProperties}
          tabIndex={0}
          role="group"
          aria-label={`Explore ${shown.map((lane) => lane.name).join(" and ")} values`}
          aria-describedby={instructionsId}
          onFocus={(event) => { if (event.target === event.currentTarget) {
            setActiveEvent(null);
            setHoverIndex((current) => current >= 0 ? current : domain.length - 1);
          } }}
          onBlur={() => setHoverIndex(-1)}
          onKeyDown={onKeyDown}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={(event) => { if (event.pointerType !== "touch") setHoverIndex(-1); }}
        >
          <svg
            className="block h-full w-full overflow-visible"
            viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={
              ariaLabel ??
              `${shown.map((lane) => lane.name).join(" and ")} over ${domain.length} ${grain === "monthly" ? "months" : "days"}`
            }
          >
            {bands.map((band) => (
              <rect
                key={`weekend-${band.startIndex}`}
                x={xOf(Math.max(0, band.startIndex - 0.5))}
                width={
                  xOf(Math.min(domain.length - 1, band.endIndex + 0.5)) -
                  xOf(Math.max(0, band.startIndex - 0.5))
                }
                y={PAD_TOP}
                height={plotHeight}
                className="fill-chart-week-band opacity-60"
              />
            ))}

            {/* Watch windows: a quiet wash under the series and the grid,
                clipped at the chart's edge when a window runs past it. */}
            {windows.map((window) => (
              <rect
                key={`span-${window.startIndex}-${window.label}`}
                data-hero-span={window.label}
                x={xOf(Math.max(0, window.startIndex - 0.5))}
                width={Math.max(2, xOf(Math.min(domain.length - 1, window.endIndex + 0.5)) - xOf(Math.max(0, window.startIndex - 0.5)))}
                y={PAD_TOP}
                height={plotHeight}
                className="fill-warn opacity-10"
              />
            ))}

            {ticks.map((value, step) =>
              // The zero tick is drawn once, below, as the zero LINE.
              signed && value === 0 ? null : (
                <line
                  key={`grid-${step}`}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={yOf(value)}
                  y2={yOf(value)}
                  className="stroke-border opacity-60"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ),
            )}

            {/* Stronger than the grid: the line that says which side a period
                fell on. Its label is the gutter's own zero tick. */}
            {signed ? (
              <line
                data-hero-zero=""
                x1={0}
                x2={VIEW_WIDTH}
                y1={yOf(0)}
                y2={yOf(0)}
                className="stroke-muted-foreground opacity-45"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}

            {marks.map((mark) => (
              <line
                key={`mark-${mark.index}`}
                x1={xOf(mark.index)}
                x2={xOf(mark.index)}
                y1={PAD_TOP}
                y2={floor}
                className="stroke-chart-distorted"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {shown.map((lane, laneIndex) => {
              if (variant === "bars") {
                const slot = VIEW_WIDTH / domain.length;
                const width = slot * 0.76 / shown.length;
                return <g key={lane.name} className={SERIES_TONE_CLASS[lane.tone]}>
                  {lane.raw.map((value, index) => value === null ? null : <rect
                    key={domain[index]} data-hero-bar={lane.name} data-date={domain[index]} data-value={value}
                    x={xOf(index) - slot * 0.38 + laneIndex * width}
                    y={value === 0 ? yOf(0) - 1.5 : Math.min(yOf(value), yOf(0))}
                    width={width * 0.9} height={Math.max(1.5, Math.abs(yOf(value) - yOf(0)))}
                    data-partial={partialDates.includes(domain[index]!) ? '' : undefined}
                    rx={1} strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                    className={cn(partialDates.includes(domain[index]!) ? "fill-none stroke-current" : "fill-current", active >= 0 && active !== index ? "opacity-45" : "opacity-90")}
                  />)}
                </g>;
              }
              const stepped = variant === "step";
              // A reference never takes the wash that says "this is the quantity".
              const filled = !lane.reference && (variant !== "line" || (area && shown.length === 1));
              const leadValues = variant === "line" && lane.smooth ? lane.average : lane.raw;
              return (
                <g key={lane.name} className={SERIES_TONE_CLASS[lane.tone]}>
                  {filled ? (
                    <path d={areaOf(leadValues, stepped)} className="fill-current opacity-10" />
                  ) : null}
                  {variant === "line" && lane.smooth ? (
                    <path
                      data-hero-raw={lane.name}
                      d={pathOf(lane.raw, false)}
                      className="fill-none stroke-current"
                      strokeWidth={WEIGHT.raw.width}
                      strokeOpacity={WEIGHT.raw.opacity}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                  <path
                    data-hero-line={lane.name}
                    data-hero-weight={lane.weight}
                    d={pathOf(leadValues, stepped)}
                    className="fill-none stroke-current"
                    strokeWidth={WEIGHT[lane.weight].width}
                    strokeDasharray={LINE_DASH[lane.lineStyle]}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Round-capped zero-length strokes, not circles: the plot's
                      x is stretched, and a circle would be an ellipse. */}
                  {leadValues.map((value, index) => {
                    if (value === null) return null;
                    const isolated = leadValues[index - 1] == null && leadValues[index + 1] == null;
                    if ((!showPoints && !isolated) || (index === lane.lastIndex && lane.provisionalAt >= 0 && index >= lane.provisionalAt)) return null;
                    return <ChartDot key={index} data-hero-point={lane.name} at={{ x: xOf(index), y: yOf(value) }} size="sm" surface="stroke-card" />;
                  })}
                  {lane.provisionalAt >= 0 && lane.lastIndex >= lane.provisionalAt ? (
                    <ChartDot data-hero-provisional={lane.name} at={{ x: xOf(lane.lastIndex), y: yOf(lane.raw[lane.lastIndex]!) }}
                      size="sm" hollow surface="stroke-card" />
                  ) : null}
                  {active >= 0 && lane.raw[active] !== null ? (
                    <ChartDot key={`active-${active}`} data-hero-active={lane.name} at={{ x: xOf(active), y: yOf(lane.raw[active]!) }} size="sm" surface="stroke-card" />
                  ) : null}
                </g>
              );
            })}

            {active >= 0 ? (
              <line
                x1={xOf(active)}
                x2={xOf(active)}
                y1={PAD_TOP}
                y2={floor}
                className="stroke-muted-foreground"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>

          {windows.map((window) => (
            <span
              key={`span-label-${window.startIndex}-${window.label}`}
              data-hero-span-label=""
              className="pointer-events-none absolute top-0.5 max-w-[45%] truncate rounded-sm bg-card/80 px-1 text-[10px] leading-4 text-warn"
              style={{ left: `${Math.min(80, percentOf(Math.max(0, window.startIndex)))}%` }}
            >
              {window.label}
            </span>
          ))}

          {marks.length > 0 ? <ChartEventMarkers
            lineTargets
            events={marks.flatMap((mark) => mark.events.map((event) => ({ ...event, position: percentOf(mark.index) })))}
            activeKey={activeEvent}
            onActiveKeyChange={(key) => { setActiveEvent(key); if (key !== null) setHoverIndex(-1); }}
          /> : null}

          {active >= 0 ? (
            <div
              className="pointer-events-none absolute top-0 z-10 grid min-w-40 -translate-x-1/2 gap-1 rounded-md border border-border bg-card px-3 py-2 text-xs tabular-nums text-muted-foreground shadow-sm max-sm:left-0! max-sm:right-0 max-sm:translate-x-0"
              style={{ left: `${Math.min(88, Math.max(12, percentOf(active)))}%` }}
              role="status"
              data-status-for={`readout:${instructionsId}`}
              aria-atomic="true"
            >
              <span className="font-semibold text-foreground">
                {formatSeriesDate(domain[active]!)}
              </span>
              {shown.map((lane) => (
                <span key={lane.name} className="grid gap-0.5">
                  <span className="flex items-center gap-2">
                    <SeriesKey tone={lane.tone} lineStyle={lane.lineStyle} weight={lane.weight} bars={variant === "bars"} />
                    <span className="font-semibold text-foreground">{lane.name}</span>
                  </span>
                  {lane.smooth ? <span>{averageLabel}: <span className="font-semibold text-foreground">
                    {lane.average[active] === null ? "Not available" : formatValue(lane.average[active]!)}
                  </span>{averageCoverage(lane.averageReports[active]!)}</span> : null}
                  <span>{lane.smooth ? "Reported: " : ""}<span className="font-semibold text-foreground">
                    {lane.raw[active] === null ? "Not reported" : formatValue(lane.raw[active]!)}
                  </span>{lane.raw[active] !== null && lane.provisionalAt >= 0 && active >= lane.provisionalAt ? " · Provisional" : ""}</span>
                </span>
              ))}
              {notesByDate[domain[active]!] ? <span className="max-w-64 whitespace-normal">{notesByDate[domain[active]!]}</span> : null}
            </div>
          ) : null}
        </div>

        {/* The first and last dates are anchored to the plot's ends: a centred
            label at `left: 100%` has no width to grow into and wraps. */}
        <div ref={dateAxis} data-hero-x-axis className="relative col-start-2 mt-1 h-4" aria-hidden>
          {axisLabels.map((label) => {
            const index = domain.indexOf(label);
            const atEnd = domain.length > 1 && index === domain.length - 1;
            const atStart = domain.length > 1 && index === 0;
            const visible = visibleDates === null || visibleDates.includes(label);
            return (
              <span
                key={label}
                data-hero-x-candidate={label}
                    data-chart-label-candidate={label}
                data-hero-x-label={visible ? label : undefined}
                className={cn(
                  "absolute whitespace-nowrap text-xs tabular-nums text-muted-foreground",
                  atEnd && "end-0",
                  !atEnd && !atStart && "-translate-x-1/2",
                )}
                style={{
                  ...(!atEnd ? { left: `${percentOf(index)}%` } : {}),
                  ...(!visible ? { visibility: "hidden" } : {}),
                }}
              >
                {formatSeriesDate(label)}
              </span>
            );
          })}
        </div>
      </div>

      <span id={instructionsId} className="sr-only">
        Arrow keys step through dates; Home and End jump; Escape clears.
      </span>
      <details className="min-w-0" onToggle={(event) => setDataOpen(event.currentTarget.open)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.currentTarget.open = false;
          setDataOpen(false);
          event.currentTarget.querySelector("summary")?.focus();
        }}>
        <summary className={cn("w-fit cursor-pointer rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground max-sm:content-center", pillControlClass)}>
          View data · {domain.length} {grain === "monthly" ? "months" : "days"}
        </summary>
        {dataOpen ? (
          <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border" tabIndex={0}
            role="region" aria-label="Chart data table">
            <Table>
              <caption className="sr-only">Dated values for {shown.map((lane) => lane.name).join(", ")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{grain === "monthly" ? "Month" : "Date"}</TableHead>
                  {shown.map((lane) => <TableHead key={lane.name} scope="col" className="text-right">{lane.name}</TableHead>)}
                  <TableHead scope="col">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domain.map((date, index) => (
                  <TableRow key={date}>
                    <TableHead scope="row" className="whitespace-nowrap font-medium text-foreground">
                      <time dateTime={date}>{grain === "monthly" ? formatSeriesDate(date) : formatCalendarDate(date)}</time>
                    </TableHead>
                    {shown.map((lane) => (
                      <TableCell key={lane.name} className="text-right tabular-nums">
                        {lane.raw[index] === null ? "Not reported" : formatValue(lane.raw[index]!)}
                        {lane.raw[index] !== null && lane.provisionalAt >= 0 && index >= lane.provisionalAt ? " · Provisional" : null}
                        {lane.smooth && lane.average[index] !== null ? <span className="block text-xs text-muted-foreground">
                          {averageLabel}: {formatValue(lane.average[index]!)}{averageCoverage(lane.averageReports[index]!)}
                        </span> : null}
                      </TableCell>
                    ))}
                    <TableCell className="text-xs text-muted-foreground">
                      {[
                        ...(notesByDate[date] ? [notesByDate[date]] : []),
                        ...marks.filter((mark) => mark.index === index).flatMap((mark) => mark.labels),
                      ].join(" · ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </details>
    </figure>
  );
}
