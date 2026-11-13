import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { RangeDays, SurfaceSpan } from "@shared/surface";
import { BarStrip } from "@/components/viz/BarStrip";
import { DailyMeasureChart } from "@/components/viz/DailyMeasureChart";
import { StatTile, type StatRole } from "@/components/viz/StatTile";
import { useConnections } from "@/hooks/useConnections";
import { useView } from "@/hooks/useView";
import { formatInt, formatPeriodMonthLong, formatSignedMoney, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { siteHealthRow } from "@/lib/viz-adapters";
import { useAssetTabPath } from "./AssetTabs";
import { ledgerMonth } from "./overview-metrics";
import { chartedMeasure, landmarks, overviewMeasures, partialDays, type Measure, type MeasureKey } from "./overview-measures";
import { MEASURE_PRIORITY, prioritize } from "./purpose-presentation";
import { timelineAnnotations, watchSpans } from "./shared";
import { watchSeriesLabel } from "@shared/watch-windows";

const quietLink = "whitespace-nowrap rounded-sm text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

export function useOverviewMeasures(data: AssetDetailFor<"overview">, days: RangeDays, nowMs: number): Measure[] {
  const connections = useConnections();
  const { view } = useView();
  const row = siteHealthRow({ id: data.asset.id, displayName: data.asset.displayName, dataSources: data.integrations.sources }, connections, nowMs);
  const report = row.cells.find((cell) => cell.column === "nightly-report");
  const reportLate = report?.state === "failing" || report?.state === "overdue";
  return prioritize(overviewMeasures(data, days, nowMs, reportLate), MEASURE_PRIORITY[view.id]);
}

// --- the site's numbers ------------------------------------------------------

const COLUMNS: Record<number, string> = {
  1: "@md:grid-cols-1",
  2: "@md:grid-cols-2",
  3: "@md:grid-cols-2 @3xl:grid-cols-3",
  4: "@md:grid-cols-2 @3xl:grid-cols-4",
};

const ROLE: Record<MeasureKey, StatRole> = { money: "money", people: "people", search: "people", product: "context" };
const INK: Record<MeasureKey, string> = { money: "text-financial-revenue", people: "text-traffic", search: "text-traffic", product: "text-foreground" };
const ALERT_INK = { error: "text-error", warn: "text-warn" } as const;

/**
 * The hero row: money, people, search and the site's product figure, each a
 * figure with its window, its change against the window before, its recent
 * days and one line of context; pressing one draws it on the chart below,
 * which opens on what a fresh alert is about.
 */
export function OverviewNumbers({ data, measures, days, nowMs }: {
  data: AssetDetailFor<"overview">;
  measures: readonly Measure[];
  days: RangeDays;
  nowMs: number;
}) {
  const [picked, onPick] = useState<MeasureKey | null>(null);
  const charted = chartedMeasure(measures, picked, nowMs);
  const assetTabPath = useAssetTabPath();
  const id = data.asset.id;
  const link: Record<MeasureKey, { label: string; to: string }> = {
    money: { label: "Money →", to: assetTabPath(id, "financials") },
    people: { label: "Growth →", to: assetTabPath(id, "growth") },
    search: { label: "Search →", to: assetTabPath(id, "search") },
    product: { label: "Growth →", to: assetTabPath(id, "growth") },
  };
  if (measures.length === 0) {
    return (
      <section aria-label="The asset's numbers" data-overview-numbers="empty" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card px-5 py-4 ring-1 ring-inset ring-border">
        <span className="text-sm text-muted-foreground">No numbers reported yet</span>
        <Link to={assetTabPath(id, "sources")} className={quietLink}>Data sources →</Link>
      </section>
    );
  }
  const watches = chartWatches(data, charted?.key ?? null, nowMs);
  return (
    <section aria-label={`The asset's numbers · last ${days} days`} data-overview-numbers="" className="flex flex-col gap-3">
      <div className={cn("grid gap-3", COLUMNS[measures.length])}>
        {measures.map((measure) => {
          const role: StatRole = measure.alert ? (measure.alert.severity === "error" ? "problem" : "warning") : ROLE[measure.key];
          const ink = measure.alert ? ALERT_INK[measure.alert.severity] : INK[measure.key];
          const stat = (
            <StatTile
              label={`${measure.name}, ${measure.window}`}
              value={measure.value}
              format={measure.format}
              absent={measure.absent}
              note={measure.estimated ? (measure.key === "money" && ledgerMonth(data.ledger)?.booking === "booked" ? "est. · unbooked" : "est.") : undefined}
              comparison={measure.comparison}
              history={measure.history.length >= 3 ? (
                <BarStrip
                  data={measure.history}
                  tone={ink}
                  provisionalFrom={measure.provisionalFrom}
                  partial={partialDays(measure)}
                  baseline={measure.usual ? { value: measure.usual.value, label: shortUsual(measure) } : null}
                  format={measure.format}
                  ariaLabel={`${measure.name}, ${measure.history.length >= 28 ? "last 28 days" : "recent days"}`}
                  className="h-14"
                />
              ) : undefined}
              context={<MeasureContext measure={measure} data={data} days={days} />}
              role={role}
              to={measure.days.length === 0 ? link[measure.key].to : undefined}
              className={cn("h-full", charted?.key === measure.key && "ring-2 ring-primary/70")}
            />
          );
          return measure.days.length === 0 ? (
            <div key={measure.key} data-measure={measure.key} className="min-w-0">{stat}</div>
          ) : (
            <button
              key={measure.key}
              type="button"
              data-measure={measure.key}
              aria-pressed={charted?.key === measure.key}
              onClick={() => onPick(measure.key)}
              className="min-w-0 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {stat}
            </button>
          );
        })}
      </div>

      {charted ? (
        <div className="rounded-xl bg-card p-5 ring-1 ring-inset ring-border" data-surface-hero="">
          <DailyMeasureChart
            measure={charted}
            landmarks={landmarks(charted)}
            tone={INK[charted.key]}
            changes={timelineAnnotations(data.annotations.items, data.osTimeZone)}
            watches={watches}
            alertTo={assetTabPath(id, "alerts")}
            action={<Link to={link[charted.key].to} className={quietLink}>{link[charted.key].label}</Link>}
          />
        </div>
      ) : null}
    </section>
  );
}

/** The usual level in the few words a stat's strip has room for. */
function shortUsual(measure: Measure): string {
  if (!measure.usual) return "";
  const value = measure.key === "money" ? measure.axis(measure.usual.value) : formatInt(Math.round(measure.usual.value));
  return measure.alert ? `normally ~${value}` : measure.usual.label.startsWith("average") ? `avg ${value}` : `prior ${value}`;
}

/** One line under a figure, its key values in bold: what the month made for
 * money, the latest and best day for people and search, the alert or the
 * reports before for the product figure. */
function MeasureContext({ measure, data, days }: { measure: Measure; data: AssetDetailFor<"overview">; days: RangeDays }): ReactNode {
  if (measure.key === "money") {
    const month = ledgerMonth(data.ledger);
    const net = month && month.period ? <>{formatPeriodMonthLong(month.period)} {month.booking === "booked" ? "booked net so far" : "net"} <b>{formatSignedMoney(month.net, month.currency)}</b>{month.booking === "forecast" ? " est." : ""}</> : null;
    if (measure.days.length === 0) return month?.composition || null;
    return (
      <>
        {net}
        {net && measure.reported ? " · " : null}
        {measure.reported ? <><b>{measure.reported.days}</b> of {days} days reported</> : null}
      </>
    );
  }
  if (measure.key === "product") {
    const asOf = measure.asOf ? <>Latest report <b>{formatSeriesDate(measure.asOf)}</b></> : null;
    if (measure.alert) {
      return <>{asOf}{asOf ? " · " : null}Alert since <b>{formatSeriesDate(measure.alert.onset)}</b>{!asOf && measure.usual ? <> · normally <b>~{formatInt(Math.round(measure.usual.value))}</b> a day</> : null}</>;
    }
    if (asOf) return asOf;
    return measure.usual ? <>{measure.usual.label.split(" · ")[0]} <b>{formatInt(Math.round(measure.usual.value))}</b> a day</> : "No earlier reports to compare";
  }
  const { best, newest } = landmarks(measure);
  if (!newest) return measure.reported ? <><b>{measure.reported.days}</b> of {days} days reported</> : null;
  return (
    <>
      {formatSeriesDate(newest.t)} <b>{measure.format(newest.v!)}</b>
      {best && best !== newest ? <> · best <b>{measure.format(best.v!)}</b></> : null}
    </>
  );
}

/** The windows being watched on the charted measure, named by what changed. */
function chartWatches(data: AssetDetailFor<"overview">, key: MeasureKey | null, nowMs: number): SurfaceSpan[] {
  const measured = (integration: string) =>
    integration === "ga4" ? "people" : integration === "gsc" || integration === "bing-webmaster" ? "search" : null;
  const open = data.watches.open.filter((watch) => measured(watch.metricIntegration) === key);
  return watchSpans(open, nowMs).map((span, index) => {
    const watch = open[index]!;
    return {
      ...span,
      label: `Watching ${watch.note ?? watchSeriesLabel(watch.metricIntegration, watch.metric)}${watch.nextCheckDate ? ` · verdict ${formatSeriesDate(watch.nextCheckDate)}` : ""}`,
    };
  });
}
