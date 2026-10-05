import { PRIORITY_BANDS } from "@shared/work";
import { SegmentBar } from "@/components/SegmentBar";

/**
 * Priority as an ink-weight ramp, P0..P4 — index IS the task's priority.
 *
 * A TASK'S PRIORITY IS NOT A SEVERITY (doc 14, bead `ro-ujb9.200`), so the ramp
 * never borrows the attention hues: red and amber in this bar used to read as
 * something failing on a site that merely had important work queued. It steps
 * down in ink instead — full foreground at the top band, then lighter — the
 * same weight order the task board's row mark uses (a filled `!`, a ringed `!`,
 * a muted `◦`).
 *
 * The bulk of any healthy queue is P2, so P2 downward is deliberately quiet —
 * a site whose work is all default-priority has to LOOK calm, or the top bands
 * stop meaning anything.
 */
const PRIORITY_RAMP = [
  { fill: "bg-foreground" },
  { fill: "bg-foreground/65" },
  { fill: "bg-muted-foreground/45" },
  { fill: "bg-muted-foreground/25" },
  { fill: "bg-muted-foreground/15" },
] as const;

/** A band's ink on the ramp, for a split of the same queue drawn elsewhere —
 * the Sites page's urgent share (bead `ro-ujb9.240`) — so it can never wear a
 * second scale beside this bar. */
export function priorityFill(priority: number): string {
  return PRIORITY_RAMP[Math.min(Math.max(Math.trunc(priority), 0), 4)]!.fill;
}

/**
 * The queue's shape as one segmented bar: P0 at the hot end, P4 at the cold
 * (bead `ro-pbzu.8`). Home's assets table draws it beside each site's
 * open-work counts. The geometry is `SegmentBar`'s, with the priority ramp as
 * its preset rather than a rival implementation of one bar. It lived in the
 * pre-D28 Wall's task panel until that panel left the Tower (bead `ro-trai.20`).
 */
export function PriorityBar({
  bands,
  total,
  className,
}: {
  bands: number[];
  total: number;
  className?: string;
}) {
  const breakdown = bands
    .map((n, i) => (n > 0 ? `${n} ${PRIORITY_BANDS[i]}` : null))
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <SegmentBar
      ariaLabel={`Open work by priority: ${breakdown}`}
      title={`${total} not-closed tasks by priority — ${breakdown}`}
      className={className}
      data-priority-bar=""
      segments={bands.map((n, i) => ({
        name: PRIORITY_BANDS[i]!,
        value: n,
        fill: PRIORITY_RAMP[i]!.fill,
        attrs: { "data-priority-band": PRIORITY_BANDS[i]! },
      }))}
    />
  );
}
