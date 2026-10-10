import { Sparkles } from "lucide-react";
import {
  type SerpPanelAioReading,
  aiOverviewGlyphState,
  serpPanelDeviceNoun,
} from "@shared/asset-detail";
import { cn } from "@/lib/utils";

/**
 * What a surface does with a device the panel pulled and could not answer for:
 * `blank` holds the slot so a pair stays column-aligned (a fixed grid), `omit`
 * draws nothing (inline beside text that already spells the unknown). A prop
 * with no default, because either choice would misstate an unknown on one of
 * the two callers.
 */
export type AiOverviewUnknownSurface = "blank" | "omit";

export interface AiOverviewGlyphsProps {
  /** One reading per device, in `SERP_PANEL_DEVICE_ORDER`. An empty list is the
   * panel not covering this query at all — which is unknown, not clear. */
  readings: SerpPanelAioReading[];
  unknownSurface: AiOverviewUnknownSurface;
  className?: string;
}

/**
 * The AI Overview mark for one tracked query, one per surface it was read on,
 * phone then desktop. Three weights and no colour, since this is a fact about
 * the result page, not an alert: solid cites this asset, outline does not,
 * ghosted means read with no overview. `unknown` has no mark, so absence keeps
 * meaning "nobody could answer". Marks name their surface only when more than
 * one was read.
 */
export function AiOverviewGlyphs({
  readings,
  unknownSurface,
  className,
}: AiOverviewGlyphsProps) {
  const drawn =
    unknownSurface === "blank"
      ? readings
      : readings.filter((reading) => aiOverviewGlyphState(reading) !== "unknown");
  // Nothing to say and no column to hold: drop the wrapper and its gap.
  if (unknownSurface === "omit" && drawn.length === 0) return null;
  // Named off every reading, not the drawn ones: "Desktop:" tells the reader
  // the other surface exists and is missing.
  const named = readings.length > 1;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1", className)}
      data-aio-devices={readings.length}
    >
      {drawn.map((reading) => (
        <AiOverviewGlyph key={reading.device} reading={reading} named={named} />
      ))}
    </span>
  );
}

/** One surface's mark. */
function AiOverviewGlyph({
  reading,
  named,
}: {
  reading: SerpPanelAioReading;
  named: boolean;
}) {
  const state = aiOverviewGlyphState(reading);
  const surface = named ? `${serpPanelDeviceNoun(reading.device)}: ` : "";
  if (state === "unknown") {
    return (
      <span
        className="size-3 shrink-0"
        data-aio-device={reading.device}
        title={`${surface}AI Overview unknown · did not load`}
      />
    );
  }
  const label = {
    absent: `${surface}${named ? "n" : "N"}o AI Overview on the tracked result page`,
    cited: `${surface}AI Overview cites this site`,
    uncited: `${surface}AI Overview shown; this site is not cited`,
  }[state];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-aio-state={state}
      data-aio-device={reading.device}
      className={cn(
        "inline-flex shrink-0 items-center",
        state === "absent" ? "text-muted-foreground/40" : "text-foreground",
      )}
    >
      <Sparkles
        className={cn("size-3", state === "cited" && "fill-current")}
        aria-hidden
      />
    </span>
  );
}
