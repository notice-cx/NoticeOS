import type { WatchOutcome } from "@shared/asset-detail";
import type { StateTone } from "@/components/StateChip";
import type { ListRowTone } from "@/components/surface/ListPanel";

/**
 * The evaluator's four verdicts, in the operator's words. A confirmed decline
 * is `warn`, not `error`: a bet that did not pay is a result, not an incident.
 * The two undecided verdicts stay muted, so "we could not tell" never looks
 * like news.
 */
export const WATCH_OUTCOME: Record<
  WatchOutcome,
  { label: string; tone: ListRowTone; chip: StateTone; glyph: string }
> = {
  ship_confirmed: { label: "Improvement confirmed", tone: "ok", chip: "affirmative", glyph: "▲" },
  kill_confirmed: { label: "Decline confirmed", tone: "warn", chip: "caution", glyph: "▼" },
  inconclusive: { label: "No clear change", tone: "info", chip: "na", glyph: "=" },
  unmeasurable: { label: "Could not be measured", tone: "info", chip: "na", glyph: "?" },
};

/** A stored verdict string as its entry, or `null` for one this table has never
 * heard of — the caller says "verdict recorded" rather than printing the raw
 * value. */
export function watchOutcome(verdict: string | null | undefined) {
  return verdict && Object.hasOwn(WATCH_OUTCOME, verdict)
    ? WATCH_OUTCOME[verdict as WatchOutcome]
    : null;
}
