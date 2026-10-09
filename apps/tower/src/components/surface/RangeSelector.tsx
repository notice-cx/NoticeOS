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
 * THE PAGE'S ONE RANGE (doc 14).
 *
 * *Registry justification:* the desk had no page-wide range at all — every
 * chart carried its own "last 90 days" subtitle, so a surface answered its one
 * question over three different spans at once and nothing an operator changed
 * moved more than one card. This is the control that ends that: it sits in the
 * page header, and doc 14's acceptance is that changing it re-derives every
 * delta, sparkline and chart below.
 *
 * It is a row of `pillChoice` toggles rather than a `<select>`: three options
 * that are read as a set, one press to change, and the thumb floor comes with
 * the shared chrome (bead `ro-md80`).
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
              // THE FLOOR IS BOTH AXES (bead `ro-78qo.19`). `pillControlClass`
              // gives every pill the 44px height, which is enough for a pill
              // with a word in it; `7d` is two characters and measured 37 wide,
              // so this one has to claim its width too. It is here rather than
              // in the shared chrome because a minimum width on every pill in
              // the product would pad out the ones that are already wider.
              "max-sm:min-w-11 max-sm:justify-center",
              // The shared choice chrome animates its own colour; doc 14 asks
              // that nothing move for a reader who asked for less.
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
