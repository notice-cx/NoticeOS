import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { AssetDetailPayload } from "@shared/asset-detail";
// The alert row is the registry's `ListRow`, so this tab composes it rather
// than drawing a second one.
import { AlertRow } from "@/components/AlertRow";
import { ListPanel } from "@/components/surface/ListPanel";
import { Hero } from "@/routes/asset-detail/shared";
import { FinishLine } from "@/components/surface/FinishLine";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { alertsLine } from "@/lib/alerts-line";

/**
 * The Alerts tab: every alert this asset has ever raised, open first, as a
 * list whose rows reveal their evidence and verbs in place. The open panel is
 * the hero and shows five rows rather than three: a queue of six that shows
 * three has hidden half of itself. History opens at none; the count in its
 * header says how much is there.
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
      {/* One answer first, in /alerts' own words (`alertsLine`). With nothing
          open the answer is the whole of it: no empty panels saying "nothing"
          twice more. */}
      <PageAnswer
        answer={alertsLine(flags.open)}
        detail={flags.history.length > 0 ? `${flags.history.length} settled` : undefined}
        marks={{ "data-site-alerts-answer": flags.open.length === 0 ? "clear" : flags.openError > 0 ? "error" : "warn" }}
      />
      <Hero id="alerts">
        {flags.open.length > 0 ? (
          <ListPanel
            title="Open"
            count={openCount(flags)}
            limit={5}
          >
            {flags.open.map((flag) => (
              <AlertRow key={flag.id} flag={flag} nowMs={nowMs} assetId={assetId} />
            ))}
          </ListPanel>
        ) : (
          <FinishLine quiet line="All clear." />
        )}
      </Hero>

      {/* Parked, under Open and never in History: a snooze is put off, not
          settled, and comes back on its date. The same panel `/alerts` draws,
          absent when nothing is parked. */}
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
        {flags.history.length > 0 ? (
          <ListPanel
            title="History"
            count={historyCount(flags.history.length)}
            // Collapsed to nothing: the header states the size of the history
            // and the rows are one press away.
            limit={0}
          >
            {flags.history.map((flag) => (
              <AlertRow key={flag.id} flag={flag} nowMs={nowMs} assetId={assetId} history />
            ))}
          </ListPanel>
        ) : null}
      </div>
      {/* No About panel: the verification wears a glyph and its checks are
          rows in the Evidence panel, a repeating condition carries its "4× in
          4d" chip, and the verbs are the buttons in the opened row. */}
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
