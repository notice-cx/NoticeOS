import { Sparkles } from "lucide-react";
import {
  type SerpPanelAioReading,
  aiOverviewGlyphState,
  serpPanelDeviceNoun,
} from "@shared/asset-detail";
import { cn } from "@/lib/utils";

/**
 * What a surface does with a device the panel pulled and could not answer for
 * (bead `ro-glf`). The ONE thing the two call sites disagree about, and the
 * reason this is a prop rather than a decision made here:
 *
 *   `blank` — hold the slot with an empty mark, so a pair stays column-aligned
 *   `omit`  — draw nothing at all for that surface
 *
 * `SerpPanelBoard` needs the slot: its glyph cell sits in a fixed row grid and
 * a collapsed pair would slide the desktop mark under the phone column, which
 * reads as a term checked on the phone alone. `QueryVisibilityRankings` draws
 * its pair inline beside a decision chip with no column to align to, so an
 * empty span there is a mark the reader has to account for — and the row's
 * evidence line already SPELLS the unchecked surface in words.
 *
 * Neither is the default. Flattening this into whichever behaviour got
 * extracted first would have made one of the two surfaces lie about an unknown.
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
 * The AI-Overview mark for one tracked query, one per surface it was read on.
 *
 * ONE COMPONENT, TWO SURFACES (bead `ro-glf`). `SerpPanelBoard` and
 * `QueryVisibilityRankings` drew this vocabulary from the same readings on the
 * same page out of two local copies held together by a comment in each file.
 * That was fair when it was two lines off two booleans; `ro-e46.2` grew it into
 * a per-device pair with surface prefixes, a shared state map and a blank-slot
 * case, and twenty duplicated lines synchronised by prose is the near-duplicate
 * REGISTRY.md's first rule rejects. The failure mode is specific: the next
 * state, device, or tooltip lands in one file, and one page then shows the same
 * fact two ways — which is exactly what doc 14 forbids and what both doc
 * comments claimed was prevented.
 *
 * THREE WEIGHTS, NO COLOR (doc 17). Severity color belongs to the attention
 * system, and an AI Overview is a fact about the result page rather than an
 * alert:
 *
 *   solid    — an overview fires and cites this asset
 *   outline  — an overview fires and does not
 *   ghosted  — the page was read and carried no overview
 *
 * The fourth state has no weight, on purpose. `unknown` is the overview that
 * never loaded on that pull, and there is no mark for it because absence must
 * keep meaning "nobody could answer" — which is precisely why the read-and-clear
 * case earns its own ghosted mark instead of no mark at all. What varies between
 * the two callers is only whether that unknown keeps its slot; see
 * `AiOverviewUnknownSurface`.
 *
 * PHONE THEN DESKTOP, in the order the readings arrive (`ro-e46.2`) — a term
 * walled on the phone and clear on the desktop is two facts and the split is
 * the finding. Each mark names its own surface once more than one was read;
 * a single-surface term draws one unprefixed mark, exactly as before the split,
 * because nothing renders a device the snapshot did not observe.
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
  // Nothing to say and no column to hold: the whole cell goes, rather than an
  // empty wrapper the layout still spends a gap on.
  if (unknownSurface === "omit" && drawn.length === 0) return null;
  // Named off EVERY reading, not the drawn ones. A pair whose phone went
  // unanswered still labels the desktop mark, because "Desktop:" is what tells
  // the reader the other surface exists and is missing.
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

/** One surface's mark. Split out so the unknown slot and the three weights are
 * one `if` apart rather than a conditional inside a map. */
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
