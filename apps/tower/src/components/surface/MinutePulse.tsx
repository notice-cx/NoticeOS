import { GA4_PULSE_RECENT_MINUTES } from "@noticeos/contract/ga4-realtime";
import { cn } from "@/lib/utils";

// THE MINUTE PULSE (bead `ro-trai.27`, docs/14-design.md § Site rows): a
// site's live users minute by minute over the last 30 minutes, one bar a
// minute, oldest on the left — the pattern of Google Analytics' realtime card
// ("users per minute" under "users in the last 30 minutes"). The newest five
// bars are bright, the 5-minute window; the 25 before them are muted, so
// momentum reads from the shape: a bright end taller than the rest is a site
// picking up.
//
// Three kinds of minute, never confused: a count is a bar scaled to the
// busiest minute; a minute nobody was active is a short tick on the floor; a
// minute the reading did not cover (`null`) is nothing at all, so an unread
// minute never passes for a quiet one.
//
// Drawn in the charts' one language (`ChartMarks`, bead `ro-trai.19`): colour
// from the caller's `currentColor` (the `traffic` identity on the Wall), paths
// that ease to a new height when a reading changes (`chart-morph`, none under
// reduced motion). Unlike the lines, bars are drawn at their natural pixel
// size — a 1:1 viewBox, butt-capped strokes on whole pixels — so thirty bars two
// pixels wide stay crisp instead of smearing across fractional columns.
//
// Registry justification: `ChartLine`/`ChartArea`/`ChartDot` draw lines and
// points and nothing draws bars; `VisitorsChart`'s bars are HTML columns that
// fill a tile and carry a hatched day and a money line; `DailyBars` is a whole
// desk chart with axes and bands. Nothing drew a row-height strip of minutes
// with a bright end.

export type MinutePulseSize = "row" | "roomy" | "focus";

/** Bar width, gap and height in screen pixels: a compact row's strip (as wide
 * as its figures and its column's heading), a roomier row's (as wide — its
 * charts leave the column no more — and taller, where it has the height),
 * and the one-site tile's. */
const SIZE: Record<MinutePulseSize, { bar: number; gap: number; height: number; tick: number }> = {
  row: { bar: 3, gap: 1, height: 14, tick: 1.5 },
  roomy: { bar: 3, gap: 1, height: 28, tick: 2 },
  focus: { bar: 6, gap: 2, height: 32, tick: 2 },
};

/** How much of the ink the muted minutes, and a quiet minute's tick, keep. */
const EARLIER_OPACITY = 0.38;
const TICK_OPACITY = 0.3;

export interface MinutePulseProps {
  /** Oldest first; `null` is a minute the reading did not cover. */
  minutes: readonly (number | null)[];
  size?: MinutePulseSize;
  /** A reading that is out of date or kept after a failed one: drawn in
   * neutral ink, the bright end no brighter than the rest. */
  dimmed?: boolean;
  className?: string;
}

/** The strip's width in pixels, so a caller can line figures up under it. */
export function minutePulseWidth(count: number, size: MinutePulseSize = "row"): number {
  const { bar, gap } = SIZE[size];
  return count * (bar + gap) - gap;
}

export function MinutePulse({ minutes, size = "row", dimmed = false, className }: MinutePulseProps) {
  const { bar, gap, height, tick } = SIZE[size];
  const width = minutePulseWidth(minutes.length, size);
  const busiest = Math.max(1, ...minutes.map((value) => value ?? 0));
  // A minute with anyone in it stands clear of a quiet minute's tick.
  const least = tick + 1.5;
  const recentFrom = minutes.length - GA4_PULSE_RECENT_MINUTES;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      className={cn("block shrink-0 overflow-visible", dimmed ? "text-muted-foreground" : "text-traffic", className)}
      aria-hidden
      data-minute-pulse={dimmed ? "dimmed" : "live"}
      data-unread-minutes={minutes.filter((value) => value === null).length}
    >
      {minutes.map((value, index) => {
        if (value === null) return null;
        const x = index * (bar + gap) + bar / 2;
        const tall = value === 0 ? tick : Math.max(least, (value / busiest) * height);
        const recent = index >= recentFrom;
        const opacity = value === 0 ? TICK_OPACITY : recent && !dimmed ? 1 : dimmed && recent ? 0.7 : EARLIER_OPACITY;
        return (
          <path
            key={index}
            d={`M${x} ${height}V${Math.round((height - tall) * 2) / 2}`}
            strokeWidth={bar}
            strokeOpacity={opacity}
            className="chart-morph stroke-current"
            data-minute-bar={recent ? "recent" : "earlier"}
            data-value={value}
          />
        );
      })}
    </svg>
  );
}
