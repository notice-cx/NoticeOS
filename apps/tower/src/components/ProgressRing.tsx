import { cn } from "@/lib/utils";

export interface ProgressRingProps {
  /** How many segments are filled. Clamped into `[0, total]`. */
  done: number;
  /** How many segments the ring is divided into. One per countable thing. */
  total: number;
  /** The whole sentence behind the shape — what it counts and what is left.
   * Required: it is also the only thing a screen reader gets. */
  title: string;
  /** `sm` (16px) sits in a card header or a table cell and carries no text.
   * `md` (28px) leads a panel and prints the done count in its middle. */
  size?: "sm" | "md";
  className?: string;
}

const GEOMETRY = {
  sm: { px: 16, stroke: 3.4, gap: 6, text: null },
  md: { px: 28, stroke: 3.8, gap: 5, text: "text-[10px]" },
} as const;

/** The path every segment is drawn on: one circle, r=14 in a 32×32 box, so the
 * stroke stays inside the viewBox at every width above. */
const RADIUS = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * n of m discrete things done, in a badge-sized footprint where a linear bar
 * would read as a rule. One gapped segment per item so the count can be read
 * by counting. Monochrome: progress is not severity.
 */
export function ProgressRing({
  done,
  total,
  title,
  size = "sm",
  className,
}: ProgressRingProps) {
  const segments = Math.max(1, Math.round(total));
  const filled = Math.min(segments, Math.max(0, Math.round(done)));
  const { px, stroke, gap, text } = GEOMETRY[size];
  const step = CIRCUMFERENCE / segments;
  /* One segment never eats its own gap: with many segments the gap shrinks
     rather than inverting the dash into a negative length. */
  const painted = Math.max(step * 0.35, step - gap);

  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn(
        "relative inline-grid shrink-0 place-items-center align-middle",
        className,
      )}
      style={{ width: px, height: px }}
      data-progress-ring
      data-done={filled}
      data-total={segments}
    >
      <svg
        viewBox="0 0 32 32"
        width={px}
        height={px}
        aria-hidden
        className="block"
      >
        <g transform="rotate(-90 16 16)">
          {Array.from({ length: segments }, (_, index) => (
            <circle
              key={index}
              cx="16"
              cy="16"
              r={RADIUS}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={`${painted} ${CIRCUMFERENCE - painted}`}
              strokeDashoffset={-(index * step)}
              className={index < filled ? "stroke-foreground/80" : "stroke-muted"}
              data-segment={index < filled ? "done" : "pending"}
            />
          ))}
        </g>
      </svg>
      {text ? (
        <span
          className={cn(
            "absolute font-medium tabular-nums leading-none text-foreground",
            text,
          )}
          aria-hidden
        >
          {filled}
        </span>
      ) : null}
    </span>
  );
}
