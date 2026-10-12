import { translateAlert } from "@shared/alert-language";
import { ageMs, formatAge } from "@shared/freshness";
import type { SnoozedItem } from "@shared/wall";
import { ALERT_EVIDENCE_QUESTION, alertPopoverEvidence } from "@/components/AlertRow";
import { AlertVerification } from "@/components/AlertVerification";
import { EvidencePopover } from "@/components/EvidencePopover";
import { FlagActions } from "@/components/FlagActions";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SnoozeUntil } from "@/components/SnoozeUntil";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AlertMark, BoardRow } from "@/routes/alerts/BoardRow";

/**
 * What the operator put off, and until when: a snooze with no visible row
 * would be a mute. It belongs to Open (deferred, not settled), ignores the
 * filters so a dropdown cannot hide a parked row, and lists info and
 * milestone rows too, because Snooze is offered on every open row. A parked
 * row asks for nothing, so it wears the muted mark whatever its severity;
 * what it was is inside, with the way back.
 */
export function SnoozedAlerts({ items, nowMs }: { items: readonly SnoozedItem[]; nowMs: number }) {
  if (items.length === 0) return null;
  const soonest = [...items].sort((a, b) => a.snoozeUntil.localeCompare(b.snoozeUntil));
  return (
    <section aria-label="Snoozed" data-snoozed-alerts="" className="@container flex flex-col rounded-xl ring-1 ring-border/70">
      <header className="flex items-baseline gap-3 px-5 pb-1 pt-4">
        <h2 className={cn("m-0", eyebrowClass)}>Snoozed</h2>
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatInt(items.length)} parked</span>
      </header>
      <ul className="m-0 list-none px-2 pb-2">
        {soonest.map((item) => {
          const alert = translateAlert(item);
          return (
            <BoardRow
              key={item.id}
              marks={{ "data-alert-row": String(item.id), "data-flag-severity": item.severity, "data-visual-state": "snoozed" }}
              quiet
              mark={<AlertMark severity={item.severity} parked />}
              title={
                <>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <PropertyFavicon domain={item.asset} displayName={item.assetDisplayName} className="size-4" />
                    {item.assetDisplayName}
                  </span>
                  <span aria-hidden className="text-muted-foreground">
                    {" · "}
                  </span>
                  {alert.headline}
                </>
              }
              caption={
                <>
                  <AlertVerification verification={item.verification} firstDetectedAt={item.firstFiredAt} nowMs={nowMs} interactive={false} />
                  {" · "}
                  {/* Each part of the date stays whole; the chip wraps between them. */}
                  <SnoozeUntil until={item.snoozeUntil} nowMs={nowMs} className="flex-wrap [&>*]:whitespace-nowrap" />
                </>
              }
              age={formatAge(ageMs(nowMs, item.firstFiredAt))}
              ageLabel="first detected"
              ageLabelAlways
              actions={<FlagActions flagId={item.id} assetId={item.asset} snoozed />}
            >
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <EvidencePopover
                  evidence={alertPopoverEvidence(alert, item, nowMs)}
                  question={ALERT_EVIDENCE_QUESTION}
                  contextLabel={item.ruleId}
                  nowMs={nowMs}
                  triggerLabel="Evidence"
                />
              </span>
            </BoardRow>
          );
        })}
      </ul>
    </section>
  );
}
