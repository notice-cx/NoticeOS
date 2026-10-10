import type { ReactNode } from "react";
import type { AiOverviewGlyphState, SerpPanelAioReading } from "@shared/asset-detail";
import { aiOverviewGlyphState, serpPanelDeviceNoun } from "@shared/asset-detail";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The decision-lane vocabulary shared by query and page decision tables: lane
 * and tone types, tone classes, the lane's word, the counts strip and the cell
 * primitives. Nothing here decides a lane; each surface keeps its own rules,
 * since pages and queries are judged on different evidence.
 */
export type DecisionLane = "act" | "investigate" | "protect" | "wait";

export type DecisionTone =
  | "loss"
  | "opportunity"
  | "investigate"
  | "positive"
  | "wait";

export const DECISION_TONE_CLASSES: Record<
  DecisionTone,
  { row: string; text: string; chip: string; dot: string }
> = {
  loss: {
    row: "border-l-error bg-error/5",
    text: "text-error",
    chip: "border-error/40 bg-error-soft text-error",
    dot: "bg-error",
  },
  opportunity: {
    row: "border-l-warn bg-warn/5",
    text: "text-warn",
    chip: "border-warn/40 bg-warn/10 text-warn",
    dot: "bg-warn",
  },
  investigate: {
    row: "border-l-info bg-info/5",
    text: "text-info",
    chip: "border-info/40 bg-info/10 text-info",
    dot: "bg-info",
  },
  positive: {
    row: "border-l-trend-positive bg-trend-positive/5",
    text: "text-trend-positive",
    chip:
      "border-trend-positive/40 bg-trend-positive/10 text-trend-positive",
    dot: "bg-trend-positive",
  },
  wait: {
    row: "border-l-border",
    text: "text-muted-foreground",
    chip: "border-border bg-muted/30 text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
};

export function laneLabel(lane: DecisionLane): string {
  if (lane === "act") return "Act next";
  if (lane === "investigate") return "Investigate";
  if (lane === "protect") return "Protect";
  return "Wait";
}

export function MobileCellLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground lg:hidden">
      {children}
    </div>
  );
}

export function EvidenceLine({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <p>
      <span className="font-medium text-foreground">{label}:</span> {children}
    </p>
  );
}

/** The shortest true thing about one surface, for a line that has to fit two.
 * `unknown` is spelled rather than omitted: in a disagreeing pair, a silently
 * missing surface reads as the pair agreeing. */
export const AIO_SURFACE_PHRASE: Record<AiOverviewGlyphState, string> = {
  unknown: "not checked",
  absent: "none",
  cited: "cites us",
  uncited: "shown, not cited",
};

/** Every device the panel read, named only when it read more than one — a
 * device column that never varies is noise. Empty string when the panel covered
 * nothing here, which callers render as no line at all: absence is "not
 * tracked", never "no overview". */
export function aioSurfaceLine(readings: SerpPanelAioReading[]): string {
  if (readings.length === 0) return "";
  const named = readings.length > 1;
  return readings
    .map((reading) => {
      const phrase = AIO_SURFACE_PHRASE[aiOverviewGlyphState(reading)];
      return named
        ? `${serpPanelDeviceNoun(reading.device)}: ${phrase}`
        : phrase;
    })
    .join(" · ");
}

/** The four counts above a decision table. Same words on both surfaces, because
 * they are the same four lanes. */
export function DecisionLaneSummary({
  counts,
  total,
  totalLabel,
}: {
  counts: Record<DecisionLane, number>;
  total: number;
  totalLabel: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-y border-border py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        {totalLabel} · {formatInt(total)}
      </span>
      <DecisionCount count={counts.act} label="Act next" tone="opportunity" />
      <DecisionCount
        count={counts.investigate}
        label="Investigate"
        tone="investigate"
      />
      <DecisionCount
        count={counts.protect}
        label="Strong / growing"
        tone="positive"
      />
      <DecisionCount
        count={counts.wait}
        label="Wait for evidence"
        tone="wait"
      />
    </div>
  );
}

function DecisionCount({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: DecisionTone;
}) {
  const colors = DECISION_TONE_CLASSES[tone];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", colors.dot)} aria-hidden />
      <strong className={cn("tabular-nums", colors.text)}>
        {formatInt(count)}
      </strong>{" "}
      {label}
    </span>
  );
}
