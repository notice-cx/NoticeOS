import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface SegmentBarSegment {
  /** Stable identity: the React key and the `data-segment` hook. */
  name: string;
  /** This segment's share of the whole. Zero is not drawn. */
  value: number;
  /** Token fill class — `bg-error`, `bg-warn`, `bg-muted-foreground/30`. A color
   * literal here is a review-blocking smell (doc 14), so callers pass a token
   * class and the component never chooses a color of its own. */
  fill: string;
  /** A caller's own DOM hook on the segment (`data-priority-band`). */
  attrs?: Record<string, string>;
}

export interface SegmentBarProps extends HTMLAttributes<HTMLDivElement> {
  segments: SegmentBarSegment[];
  /** What the whole bar says, in the operator's words. Required: a bar with no
   * sentence behind it is the decoration doc 14's 2026-09-04 rule rejects. */
  ariaLabel: string;
  /** Smallest painted width of a non-empty segment. */
  minWidth?: string;
}

/**
 * ONE segmented mass bar — how a total DIVIDES, as proportion (bead `ro-pbzu.8`).
 *
 * Registry justification: the registry already had this shape, but only with the
 * P0..P4 priority ramp welded into it (`PriorityBar`), so
 * Home's "how much of my inbox is urgent" and "how much of this alert count is
 * red" had nothing to compose from. `Meter` is the neighbour and answers a
 * different question — ONE value against a CAP, with over-cap as its own amber
 * state — and cannot draw two meanings at once. Rather than grow a second
 * vocabulary for one shape, `PriorityBar` is now this component with the
 * priority ramp as its preset, and the geometry, the minimum-width rule and the
 * track live here once.
 *
 * A non-empty segment never falls below `minWidth`: at true proportion a lone P0
 * in 121 beads would be a third of a pixel, which communicates nothing and makes
 * the bar lie by omission. The bar is the SHAPE — the exact figures always live
 * beside it in text, so nothing here is the only place a number appears.
 */
export function SegmentBar({
  segments,
  ariaLabel,
  minWidth = "3px",
  className,
  ...rest
}: SegmentBarProps) {
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn(
        "flex h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      data-segment-bar
      // A NUMBER'S SHAPE, DECLARED (doc 14, bead `ro-78qo.6`). The surface
      // audit asks every `[data-kpi]` for a series, because doc 14 says a
      // number that CAN have one must show it. Some cannot: an inbox posture
      // and an open-alert count are point-in-time totals with no history to
      // draw, and what they have instead is a composition — how the total
      // divides. This mark is that answer, and it is named for the CONCEPT
      // rather than for this component so a second shape answering the same
      // question (a ring, a stacked cell) can carry it without the audit
      // learning a new class name.
      data-composition=""
      {...rest}
    >
      {segments.map((segment) =>
        segment.value > 0 ? (
          <span
            key={segment.name}
            className={cn("h-full", segment.fill)}
            style={{ flexGrow: segment.value, flexBasis: 0, minWidth }}
            data-segment={segment.name}
            {...segment.attrs}
          />
        ) : null,
      )}
    </div>
  );
}
