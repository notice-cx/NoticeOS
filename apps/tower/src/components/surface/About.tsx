import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export interface AboutProps {
  /** The summary line. */
  title?: string;
  children: ReactNode;
  /** Open on arrival. For the gallery and for a first run where the operator
   * has not yet been told what the numbers are; a view surface leaves it shut. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * The one place prose lives on a desk surface: one summary per screen, closed
 * by default. A native `<details>`, so find-in-page still reaches the text.
 */
export function About({
  title = "About these numbers",
  children,
  defaultOpen = false,
  className,
}: AboutProps) {
  return (
    <details
      data-about=""
      open={defaultOpen}
      className={cn("group text-xs text-muted-foreground", className)}
    >
      {/* A `summary` is pressable, so it takes the shared control contract. */}
      <summary
        className={cn(
          "inline-flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden",
          pillControlClass,
        )}
      >
        <ChevronRight
          aria-hidden
          className="size-3.5 group-open:rotate-90 motion-safe:transition-transform"
        />
        {title}
      </summary>
      <div className="mt-2 flex max-w-[68ch] flex-col gap-2 leading-relaxed">{children}</div>
    </details>
  );
}
