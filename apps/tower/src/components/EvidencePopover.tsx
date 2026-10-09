import { Info, TriangleAlert } from "lucide-react";
import type { IntegrationEvidence } from "@shared/integrations";
import { ageMs, formatAge } from "@shared/freshness";
import { pillControlClass } from "@/components/ui/pill";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface EvidencePopoverProps {
  evidence: IntegrationEvidence[];
  /** For aging the evidence timestamps ("2d ago"); omit to hide ages. */
  nowMs?: number;
  /** What the evidence is about, e.g. the lane label — shown as the panel title. */
  contextLabel?: string;
  /** The panel's heading. Defaults to the integrations register's question,
   * "Why this state"; an alert asks a different one ("Why this fired"). */
  question?: string;
  /**
   * Visible words beside the glyph — "Evidence" on an opened alert row, where
   * the numbers are one press away and a bare 14px mark would be the only
   * control on the line nobody can name. Omitted, the trigger is the glyph
   * alone, which is what a dense matrix cell has room for.
   */
  triggerLabel?: string;
  className?: string;
}

/**
 * The evidence affordance on a lane with store health data (doc 11 "observed
 * evidence"): a small glyph that opens a plain-language
 * panel (doc 14 principle 9). Portalled to the body so it is never clipped by the
 * matrix's horizontal scroll. The glyph's color follows the dominant polarity —
 * amber when evidence reports failure/staleness, slate when it shows success or
 * a needs-setup lane already delivering through a manual path.
 *
 * It is also where an ALERT keeps its statistics: `question` re-words the panel
 * for "why this fired", so the numbers behind an anomaly rule live one click
 * from the headline instead of in it. Alert evidence is all `supporting`,
 * which keeps the glyph the neutral info mark — the severity dot beside the
 * headline is already saying how bad this is (doc 14 one-representation).
 *
 * NO EXPLAINER UNDER THE HEADING (bead `ro-ujb9.96.6.7`). It used to open with
 * a line about where evidence comes from — "read-only and never rewritten" —
 * which is true of every popover on the desk and told the reader nothing about
 * this one. The heading asks the question and the rows answer it.
 *
 * ON THE DESK'S POPOVER PRIMITIVE (bead `ro-ujb9.219`). This was a hand-rolled
 * portal: opening left keyboard focus on the trigger with a dialog Tab could
 * not reach, closing never gave focus back, and a capture-phase scroll listener
 * closed it on any scroll — so a phone that scrolled to read a long note lost
 * it. `Popover` (Radix, `components/ui/popover.tsx`) moves focus into the
 * panel, returns it to the trigger on Escape or a press outside, and keeps the
 * panel on its trigger while the page scrolls.
 */
export function EvidencePopover({
  evidence,
  nowMs,
  contextLabel,
  question = "Why this state",
  triggerLabel,
  className,
}: EvidencePopoverProps) {
  if (evidence.length === 0) return null;

  const hasAgainst = evidence.some((e) => e.polarity === "against");
  const Glyph = hasAgainst ? TriangleAlert : Info;

  return (
    <Popover>
      <PopoverTrigger
        // A row that opens on a press must not open because its evidence did.
        onClick={(event) => event.stopPropagation()}
        aria-label={`${question} — ${evidence.length} evidence ${evidence.length === 1 ? "note" : "notes"}`}
        className={cn(
          triggerLabel
            ? cn("inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs transition-colors hover:border-foreground/30", pillControlClass)
            : "inline-grid size-4 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          hasAgainst ? "text-warn hover:text-warn" : triggerLabel ? "text-muted-foreground hover:text-foreground" : "text-info hover:text-foreground",
          className,
        )}
        data-evidence-trigger
      >
        <Glyph className={triggerLabel ? "size-3 shrink-0" : "size-3.5"} aria-hidden />
        {triggerLabel ? <span>{triggerLabel}</span> : null}
      </PopoverTrigger>
      <PopoverContent
        aria-label={contextLabel ? `${question} — ${contextLabel}` : question}
        onClick={(event) => event.stopPropagation()}
        className="flex w-[300px] max-w-[calc(100vw-16px)] flex-col gap-2 text-left"
        data-evidence-panel
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
            {question}
          </span>
          {contextLabel ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground">{contextLabel}</span>
          ) : null}
        </div>
        <ul className="flex flex-col gap-2">
          {evidence.map((e, i) => (
            <li key={i} className="flex gap-2">
              {e.polarity === "against" ? (
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
              ) : (
                <Info className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs font-medium text-foreground">
                  {e.source}
                  {nowMs !== undefined && e.at ? (
                    <span className="ml-1 font-normal tabular-nums text-muted-foreground" title={e.at}>
                      · {formatAge(ageMs(nowMs, e.at))} ago
                    </span>
                  ) : null}
                </span>
                {e.detail ? (
                  <span className="text-xs leading-snug tabular-nums text-muted-foreground">{e.detail}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
