import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export interface AboutProps {
  /** The summary line. Defaults to the words doc 14's template prints. */
  title?: string;
  children: ReactNode;
  /** Open on arrival. For the gallery and for a first run where the operator
   * has not yet been told what the numbers are; a view surface leaves it shut. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * THE ONE PLACE PROSE LIVES ON A DESK SURFACE (doc 14 principle 3).
 *
 * *Registry justification:* nothing here was a disclosure for EXPLANATION.
 * `Drill` opens evidence for one fact, `EvidencePopover` shows where a figure
 * came from, and a `SectionCard` subtitle is copy the reader cannot escape. The
 * asset page had a paragraph under every heading — what the numbers are, where
 * they come from, what provisional means, how the findings are produced — shown
 * in full on every visit to a page the operator opens several times a day. This
 * is where all of it goes: one summary per screen, closed, and the page above it
 * is charts and numbers.
 *
 * Closed by default is the whole point, so `defaultOpen` exists for the gallery
 * and first-run only. It renders a native `<details>`: no state, no motion, and
 * a browser's own find-in-page can still reach the text inside it.
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
      {/* A `summary` is pressable, so it owes what every other pressable thing
          on the desk owes — and it takes that from the one place the contract
          lives rather than restating it (bead `ro-78qo.1`). */}
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
