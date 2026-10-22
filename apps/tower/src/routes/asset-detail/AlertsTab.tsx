import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { AssetDetailPayload, FlagRecord } from "@shared/asset-detail";
import { translateAlert } from "@shared/alert-language";
// The alert row is the registry's `ListRow`, so this tab composes it rather
// than drawing a second one.
import { AlertRow } from "@/components/AlertRow";
import { ListPanel } from "@/components/surface/ListPanel";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { BarStrip } from "@/components/viz/BarStrip";
import { EventTimeline, type TimelineLane, type TimelineSpan } from "@/components/viz/EventTimeline";
import { NormalBand } from "@/components/viz/NormalBand";
import { Hero } from "@/routes/asset-detail/shared";
import { FinishLine } from "@/components/surface/FinishLine";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { alertsLine } from "@/lib/alerts-line";
import { alertNormal, readingNights, shortHeadline } from "@/lib/alerts-board";
import { cn } from "@/lib/utils";

/** How far back the tab's timeline reaches: long enough to show what came
 * back after it was settled, short enough that a day is still a width. */
const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The Alerts tab: what is wrong on this site and since when. The last thirty
 * days lead, one row per condition, every open alert a bar from its onset to
 * now and what settled a closed one, so a fault that keeps coming back reads
 * as a row of bars. Then the open alerts, each with its reading drawn against
 * the normal its own rule computed; parked, no longer current and settled
 * follow, the history one press away.
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
  const timeline = siteAlertTimeline(flags, nowMs);
  return (
    <div className="flex flex-col gap-3.5">
      {/* One answer first, in /alerts' own words (`alertsLine`). With nothing
          open and nothing settled lately the answer is the whole of it: no
          empty panels saying "nothing" twice more. */}
      <PageAnswer
        answer={alertsLine(flags.open)}
        detail={flags.history.length > 0 ? `${flags.history.length} settled` : undefined}
        marks={{ "data-site-alerts-answer": flags.open.length === 0 ? "clear" : flags.openError > 0 ? "error" : "warn" }}
      />
      <Hero id="alerts">
        <div className="flex flex-col gap-3.5">
          {timeline.spans.length > 0 ? (
            <section aria-label={`The last ${WINDOW_DAYS} days`} data-site-alert-timeline="" className="rounded-xl bg-card px-5 pb-3 pt-4 ring-1 ring-border/70">
              <h2 className={cn("m-0 pb-1", eyebrowClass)}>Last {WINDOW_DAYS} days</h2>
              <EventTimeline
                lanes={timeline.lanes}
                spans={timeline.spans}
                window={{ from: new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString(), to: new Date(nowMs).toISOString() }}
                nowMs={nowMs}
                timeZone={data.osTimeZone}
                ariaLabel={`Open and settled alerts on ${data.asset.displayName} over the last ${WINDOW_DAYS} days`}
                className="[--timeline-name:12rem]"
              />
            </section>
          ) : null}
          {flags.open.length > 0 ? (
            <ListPanel
              title="Open"
              count={openCount(flags)}
              limit={5}
            >
              {flags.open.map((flag) => (
                <AlertRow key={flag.id} flag={flag} nowMs={nowMs} assetId={assetId} evidence={alertNormal(flag) ? <Reading flag={flag} /> : undefined} />
              ))}
            </ListPanel>
          ) : (
            <FinishLine quiet line="All clear." />
          )}
        </div>
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
            // Collapsed to nothing: the timeline above draws the history and
            // the rows are one press away.
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

/**
 * The reading against its rule's normal, and the nights behind it when the
 * condition kept more than one: whether tonight is a dip or the latest of a
 * run. Nothing when the rule kept no normal.
 */
function Reading({ flag }: { flag: FlagRecord }) {
  const normal = alertNormal(flag);
  if (!normal) return null;
  const nights = readingNights(flag);
  const tone = flag.severity === "error" ? "text-error" : "text-warn";
  return (
    <div className={cn("grid gap-x-6 gap-y-2", nights ? "max-w-3xl sm:grid-cols-2" : "max-w-md")} data-alert-reading="">
      <NormalBand
        value={normal.value}
        low={normal.low}
        high={normal.high}
        label={normal.label}
        unit={normal.unit}
        bad={normal.bad}
        severity={flag.severity === "error" ? "error" : "warn"}
        format={normal.format}
      />
      {nights ? (
        <BarStrip
          data={nights}
          tone={tone}
          baseline={normal.level}
          format={normal.format}
          ariaLabel={`${normal.label}, each night it was read`}
          className="h-10 self-end"
        />
      ) : null}
    </div>
  );
}

/**
 * The window's rows and bars: one row per condition (a rule on a metric),
 * open conditions first and the worst of them leading, every open alert a bar
 * from its onset to now and every alert settled inside the window a closed
 * bar on the same row. A milestone is news, not a problem that ran from onset
 * to a fix, so it draws none.
 */
export function siteAlertTimeline(
  flags: AssetDetailPayload["flags"],
  nowMs: number,
): { lanes: TimelineLane[]; spans: TimelineSpan[] } {
  const start = nowMs - WINDOW_DAYS * DAY_MS;
  const condition = (flag: FlagRecord) => `${flag.ruleId}:${flag.metric ?? ""}`;
  const label = (flag: FlagRecord) => shortHeadline(translateAlert(flag).headline);
  const problem = (flag: FlagRecord) => flag.kind !== "milestone" && flag.severity !== "info";
  const lanes = new Map<string, TimelineLane & { rank: number }>();
  const spans: TimelineSpan[] = [];
  const lane = (flag: FlagRecord, rank: number) => {
    const key = condition(flag);
    const found = lanes.get(key);
    if (!found) lanes.set(key, { id: key, label: label(flag), rank });
    else found.rank = Math.min(found.rank, rank);
    return key;
  };
  for (const flag of flags.open) {
    if (!problem(flag)) continue;
    spans.push({
      id: `open:${flag.id}`,
      lane: lane(flag, flag.severity === "error" ? 0 : 1),
      from: flag.firstFiredAt,
      to: null,
      severity: flag.severity === "error" ? "error" : "warn",
      label: label(flag),
    });
  }
  for (const flag of flags.history) {
    const closed = flag.resolvedAt ?? flag.dispositionAt;
    if (!problem(flag) || closed === null || Date.parse(closed) < start) continue;
    spans.push({
      id: `settled:${flag.id}`,
      lane: lane(flag, 2),
      from: flag.firstFiredAt,
      to: closed,
      severity: flag.severity === "error" ? "error" : "warn",
      label: label(flag),
    });
  }
  const ordered = [...lanes.values()].sort((a, b) => a.rank - b.rank);
  return { lanes: ordered.map(({ rank: _rank, ...rest }) => rest), spans };
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
