import { PRIORITY_BANDS } from "@shared/work";
import { SegmentBar } from "@/components/SegmentBar";

/**
 * Priority as an ink-weight ramp, P0..P4; the index is the priority. Priority
 * is not severity, so the ramp never borrows the attention hues. P2 and below
 * stay quiet because most of a healthy queue is P2.
 */
const PRIORITY_RAMP = [
  { fill: "bg-foreground" },
  { fill: "bg-foreground/65" },
  { fill: "bg-muted-foreground/45" },
  { fill: "bg-muted-foreground/25" },
  { fill: "bg-muted-foreground/15" },
] as const;

/** A band's ink, for another split of the same queue so it never wears a
 * second scale beside this bar. */
export function priorityFill(priority: number): string {
  return PRIORITY_RAMP[Math.min(Math.max(Math.trunc(priority), 0), 4)]!.fill;
}

/** The queue's shape as one `SegmentBar`, P0 at the hot end. */
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
