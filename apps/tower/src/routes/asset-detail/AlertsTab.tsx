import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { AssetDetailPayload } from "@shared/asset-detail";
// The alert row is the registry's, and since bead `ro-78qo.17` it IS doc 21's
// `ListRow` — so this tab composes it rather than drawing a second one.
import { AlertRow } from "@/components/AlertRow";
import { ListPanel } from "@/components/surface/ListPanel";
import { Hero } from "@/routes/asset-detail/shared";

/**
 * THE ALERTS TAB — every alert this asset has ever raised, open first
 * (`ro-pbzu.4`, restyled to doc 21 under `ro-78qo.5`).
 *
 * TWO PANELS, NOT SEVEN CARDS. It was one `SectionCard` of settled alerts with a
 * paragraph under its heading, and each alert a bordered box of its own carrying
 * a severity dot, a headline, four dated facts, a chip row and an action row —
 * fifteen boxes stacked at the same weight, which is the "scattered rectangles"
 * the operator named. Doc 21's answer is a list: a mark, what it is, how long it
 * has been open, and the evidence and the verbs revealed IN PLACE when the row
 * is opened.
 *
 * THE OPEN PANEL IS THE ANSWER, so it is the declared hero and it shows five
 * rows rather than three: alerts are what this tab is for, and a queue of six
 * that shows three has hidden half of itself. History opens at NONE — the count
 * in its header says how much is there, and a settled alert is evidence you go
 * looking for, never something that needs you today.
 *
 * The open queue used to be somewhere else entirely — the state hero above every
 * tab — and this tab held only the history, which is why it opened on alerts
 * that were already dealt with. That hero stood down on the rebuilt tabs
 * (`ro-78qo.5`), so the queue is here, where the verbs are and where an operator
 * pressing "Alerts" expects to find it.
 */
export function AlertsTab({
  data,
  nowMs,
}: {
  data: AssetDetailFor<"alerts">;
  nowMs: number;
}) {
  const { flags } = data;
  const assetId = data.asset.id;
  return (
    <div className="flex flex-col gap-3.5">
      <Hero id="alerts">
        <ListPanel
          title="Open"
          count={openCount(flags)}
          limit={5}
          empty="Nothing is open on this site."
        >
          {flags.open.map((flag) => (
            <AlertRow key={flag.id} flag={flag} nowMs={nowMs} assetId={assetId} />
          ))}
        </ListPanel>
      </Hero>

      {/* PARKED, under Open and never in History (bead `ro-ujb9.194`): a snooze
          is put off, not settled, and comes back on its date. The same panel
          `/alerts` draws, absent when nothing is parked. */}
      {flags.snoozed.length > 0 ? (
        <ListPanel
          title="Snoozed"
          count={`${flags.snoozed.length} parked`}
          limit={flags.snoozed.length}
        >
          {flags.snoozed.map((flag) => (
            <AlertRow key={flag.id} flag={flag} nowMs={nowMs} assetId={assetId} snoozed />
          ))}
        </ListPanel>
      ) : null}

      {flags.notCurrent.length > 0 ? (
        <ListPanel
          title="No longer current"
          count={`${flags.notCurrent.length} of them`}
        >
          {flags.notCurrent.map((flag) => (
            <AlertRow key={flag.id} flag={flag} nowMs={nowMs} assetId={assetId} />
          ))}
        </ListPanel>
      ) : null}

      <div id="alert-history" className="scroll-mt-4">
        <ListPanel
          title="History"
          count={historyCount(flags.history.length)}
          // Collapsed to nothing (doc 21): the header states the size of the
          // history and the rows are one press away. A settled alert has no claim
          // on a screen the operator opened to see what is wrong now.
          limit={0}
          empty="No alert on this site has been settled yet."
        >
          {flags.history.map((flag) => (
            <AlertRow key={flag.id} flag={flag} nowMs={nowMs} assetId={assetId} history />
          ))}
        </ListPanel>
      </div>
      {/* NO ABOUT (bead `ro-ujb9.96.6.7`). Its three paragraphs defined
          Confirmed and Last known, said what First seen does not prove, and
          listed what the verbs do. Each of those is now on the thing itself: the
          verification wears a glyph (a solid tick or a dashed ring) and its
          checks are rows in the Evidence panel, a repeating condition carries
          its "4× in 4d" chip, and the verbs are the buttons in the opened row. */}
    </div>
  );
}

/** The open queue's count, in the two numbers that decide whether it can wait. */
function openCount(flags: AssetDetailPayload["flags"]): string | undefined {
  if (flags.open.length === 0) return undefined;
  const parts: string[] = [];
  if (flags.openError > 0) parts.push(`${flags.openError} error`);
  if (flags.openWarn > 0) parts.push(`${flags.openWarn} warning`);
  parts.push(`${flags.open.length} in all`);
  return parts.join(" · ");
}

function historyCount(total: number): string | undefined {
  if (total === 0) return undefined;
  return `${total} settled`;
}
