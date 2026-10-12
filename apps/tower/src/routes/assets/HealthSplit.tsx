import { SegmentBar } from "@/components/SegmentBar";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { formatInt } from "@/lib/format";
import type { SiteHealthKey } from "@/lib/site-health";
import { cn } from "@/lib/utils";

/** Only the two problem words wear their colour; the calm ones share grey ink
 * and are told apart by their legend. */
const FILL: Record<SiteHealthKey, string> = {
  "off-track": "bg-error",
  "at-risk": "bg-warn",
  "setting-up": "bg-muted-foreground/25",
  "monitor-only": "bg-muted-foreground/45",
  "on-track": "bg-muted-foreground/45",
};

export interface HealthPart {
  key: SiteHealthKey;
  word: string;
  count: number;
}

/**
 * The portfolio's health as one split bar, worst first, whose legend is the
 * page's Health filter: a word presses to show only its sites and presses
 * again to show them all. With a word picked, the other parts of the bar fade
 * so the bar still says how much of the whole is showing.
 */
export function HealthSplit({
  parts,
  value,
  onPick,
}: {
  parts: readonly HealthPart[];
  /** The picked word, or "all". */
  value: SiteHealthKey | "all";
  onPick: (value: SiteHealthKey | "all") => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-health-split="">
      <SegmentBar
        ariaLabel={`Site health: ${parts.map((part) => `${part.count} ${part.word.toLowerCase()}`).join(", ")}`}
        className="h-2 gap-0.5 rounded-sm bg-transparent"
        minWidth="6px"
        segments={parts.map((part) => ({
          name: part.key,
          value: part.count,
          fill: cn(FILL[part.key], "first:rounded-s-sm last:rounded-e-sm motion-safe:transition-opacity", value !== "all" && value !== part.key && "opacity-25"),
        }))}
      />
      <div role="group" aria-label="Health" className="flex flex-wrap items-center gap-1.5" data-assets-filter="health">
        {parts.map((part) => {
          const picked = value === part.key;
          return (
            <button
              key={part.key}
              type="button"
              aria-pressed={picked}
              onClick={() => onPick(picked ? "all" : part.key)}
              className={cn(pillChoiceClass, pillChoiceStateClass(picked), "gap-2")}
              data-health-part={part.key}
            >
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", FILL[part.key])} />
              <span className={cn("tabular-nums", !picked && "text-foreground")}>{formatInt(part.count)}</span>{" "}
              <span>{part.word.toLowerCase()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
