import { useId, type CSSProperties } from "react";
import { areaPath, dotPath, monotonePath, type ChartPoint } from "@/lib/chart-path";
import { cn } from "@/lib/utils";

// THE CHARTS' ONE LANGUAGE (bead `ro-trai.19`, doc 14 § Charts). Every small
// chart in the Tower — the Wall's month, today by hour, 30 days, visitors and
// money, search clicks, and the desk's `Sparkline` — is drawn from these three
// marks, so a line, the wash under it and its newest point look the same
// wherever they appear:
//
//   ChartLine  a monotone-smoothed line (it passes through every reading and
//              never overshoots one), round caps and joins; `ghost` is a
//              comparison (same weekday last week) in dashed low-contrast
//              neutral ink, `projection` where a series is heading, dashed in
//              its own ink at reduced strength.
//   ChartArea  the wash under a line: its own ink fading to nothing at the
//              baseline, never a flat block.
//   ChartDot   a point: a dot of ink on a ring of the surface, with a soft halo
//              at TV sizes and a gentle breathing ring for a series still being counted
//              (none under reduced motion).
//
// All three draw inside the caller's <svg> in its own coordinates and take
// their colour from `currentColor`, so the caller's token class (a pace tone,
// `text-traffic`, `text-financial-revenue`) is the one place a series' colour
// is decided. Strokes are non-scaling: a 1000×100 viewBox stretched to any box
// keeps its line widths and its dots round.
//
// Registry justification: `Spark`, `DailyBars` and `HeroChart` are whole
// charts with their own axes, bands and readouts; nothing drew the marks
// themselves, which is why the Wall's four charts and `Sparkline` had grown
// four different polylines, three flat fills and two kinds of dot.

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

/** A gradient id `url(#…)` can always resolve: React's ids carry characters a
 * URL fragment may not. */
export function useChartId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export type ChartLineKind = "solid" | "ghost" | "projection";

export interface ChartLineProps extends DataAttributes {
  /** One or more runs of points, x ascending; a gap between runs is a period
   * nobody reported, and the line breaks over it. */
  runs: readonly (readonly ChartPoint[])[];
  kind?: ChartLineKind;
  /** Stroke width in screen pixels. */
  width?: number;
  /** A stroke of the surface under the line, so it stays legible where it
   * crosses bars or another series. */
  casing?: boolean;
  /** The surface the casing is cut from (`stroke-background` on the Wall,
   * `stroke-card` inside a desk card). */
  surface?: string;
  className?: string;
}

/**
 * Dashes are stated as the length a reader SEES: a round cap adds half the
 * stroke to each end of every dash, so the pattern is corrected for it — a
 * 2px ghost and a 4px one look like the same line at two weights.
 */
function dashes(kind: ChartLineKind, width: number): string | undefined {
  if (kind === "solid") return undefined;
  const [seen, gap] = kind === "ghost" ? [2.2 * width, 2.4 * width] : [3 * width, 2.6 * width];
  return `${Math.max(0.01, seen - width).toFixed(1)} ${(gap + width).toFixed(1)}`;
}

export function ChartLine({
  runs,
  kind = "solid",
  width = 2.5,
  casing = false,
  surface = "stroke-background",
  className,
  ...data
}: ChartLineProps) {
  const d = runs.map(monotonePath).join(" ");
  if (!d) return null;
  const shared = {
    d,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
  };
  return (
    <>
      {casing ? <path {...shared} className={cn("chart-morph", surface)} strokeWidth={width + 4} aria-hidden /> : null}
      <path
        {...shared}
        {...data}
        className={cn(
          "chart-morph",
          kind === "ghost" ? "stroke-muted-foreground opacity-55" : "stroke-current",
          kind === "projection" && "opacity-55",
          className,
        )}
        strokeWidth={width}
        strokeDasharray={dashes(kind, width)}
        data-chart-line={kind}
      />
    </>
  );
}

export interface ChartAreaProps extends DataAttributes {
  runs: readonly (readonly ChartPoint[])[];
  /** The y the wash fades down to (the chart's zero, or its floor). */
  baseline: number;
  /** The wash's opacity at the line; it eases to nothing at the baseline. */
  strength?: number;
  /** A line that stops mid-chart (today at this hour, the month at this day)
   * would leave a hard vertical edge where its wash ends: this share of the
   * wash's width, at its right end, fades out instead. */
  fadeEnd?: number;
  className?: string;
}

export function ChartArea({ runs, baseline, strength = 0.3, fadeEnd = 0, className, ...data }: ChartAreaProps) {
  const id = useChartId("chart-wash");
  const d = runs.map((run) => areaPath(run, baseline)).filter(Boolean).join(" ");
  if (!d) return null;
  return (
    <>
      <defs>
        {/* The gradient spans the wash's own box, top to baseline, and eases
            out rather than fading linearly, so the colour stays with the line
            and the floor of the chart stays black. */}
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity={strength} />
          <stop offset="0.55" stopColor="currentColor" stopOpacity={strength * 0.32} />
          <stop offset="1" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
        {fadeEnd > 0 ? (
          <>
            <linearGradient id={`${id}-end`} x1="0" y1="0" x2="1" y2="0">
              <stop offset={1 - fadeEnd} stopColor="white" stopOpacity={1} />
              <stop offset="1" stopColor="white" stopOpacity={0} />
            </linearGradient>
            <mask id={`${id}-mask`} maskContentUnits="objectBoundingBox">
              <rect width="1" height="1" fill={`url(#${id}-end)`} />
            </mask>
          </>
        ) : null}
      </defs>
      <path
        d={d}
        fill={`url(#${id})`}
        mask={fadeEnd > 0 ? `url(#${id}-mask)` : undefined}
        className={cn("chart-morph", className)}
        data-chart-area
        {...data}
      />
    </>
  );
}

export type ChartDotSize = "sm" | "md" | "lg";

/** Diameters in screen pixels: the dot, the surface ring around it, and the
 * halo. `sm` is the desk's sparkline cap; `md` a Wall row; `lg` a tile or the
 * revenue chart. */
const DOT: Record<ChartDotSize, { dot: number; ring: number; halo: number }> = {
  sm: { dot: 5.2, ring: 1.5, halo: 0 },
  md: { dot: 8, ring: 2, halo: 17 },
  lg: { dot: 12, ring: 3, halo: 28 },
};

export interface ChartDotProps extends DataAttributes {
  at: ChartPoint;
  size?: ChartDotSize;
  /** Not settled yet: a ring of ink around the surface instead of a solid dot
   * (the desk's provisional cap, bead `ro-y91`). */
  hollow?: boolean;
  /** Off for a marker that is not a series' newest reading. */
  halo?: boolean;
  /** Breathe: the series is still being counted as the operator watches. */
  live?: boolean;
  /** The surface the ring is cut from. */
  surface?: string;
  className?: string;
}

export function ChartDot({
  at,
  size = "md",
  hollow = false,
  halo = size !== "sm",
  live = false,
  surface = "stroke-background",
  className,
  ...data
}: ChartDotProps) {
  const d = dotPath(at);
  const spec = DOT[size];
  const round = { d, fill: "none", strokeLinecap: "round" as const, vectorEffect: "non-scaling-stroke" as const };
  const haloWidth = spec.halo || spec.dot * 2.5;
  return (
    <g className={className} data-chart-dot={hollow ? "hollow" : "solid"} data-x={at.x} data-y={at.y} {...data}>
      {live ? (
        <path
          {...round}
          className="chart-morph chart-point-breathe stroke-current"
          style={{ "--chart-breathe-from": `${spec.dot}px`, "--chart-breathe-to": `${haloWidth * 1.7}px` } as CSSProperties}
          strokeWidth={spec.dot}
          data-chart-breathe
        />
      ) : null}
      {halo && spec.halo > 0 ? (
        <path {...round} className="chart-morph stroke-current" strokeOpacity={0.22} strokeWidth={spec.halo} />
      ) : null}
      <path {...round} className={cn("chart-morph", surface)} strokeWidth={spec.dot + spec.ring * 2} />
      <path {...round} className="chart-morph stroke-current" strokeWidth={spec.dot} />
      {hollow ? (
        <path {...round} className={cn("chart-morph", surface)} strokeWidth={Math.max(1, spec.dot - spec.ring * 2)} />
      ) : null}
    </g>
  );
}
