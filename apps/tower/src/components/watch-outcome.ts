import type { WatchOutcome } from "@shared/asset-detail";
import type { StateTone } from "@/components/StateChip";
import type { ListRowTone } from "@/components/surface/ListPanel";

/**
 * The evaluator's four verdicts, in the operator's words (`ro-78qo.5`), with a
 * direction glyph and a chip tone of their own (bead `ro-ujb9.96.6.6`).
 *
 * The ROW's tone colours its mark: `ok` is the health green a confirmed
 * improvement earns; a confirmed DECLINE is `warn` rather than `error`, because
 * a bet that did not pay is a result, not an incident. The two undecided
 * verdicts stay muted: they are the absence of a finding, and colouring them
 * would make "we could not tell" look like news. The CHIP carries the verdict's
 * words once, with a glyph so the verdict is never colour-only (doc 14).
 *
 * Its own module since bead `ro-ujb9.96.6.14`: an alert row that owes a
 * decision printed the stored enum ("verdict: kill_confirmed") because this
 * table lived inside the watch composer. The pre-registered checks list and the
 * alert row now name one verdict with one chip.
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
