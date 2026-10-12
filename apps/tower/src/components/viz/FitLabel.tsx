import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A one-line label shown whole or not at all. The box is one line tall; the
 * empty inline-block before the label is a place the line may break, so a
 * label wider than its room drops whole to the second line, which the box
 * hides, instead of being cut to "Nightly r…". The room (a max width,
 * `flex-1`, the text size, `text-end`) goes on `className`; the ink and any
 * pill behind the words go on `labelClassName`, so a label that does not fit
 * leaves no empty pill.
 */
export function FitLabel({
  children,
  className,
  labelClassName,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  children: ReactNode;
  labelClassName?: string;
}) {
  return (
    <span {...rest} className={cn("block h-[1lh] min-w-0 overflow-hidden", className)} data-fit-label="">
      <span aria-hidden className="inline-block w-0" />
      <span className={cn("inline-block whitespace-nowrap", labelClassName)}>{children}</span>
    </span>
  );
}
