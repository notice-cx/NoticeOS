import { cn } from "@/lib/utils";

export interface ProgressRingProps {
  /** How many segments are filled. Clamped into `[0, total]`. */
  done: number;
  /** How many segments the ring is divided into. One per countable thing. */
  total: number;
  /**
   * The whole sentence behind the shape — what it counts and what is left.
   * REQUIRED: a ring with nothing named is the decoration doc 14's 2026-09-04
   * rule rejects, and it is also the only thing a screen reader gets.
   */
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
 * A SEGMENTED COMPLETION RING — n of m discrete things done (bead `ro-28ma`).
 *
 * Registry justification: nothing here counted DISCRETE STEPS in a badge-sized
 * footprint. `Meter` is one value against a CAP and turns amber over it — a
 * setup checklist has no cap and going "over" is impossible. `SegmentBar` is how
 * a total DIVIDES into named parts, which is a different question from how much
 * of it is finished. `Stepper` is the lifecycle PATH, read-only and full width.
 * `Wizard`'s summary rail is form layout — a vertical list of steps with a
 * solid/hollow spine, which cannot sit beside an asset's name. All four are
 * LINEAR and full width; at the ~16px this has to live in (an asset card's
 * identity cluster, a table cell beside the lifecycle word) a linear bar is
 * three pixels tall and reads as a rule, not a quantity. A ring holds its area
 * at that size, and its segments stay countable.
 *
 * SEGMENTS, NOT A SWEPT ARC. The fact is a COUNT (2 of 4 done), and a count is
 * read by counting — a continuous 50% arc asks the operator to estimate an angle
 * and hides that the whole is four things. Each segment is one item, separated by
 * a real gap so two adjacent filled segments cannot merge into one longer one.
 *
 * MONOCHROME, on purpose. Progress is not severity (the same rule `Stepper`
 * follows): a half-finished setup is not a warning, and spending amber on it
 * would put a fifth alarm colour on a surface whose real alerts have to win. The
 * filled arcs are foreground ink, the unfilled ones are the muted track, so the
 * encoding is INK vs GROUND and survives greyscale, a colour-blind reader and a
 * screenshot. Nothing here reads a token of its own; the two classes are the
 * same pair `Meter` uses for its fill and its track.
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
