import { SURFACE_RANGES } from "@shared/surface";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export interface RangeSelectorProps {
  /** Days. The page holds it and hands it to every derivation on the surface. */
  value: number;
  onChange: (days: number) => void;
  options?: readonly number[];
  /** Names the group for a screen reader; the buttons themselves say `28d`. */
  label?: string;
  className?: string;
}

/**
 * The page's one range. It sits in the page header and changing it re-derives
 * every delta, sparkline and chart below. Toggles rather than a `<select>`:
 * three options read as a set, one press to change.
 */
export function RangeSelector({
  value,
  onChange,
  options = SURFACE_RANGES,
  label = "Range",
  className,
}: RangeSelectorProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex flex-wrap items-center gap-1.5", className)}
    >
      {options.map((days) => {
        const selected = days === value;
        return (
          <button
            key={days}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(days)}
            className={cn(
              pillChoiceClass,
              pillChoiceStateClass(selected),
              "tabular-nums",
              // `pillControlClass` gives the 44px height; a two-character
              // label also needs the minimum width.
              "max-sm:min-w-11 max-sm:justify-center",
              // The shared choice chrome animates its own colour; nothing
              // moves for a reader who asked for reduced motion.
              "motion-reduce:transition-none",
            )}
          >
            {days}d
          </button>
        );
      })}
    </div>
  );
}
