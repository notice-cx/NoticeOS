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
  /** Visible words beside the glyph, e.g. "Evidence" on an opened alert row.
   * Omitted, the trigger is the glyph alone, for dense matrix cells. */
  triggerLabel?: string;
  className?: string;
}

/**
 * The evidence affordance: a small glyph that opens a plain-language panel.
 * The glyph is amber when any evidence is against, else the info mark. An
 * alert passes `question` ("Why this fired") and keeps its statistics here,
 * one press from the headline; its evidence is all supporting, since the
 * severity dot already says how bad it is.
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
