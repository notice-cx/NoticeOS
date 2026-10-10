import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface SegmentBarSegment {
  /** Stable identity: the React key and the `data-segment` hook. */
  name: string;
  /** This segment's share of the whole. Zero is not drawn. */
  value: number;
  /** Token fill class — `bg-error`, `bg-warn`, `bg-muted-foreground/30`. The
   * component never chooses a colour of its own. */
  fill: string;
  /** A caller's own DOM hook on the segment (`data-priority-band`). */
  attrs?: Record<string, string>;
}

export interface SegmentBarProps extends HTMLAttributes<HTMLDivElement> {
  segments: SegmentBarSegment[];
  /** What the whole bar says, in the operator's words. Required: it is the
   * bar's accessible name. */
  ariaLabel: string;
  /** Smallest painted width of a non-empty segment. */
  minWidth?: string;
}

/**
 * How a total divides, as proportion. A non-empty segment never falls below
 * `minWidth`, or a lone item in a large total would vanish; the exact figures
 * always live beside the bar in text.
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
      // The surface audit asks every `[data-kpi]` for a series; a
      // point-in-time total answers with its composition instead. Named for
      // the concept so another shape can carry it.
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
