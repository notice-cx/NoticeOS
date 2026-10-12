import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import type {
  AssetDetailPayload,
  ExecutiveEvidence,
  ExecutiveInsight,
  ExecutiveInsightKind,
  PulseMetric,
  SearchQueryTrends,
  SiteCounters,
} from "@shared/asset-detail";
import { translateAlert } from "@shared/alert-language";
import { assetSetupChecklist } from "@shared/asset-setup";
import { sourceReadings } from "@shared/connection-status";
import { revenueCalendarDate } from "@shared/daily-revenue";
import { ageMs, formatAge, isAmber, pulseAmber } from "@shared/freshness";
import { productReportSummary } from "@shared/product-reports";
import type { RangeDays, SurfaceSpan } from "@shared/surface";
import { watchScopeText, watchSeriesForSources, watchSeriesLabel, watchVerdictFigures, type WatchSeed } from "@shared/watch-windows";
import { WATCH_SERIES } from "@noticeos/contract/create-watch-window";
import { WORK_POLL_CADENCE_HOURS } from "@shared/work";
import { AgeBadge } from "@/components/AgeBadge";
import { betsFact, daysUntil, timelineAnnotations, watchSpans } from "@/routes/asset-detail/shared";
import { ExecutiveFindingsList } from "@/components/ExecutiveFindingsList";
import { AnalysisEvidence, RecommendationReview, useRecommendationAssessor, useRecommendationValidity } from "@/components/AnalysisEvidence";
import { findingBasis } from "@shared/recommendation-validity";
import { InfoTooltip } from "@/components/InfoTooltip";
import {
  EXECUTIVE_INSIGHT_META,
  findingTaskHandoff,
  savedEvidenceLabel,
} from "@/components/ExecutiveInsightRow";
import { SectionLabel } from "@/components/surface/SectionLabel";
import {
  ListPanel,
  ListRow,
} from "@/components/surface/ListPanel";
import {
  SmallMultiple,
  SmallMultipleStrip,
} from "@/components/surface/SmallMultiple";
import { Sparkline } from "@/components/surface/Sparkline";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { BarStrip } from "@/components/viz/BarStrip";
import { FitLabel } from "@/components/viz/FitLabel";
import { IncidentList, type Incident } from "@/components/viz/IncidentList";
import { StatTile, type StatRole } from "@/components/viz/StatTile";
import { watchOutcome } from "@/components/watch-outcome";
import { cn } from "@/lib/utils";
import { FileTaskButton } from "@/components/TaskComposer";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/useConnections";
import { useDecisionWriters } from "@/hooks/useDecisionWriters";
import {
  formatCalendarDate,
  formatCalendarRange,
  formatInt,
  formatPeriodMonth,
  formatPeriodMonthLong,
  formatSignedMoney,
  formatSeriesDate,
} from "@/lib/format";
import { findingEvidenceUrl, taskHandoffPrefill } from "@/lib/task-handoff";
import { siteHealthRow, sourceColumns } from "@/lib/viz-adapters";
import { useAssetTabPath } from "@/routes/asset-detail/AssetTabs";
import { alertPosture, ledgerMonth } from "@/routes/asset-detail/overview-metrics";
import {
  chartedMeasure,
  drawnBySourceRow,
  landmarks,
  overviewMeasures,
  partialDays,
  rankedFlags,
  sourceHistory,
  type Measure,
  type MeasureKey,
} from "@/routes/asset-detail/overview-measures";
import { OverviewChart } from "@/routes/asset-detail/OverviewChart";
import { SiteLead, siteLead } from "@/routes/asset-detail/SiteLead";
import { SourceHistory } from "@/routes/asset-detail/SourceHistory";
import { useRange } from "@/routes/asset-detail/useRange";
import { askFace } from "@/routes/tasks/task-face";

/**
 * The Overview tab, the index tab, so `/assets/:id` is this. It answers one
 * question in three parts: how is this site doing (its numbers over one
 * chart), what needs the operator (what broke, data that stopped arriving,
 * the queue), and what matters (findings, bets, search movers). The numbers
 * follow the selected day range; the product figure is the latest report and
 * the data sources are the last thirty days.
 */
export function OverviewTab({
  data,
  nowMs,
  onWatch,
}: {
  data: AssetDetailFor<"overview">;
  nowMs: number;
  onWatch: (seed: WatchSeed) => void;
}) {
  const { days } = useRange();
  const assetTabPath = useAssetTabPath();
  const [allFindings, setAllFindings] = useState(false);
  const [picked, setPicked] = useState<MeasureKey | null>(null);
  const { credentials, items } = useConnections();
  // Tasks is core; missing readings stay unknown rather than hiding the inbox.

  const setup = assetSetupChecklist({
    id: data.asset.id,
    displayName: data.asset.displayName,
    status: data.asset.status,
    sources: sourceReadings(data.asset.id, data.integrations.sources, { credentials, items }, nowMs),
    firstReportAt: data.asset.firstReportAt,
    reportDays: data.asset.reportDays,
    latestReportAt: data.freshness.pulseReceivedAt,
    noNightlyReport: data.asset.noNightlyReport,
    nowMs,
  });
  const money = ledgerMonth(data.ledger);
  const moneyPeriod = data.ledger.periods[0]?.period ?? null;
  const alerts = alertPosture(data.flags);

  // The site's sources read exactly as Home's grid reads them, so the state
  // at the end of each row here is the state of its cell there.
  const card = { id: data.asset.id, displayName: data.asset.displayName, dataSources: data.integrations.sources };
  const sourceRow = siteHealthRow(card, { credentials, items }, nowMs);
  const reportCell = sourceRow.cells.find((cell) => cell.column === "nightly-report");
  const reportLate = reportCell?.state === "failing" || reportCell?.state === "overdue";
  const history = sourceHistory(data, sourceRow, sourceColumns([card]), revenueCalendarDate(new Date(nowMs), data.osTimeZone));

  const measures = overviewMeasures(data, days, nowMs, reportLate);
  const charted = chartedMeasure(measures, picked, nowMs);
  // A site with no daily traffic, revenue or product analytics but a rolling
  // session report or a weekly ranking keeps that report beside its numbers.
  const report = siteLead(data, days, nowMs);

  // Each open problem appears once: the product alert on its figure and its
  // chart, a nightly report that stopped arriving on its source's row.
  const product = measures.find((measure) => measure.key === "product");
  const drawn = new Set<number>([
    ...(product?.alert ? [product.alert.flagId] : []),
    ...(history.rows.some((row) => row.id === "nightly-report") ? data.flags.open.filter(drawnBySourceRow).map((flag) => flag.id) : []),
  ]);
  const incidents: Incident[] = rankedFlags(data.flags.open)
    .filter((flag) => !drawn.has(flag.id))
    .map((flag) => ({
      key: `flag-${flag.id}`,
      severity: flag.severity === "error" ? "error" : "warn",
      title: translateAlert(flag).headline,
      site: data.asset.displayName,
      since: flag.firstFiredAt,
      to: assetTabPath(data.asset.id, "alerts"),
    }));

  return (
    <div className="@container flex flex-col gap-5" data-site-overview="">
      {/* `#setup` lands here (`HASH_TAB`): the checklist is on Sources, so the
          banner saying where it is is what a deep link scrolls to. */}
      {setup ? (
        <div id="setup" className="scroll-mt-4">
          <StatusBanner
            lead="Data setup"
            subject={`asset-setup:${data.asset.id}`}
            ring={{ done: setup.done, total: setup.total, title: setup.title }}
            action={{
              label: "Review data setup",
              to: assetTabPath(data.asset.id, "sources"),
            }}
          >
            {/* A row of values, not a sentence: the fraction, then each step
                still to do by its own name. */}
            {setup.remaining.length === 0
              ? `${setup.done} of ${setup.total} done`
              : `${setup.done} of ${setup.total} done · to do: ${setup.remaining.join(" · ").toLowerCase()}`}
          </StatusBanner>
        </div>
      ) : null}

      {/* The verdict line: three facts joined by dots under the header's
          verdict word, money, alerts, bets, each from the read this tab
          already makes. Never a sentence. */}
      <VerdictLine money={money} moneyPeriod={moneyPeriod} alerts={alerts} watches={data.watches} nowMs={nowMs} />

      {measures.length > 0 || (report.kind !== "clarity" && report.kind !== "rankings") ? (
        <Numbers
          data={data}
          measures={measures}
          charted={charted}
          days={days}
          nowMs={nowMs}
          onPick={setPicked}
        />
      ) : null}
      {report.kind === "clarity" || report.kind === "rankings" ? <SiteLead data={data} days={days} nowMs={nowMs} /> : null}

      <div className="grid gap-5 @6xl:grid-cols-12 [&>*]:min-w-0">
        <SourceHistory
          rows={history.rows}
          notConnected={history.notConnected}
          domain={history.domain}
          nowMs={nowMs}
          className={incidents.length > 0 ? "@6xl:col-span-8" : "@6xl:col-span-12"}
          action={<Link to={assetTabPath(data.asset.id, "sources")} className={quietLink}>Data sources →</Link>}
        />
        {incidents.length > 0 ? (
          <div data-alert-current className="@6xl:col-span-4">
            <IncidentList
              items={incidents}
              nowMs={nowMs}
              title="Open alerts"
              action={{ label: "All alerts →", to: assetTabPath(data.asset.id, "alerts") }}
            />
          </div>
        ) : null}
      </div>

      <div className="grid gap-5 @4xl:grid-cols-2 [&>*]:min-w-0">
        <NeedsYou assetId={data.asset.id} operator={data.operator} nowMs={nowMs} />
        {/* `#insights` is the findings' saved anchor; it names the panel. */}
        <div id="insights" className="min-w-0 scroll-mt-4">
          <WhatMatters
            data={data}
            nowMs={nowMs}
            onWatch={onWatch}
            onAll={() => setAllFindings(true)}
          />
        </div>
      </div>

      <div className="grid gap-5 @3xl:grid-cols-2 [&>*]:min-w-0">
        <Bets watches={data.watches} assetId={data.asset.id} nowMs={nowMs} />
        <SearchMovers trends={data.executive?.searchQueries ?? null} assetId={data.asset.id} />
      </div>

      {/* The product figure the hero row leads with is not stated twice. */}
      <ProductUse assetId={data.asset.id}
        metrics={data.metrics.filter((metric) => metric.name !== product?.metric)}
        reportDate={data.wiring.lastPulseDate} receivedAt={data.wiring.lastPulseReceivedAt} nowMs={nowMs} />

      <SiteTotals counters={data.counters} nowMs={nowMs} />

      {data.executive && data.executive.items.length > 0 ? (
        <details
          open={allFindings}
          onToggle={(event) => setAllFindings(event.currentTarget.open)}
          data-all-findings
          className="group text-xs text-muted-foreground"
        >
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 outline-none hover:text-foreground max-sm:min-h-11 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="group-open:rotate-90 motion-safe:transition-transform">
              ›
            </span>
            All findings · {data.executive.items.length}
          </summary>
          {/* Mounted only once it is opened. A closed `<details>` still holds
              its subtree, and this one is the whole ranked list with its
              evidence, its methodology and its limitations — two thousand
              pixels of prose the operator did not ask for, in the DOM of a page
              whose entire subject is what to read first. */}
          {allFindings ? (
            <div className="mt-2">
              <FullFindings data={data} onWatch={onWatch} />
            </div>
          ) : null}
        </details>
      ) : null}

      {/* No "about these numbers": each fact is drawn on the surface that
          owns it. */}
    </div>
  );
}

const quietLink = "whitespace-nowrap rounded-sm text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

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
function Numbers({ data, measures, charted, days, nowMs, onPick }: {
  data: AssetDetailFor<"overview">;
  measures: readonly Measure[];
  charted: Measure | null;
  days: RangeDays;
  nowMs: number;
  onPick: (key: MeasureKey) => void;
}) {
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
      <section aria-label="The site's numbers" data-overview-numbers="empty" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card px-5 py-4 ring-1 ring-border/70">
        <span className="text-sm text-muted-foreground">No numbers reported yet</span>
        <Link to={assetTabPath(id, "sources")} className={quietLink}>Data sources →</Link>
      </section>
    );
  }
  const watches = chartWatches(data, charted?.key ?? null, nowMs);
  return (
    <section aria-label={`The site's numbers · last ${days} days`} data-overview-numbers="" className="flex flex-col gap-3">
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
              note={measure.estimated ? "est." : undefined}
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
        <div className="rounded-xl bg-card p-5 shadow-raised ring-1 ring-border/70" data-surface-hero="">
          <OverviewChart
            measure={charted}
            tone={INK[charted.key]}
            changes={timelineAnnotations(data.annotations.items)}
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
    const net = month && month.period ? <>{formatPeriodMonthLong(month.period)} net <b>{formatSignedMoney(month.net, month.currency)}</b>{month.booking === "forecast" ? " est." : ""}</> : null;
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

/** The open alerts as the split the operator acts on — "1 error · 2 warnings" —
 * or "None open". Anything open that is neither is counted as info, so the
 * parts always add up to the open total. */
function alertSplit(alerts: ReturnType<typeof alertPosture>): string {
  if (alerts.open === 0) return "None open";
  const info = alerts.open - alerts.error - alerts.warn;
  return [
    alerts.error > 0 ? `${formatInt(alerts.error)} ${alerts.error === 1 ? "error" : "errors"}` : null,
    alerts.warn > 0 ? `${formatInt(alerts.warn)} ${alerts.warn === 1 ? "warning" : "warnings"}` : null,
    info > 0 ? `${formatInt(info)} info` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

// --- the verdict line ------------------------------------------------------
function VerdictLine({
  money,
  moneyPeriod,
  alerts,
  watches,
  nowMs,
}: {
  money: ReturnType<typeof ledgerMonth>;
  moneyPeriod: string | null;
  alerts: ReturnType<typeof alertPosture>;
  watches: AssetDetailFor<"overview">["watches"];
  nowMs: number;
}) {
  const moneyFact = money && moneyPeriod
    ? `${formatPeriodMonth(moneyPeriod)} net ${formatSignedMoney(money.net, money.currency)}${money.booking === "forecast" ? " est." : ""}`
    : "no money recorded";
  const alertsFact = alerts.open === 0 ? "no open alerts" : `${alertSplit(alerts)} open`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-sm text-foreground" data-verdict-line>
      <span className="tabular-nums">{moneyFact}</span>
      <span aria-hidden className="text-muted-foreground">·</span>
      <span className={alerts.error > 0 ? "text-error" : alerts.warn > 0 ? "text-warn" : undefined}>{alertsFact}</span>
      <span aria-hidden className="text-muted-foreground">·</span>
      <span className="tabular-nums">{betsFact(watches, nowMs)}</span>
    </div>
  );
}

// --- bets --------------------------------------------------------------------
/**
 * The bets on this site: every pre-registered outcome check, open first, as
 * one row with its verdict chip, "verdict in N days" while it is being watched
 * and the evaluator's word once it closed (`WATCH_OUTCOME`). No dollars are
 * drawn until the ledger books a change's realized value.
 */
function Bets({ watches, assetId, nowMs }: { watches: AssetDetailFor<"overview">["watches"]; assetId: string; nowMs: number }) {
  const assetTabPath = useAssetTabPath();
  const rows = [
    ...watches.open.map((watch) => ({ watch, open: true })),
    ...watches.closed.map((watch) => ({ watch, open: false })),
  ];
  return (
    <ListPanel
      title="Bets"
      count={watches.open.length > 0 ? `${watches.open.length} being watched` : undefined}
      action={{ label: "Activity", to: assetTabPath(assetId, "activity") }}
      empty="Nothing being watched yet"
    >
      {rows.map(({ watch, open }) => {
        const outcome = watch.outcome ? watchOutcome(watch.outcome) : null;
        const series = watchSeriesLabel(watch.metricIntegration, watch.metric);
        const scope = watch.scope ? ` · ${watchScopeText(watch.scope)}` : "";
        const days = watch.nextCheckDate ? daysUntil(watch.nextCheckDate, nowMs) : null;
        return (
          <ListRow
            key={watch.id}
            marks={{ "data-subject": `watch:${watch.id}`, "data-bet": open ? "open" : "closed" }}
            tone={open ? "info" : (outcome?.tone ?? "info")}
            glyph={open ? "◦" : (outcome?.glyph ?? "?")}
            title={watch.note ?? `${series}${scope}`}
            caption={watch.note ? `${series}${scope}` : `registered ${formatCalendarDate(watch.registeredAt.slice(0, 10))}`}
            value={open
              ? days === null ? `${watch.readings} of ${watch.checks}` : days === 0 ? "today" : `${days}d`
              : outcome?.label ?? "verdict recorded"}
            valueLabel={open ? (days === null ? "checks read" : "to a verdict") : watch.closedAt ? formatCalendarDate(watch.closedAt.slice(0, 10)) : undefined}
          >
            {watch.outcomeNote ? <span>{watchVerdictFigures(watch.outcomeNote, watch.metricIntegration, watch.metric)}</span> : null}
          </ListRow>
        );
      })}
    </ListPanel>
  );
}

// --- search movers -----------------------------------------------------------
/** The queries that moved this week: the three that climbed furthest and the
 * three that fell, from the saved analysis's own like-for-like comparison. The
 * Search tab holds the whole table. */
function SearchMovers({ trends, assetId }: { trends: SearchQueryTrends | null; assetId: string }) {
  const assetTabPath = useAssetTabPath();
  const lane = trends?.google ?? trends?.bing ?? null;
  const movers = lane?.movers ?? [];
  const rising = [...movers].filter((mover) => mover.positionImprovement > 0).sort((a, b) => b.positionImprovement - a.positionImprovement).slice(0, 3);
  const falling = [...movers].filter((mover) => mover.positionImprovement < 0).sort((a, b) => a.positionImprovement - b.positionImprovement).slice(0, 3);
  const position = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return (
    <section aria-label="Search movers" className="@container flex flex-col rounded-[10px] border border-border bg-card" data-search-movers>
      <SectionLabel
        title="Search movers"
        caption={lane ? `${formatCalendarDate(lane.currentStart)} – ${formatCalendarDate(lane.currentEnd)}` : undefined}
        action={{ label: "Search →", to: assetTabPath(assetId, "search") }}
        className="px-4 pb-2 pt-3"
      />
      {rising.length === 0 && falling.length === 0 ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground">{lane ? "Nothing moved this week" : "No search comparison yet"}</div>
      ) : (
        <div className="grid gap-x-6 gap-y-1 px-4 pb-3 @lg:grid-cols-2">
          {[{ word: "Rising", rows: rising, tone: "text-trend-positive", arrow: "▲" }, { word: "Falling", rows: falling, tone: "text-trend-negative", arrow: "▼" }].map((column) => (
            <ul key={column.word} className="m-0 list-none p-0" data-movers={column.word.toLowerCase()}>
              <li className="m-0 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{column.word}</li>
              {column.rows.length === 0 ? <li className="m-0 py-1 text-xs text-muted-foreground">none</li> : column.rows.map((mover) => (
                <li key={mover.query} className="m-0 flex items-baseline justify-between gap-3 border-t border-border/60 py-1.5 text-[13px]" data-subject={`query:${mover.query}`}>
                  <span className="min-w-0 break-words">{mover.query}</span>
                  <span className={cn("shrink-0 tabular-nums", column.tone)}>
                    {column.arrow} {position(mover.previousPosition)}→{position(mover.currentPosition)}
                  </span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
    </section>
  );
}

// --- needs you -------------------------------------------------------------
/** The operator's own queue on this asset, urgent first. Three rows and a link:
 * the board itself is one tab away and does this properly. */
export function NeedsYou({
  assetId,
  operator,
  nowMs,
}: {
  assetId: string;
  operator: AssetDetailPayload["operator"];
  nowMs: number;
}) {
  const location = useLocation();
  const assetTabPath = useAssetTabPath();
  const rows = [...operator.items].sort(
    (left, right) =>
      left.priority - right.priority ||
      (left.updatedAt ?? "").localeCompare(right.updatedAt ?? ""),
  );
  const measured = operator.waiting !== null && operator.urgent !== null;
  const stale = isAmber(nowMs, operator.capturedAt, WORK_POLL_CADENCE_HOURS);
  const age = ageMs(nowMs, operator.capturedAt);
  const count = measured
    ? `${stale ? "Last known: " : ""}${operator.urgent} urgent · ${operator.waiting} waiting`
    : rows.length > 0
      ? `${stale ? "Last known: at least" : "At least"} ${rows.length} waiting · total unavailable`
      : "Count unavailable";
  // The state, once. The count is in the header and "All tasks →" beside it is
  // the way to the live queue, so an empty panel names what it could not show
  // and never repeats the count or the link as an instruction.
  const empty = !measured || age === null
    ? "Tasks not read yet"
    : stale
      ? "Task status outdated"
      : operator.waiting! > 0
        ? "Task details not read"
        : "Nothing waiting";
  return (
    <ListPanel
      title="Needs attention"
      count={<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{count}
          {measured && rows.length < operator.waiting! ? ` · ${rows.length} shown` : ""}
        </span>
        <InfoTooltip label="About this task preview" trigger={age === null ? "Time unknown" : stale ? "Outdated" : `Read ${formatAge(age)} ago`}>
          <span className="block">{age === null ? "Task status time unknown" : `Task status read ${formatAge(age)} ago${stale ? " · outdated" : ""}`}</span>
          <span className="block">Task status does not verify that each request is still needed.</span>
          <span className="block">This is a preview. Open All tasks for the complete recorded queue.</span>
        </InfoTooltip>
      </span>}
      action={{ label: "All tasks", to: assetTabPath(assetId, "tasks") }}
      empty={empty}
    >
      {rows.map((item) => (
        <ListRow
          key={item.id}
          marks={{ "data-subject": `task:${item.id}` }}
          to={`/tasks/${encodeURIComponent(item.id)}`}
          returnTo={`${location.pathname}${location.search}`}
          // The Tasks board's own ask face: warn at every priority and a
          // gate's △. Priority is the order, never the colour.
          {...askFace(item)}
          title={item.title}
          caption={
            <>
              <code className="font-mono text-[11px]">{item.id}</code>
              {item.assignee ? ` · ${item.assignee}` : ""}
            </>
          }
          value={formatAge(ageMs(nowMs, item.updatedAt))}
          valueLabel="updated"
        />
      ))}
    </ListPanel>
  );
}

// --- what matters ----------------------------------------------------------
const FINDING_RANK: Record<ExecutiveInsightKind, number> = {
  warning: 0,
  recommendation: 1,
  discovery: 2,
  insight: 3,
};

function WhatMatters({
  data,
  nowMs,
  onWatch,
  onAll,
}: {
  data: AssetDetailFor<"overview">;
  nowMs: number;
  onWatch: (seed: WatchSeed) => void;
  onAll: () => void;
}) {
  const demoReadonly = useDemoReadonly();
  const toast = useOwnerToast();
  const snapshot = data.executive;
  const assess = useRecommendationAssessor();
  const { decideFinding } = useDecisionWriters(data.asset.id);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const stored = new Set(
    data.decisions
      .filter((item) => item.kind === "finding" && item.status === "dismissed")
      .map((item) => item.key),
  );
  const items = (snapshot?.items ?? [])
    .filter((item) => !stored.has(item.key) && !dismissed.includes(item.key))
    .sort((left, right) => FINDING_RANK[left.kind] - FINDING_RANK[right.kind]);

  function dismiss(key: string) {
    if (demoReadonly) return;
    setDismissed((current) => [...current, key]);
    decideFinding(key, "dismissed").catch(() => {
      setDismissed((current) => current.filter((one) => one !== key));
      toast.error("Not saved — this finding is unchanged");
    });
  }

  return (
    <ListPanel
      title="What matters"
      count={
        snapshot
          ? <span className="grid gap-1"><span>{items.length} saved findings</span><AnalysisEvidence snapshot={snapshot} nowMs={nowMs} /></span>
          : undefined
      }
      action={items.length > 3 ? { label: "All findings", onClick: onAll } : undefined}
      // A state, not a sentence: the empty panel names what it holds in the
      // panel's own noun, never an internal job the operator cannot start.
      empty={
        !snapshot
          ? "No findings yet"
          : snapshot.items.length === 0
            ? "Nothing found"
            : "All findings dismissed"
      }
    >
      {items.slice(0, 3).map((insight, index) => {
        const meta = EXECUTIVE_INSIGHT_META[insight.kind];
        const Icon = meta.icon;
        return (
          <ListRow
            key={insight.key}
            tone={meta.tone}
            glyph={<Icon className={`size-3 ${meta.text}`} aria-hidden />}
            title={insight.title}
            caption={<><span>{meta.label} · Original analysis: {insight.confidence} confidence</span><RecommendationReview validity={assess(findingBasis(insight))} subject={`finding:${insight.key}`} passive /></>}
            captionWrap
            value={findingFigure(insight).value}
            valueLabel={savedEvidenceLabel(findingFigure(insight).label)}
            defaultExpanded={index === 0}
            marks={{ "data-finding-row": insight.key }}
            // The finding's one decision sits on its row: a composer prefilled
            // from the finding, then File task.
            rowActions={<FindingFileTask insight={insight} assetId={data.asset.id} />}
            actions={
              <FindingActions
                insight={insight}
                onWatch={onWatch}
                onDismiss={() => dismiss(insight.key)}
              />
            }
          >
            {/* Evidence, not prose: `summary` and `whyItMatters` are free
                paragraphs, one press away in All findings with the sources and
                the limitation. */}
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {findingEvidence(insight).map((row) => (
                <div key={`${row.label}-${row.value}`} className="flex justify-between gap-3">
                  <dt className="min-w-0 break-words text-muted-foreground">{savedEvidenceLabel(row.label)}</dt>
                  <dd className="max-w-[16ch] break-words text-end font-medium tabular-nums">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            <RecommendationReview validity={assess(findingBasis(insight))} subject={`finding:${insight.key}`} />
          </ListRow>
        );
      })}
    </ListPanel>
  );
}

/**
 * The row's right-hand figure: a `primary` whose value is a percentage the
 * title already prints steps aside for the first absolute count in the
 * finding's own evidence. A percentage the title does not carry stays.
 */
export function findingFigure(insight: ExecutiveInsight): {
  value: string;
  label: string;
} {
  const primary = insight.primary;
  if (!primary.value.trim().endsWith("%")) return primary;
  if (!insight.title.includes(primary.value.trim())) return primary;
  const absolute = insight.evidence.find((row) => COUNT.test(row.value.trim()));
  return absolute ? { value: absolute.value, label: absolute.label } : primary;
}

/** A whole number, with or without thousands separators. */
const COUNT = /^\d[\d,]*$/;

/** An internal identifier: a rule id, a decision key, the machine name of
 * the thing that produced the finding. Real evidence, kept in All findings
 * and off the row. */
const IDENTIFIER = /^[a-z0-9]+(-[a-z0-9]+)+$/;

export function findingEvidence(insight: ExecutiveInsight): ExecutiveEvidence[] {
  const figure = findingFigure(insight);
  return insight.evidence
    .filter((row) => {
      const value = row.value.trim();
      if (IDENTIFIER.test(value)) return false;
      if (value === insight.key) return false;
      // Whatever was promoted into the value column does not also ride here.
      return !(row.label === figure.label && row.value === figure.value);
    })
    .slice(0, 4);
}

/** File task, prefilled from the finding's own fields (`findingTaskHandoff`):
 * its title, what it measured, its window and sources, and the page it lives
 * on. Nothing when the finding cannot name a task (no key, no asset). */
function FindingFileTask({ insight, assetId }: { insight: ExecutiveInsight; assetId: string }) {
  const validity = useRecommendationValidity(findingBasis(insight));
  const prefill = taskHandoffPrefill(findingTaskHandoff(insight, assetId, validity, findingEvidenceUrl(assetId)));
  return prefill ? (
    <FileTaskButton prefill={prefill} subject={insight.title} variant="outline" className="h-8" />
  ) : null;
}

function FindingActions({
  insight,
  onWatch,
  onDismiss,
}: {
  insight: ExecutiveInsight;
  onWatch: (seed: WatchSeed) => void;
  onDismiss: () => void;
}) {
  const demoReadonly = useDemoReadonly();
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 text-muted-foreground"
        disabled={demoReadonly}
        onClick={() =>
          onWatch({
            subject: insight.title,
            series: watchSeriesForSources(insight.sources) ?? WATCH_SERIES[0]!,
            query: null,
            beadId: null,
          })
        }
      >
        Watch outcome
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 text-muted-foreground"
        onClick={onDismiss}
        disabled={demoReadonly}
      >
        Dismiss
      </Button>
    </>
  );
}

/** The whole ranked list, one disclosure below the panel: evidence, sources,
 * limitations, the suppressed-card mention, the marks and the restore. */
function FullFindings({
  data,
  onWatch,
}: {
  data: AssetDetailFor<"overview">;
  onWatch: (seed: WatchSeed) => void;
}) {
  const { decideFinding } = useDecisionWriters(data.asset.id);
  if (!data.executive) return null;
  return (
    <ExecutiveFindingsList
      snapshot={data.executive}
      recordedDecisions={data.decisions}
      handoffBeads={data.handoffBeads}
      onDecide={decideFinding}
      onWatch={onWatch}
    />
  );
}

/**
 * A metric's config key as an eyebrow reads it.
 *
 * The nightly report names its own counters (`plansSaved`, `recipes_saved`) and
 * every other surface prints the key verbatim, which is right in a table cell.
 * Here it is set in an uppercase 11px eyebrow, where `PLANSSAVED` is one word
 * nobody can read — the case boundary IS the space, so it becomes one.
 */
function metricLabel(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// --- product use -----------------------------------------------------------
/**
 * The site's all-time totals: the stock figures config/counters.json
 * declares, one cell per total that has a number. A figure from the
 * 15-minute counters lane carries its read age, amber past twice the lane's
 * cadence; a figure the nightly report supplied carries none, because the
 * header's report age already states it. A total neither lane has is left
 * out, never drawn as 0.
 */
function SiteTotals({ counters, nowMs }: { counters: SiteCounters | null; nowMs: number }) {
  const cards = (counters?.cards ?? []).filter(
    (card): card is SiteCounters["cards"][number] & { value: number } => card.value !== null,
  );
  if (!counters || cards.length === 0) return null;
  return (
    <section aria-labelledby="site-totals" data-site-totals>
      <SectionLabel id="site-totals" title={counters.heading} className="mb-2" />
      <SmallMultipleStrip columns={Math.min(cards.length, 5)}>
        {cards.map((card) => (
          <SmallMultiple
            key={card.metric}
            label={card.label}
            value={formatInt(card.value)}
            secondaryBelow
            secondary={card.source === "counters"
              ? <AgeBadge iso={card.observedAt} cadenceHours={counters.cadenceHours} nowMs={nowMs} />
              : undefined}
          />
        ))}
      </SmallMultipleStrip>
    </section>
  );
}

export function ProductUse({
  assetId,
  metrics,
  reportDate,
  receivedAt,
  nowMs,
}: {
  assetId: string;
  metrics: PulseMetric[];
  reportDate: string | null;
  receivedAt: string | null;
  nowMs: number;
}) {
  const assetTabPath = useAssetTabPath();
  if (metrics.length === 0) return null;
  const age = ageMs(nowMs, receivedAt);
  const stale = pulseAmber(nowMs, receivedAt);
  const receivedLabel = age === null ? null : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(receivedAt!));
  const cells = metrics.slice(0, 5).map((metric) => ({ metric, summary: productReportSummary(metric, reportDate) }));
  return (
    <section aria-labelledby="product-report">
      <SectionLabel
        id="product-report"
        title="Product use"
        caption="Latest reported 24 hours"
        action={{ to: assetTabPath(assetId, "growth"), label: "Growth →" }}
        className="mb-2"
      >
        <InfoTooltip label="About product reports" className={stale ? "text-warn" : undefined}
          trigger={receivedLabel === null ? "Report time unknown" : `Report ${formatAge(age)} ago${stale ? " · Outdated" : ""}`}>
          {/* Exact times and dates only. What each figure is is printed on the
              cell ("in 24h", "Prior 7 reports: … / day", "daily counts",
              "1 missing day"). */}
          <span className="block">{receivedLabel === null ? "Report time unknown" : `Report received ${receivedLabel} · ${formatAge(age)} ago.`}</span>
          {cells.map(({ metric, summary }) => summary.previousMean === null ? null : <span key={metric.name} className="block">{metricLabel(metric.name)} comparison: {summary.previousCount} reports · {formatCalendarRange(summary.previousFirst!, summary.previousLast!)}.</span>)}
        </InfoTooltip>
      </SectionLabel>
      <SmallMultipleStrip columns={Math.min(metrics.length, 5)}>
        {cells.map(({ metric, summary }) => {
          const label = metricLabel(metric.name);
          return (
          <SmallMultiple
            key={metric.name}
            label={label}
            value={metric.last24h === null ? "—" : formatInt(metric.last24h)}
            valueCaption="in 24h"
            secondaryBelow
            secondary={
              summary.previousMean === null
                ? "No earlier reports to compare"
                : <>
                    <span className="block">Prior {summary.previousCount} {summary.previousCount === 1 ? "report" : "reports"}: <span className="whitespace-nowrap font-medium text-foreground">{formatInt(summary.previousMean)} / day</span></span>
                  </>
            }
            // Every line carries the days it covers, under it and in its name.
            sparkCaption={summary.first && summary.last ? <>
              <Sparkline
                data={summary.series}
                size="wide"
                tone="neutral"
                area
                average={false}
                readout
                ariaLabel={`${label} daily counts, ${formatSeriesDate(summary.first)} to ${formatSeriesDate(summary.last)}`}
                className="mt-1"
              />
              <span aria-hidden className="mt-0.5 flex justify-between gap-2 whitespace-nowrap text-micro" data-product-dates="">
                <time dateTime={summary.first}>{formatSeriesDate(summary.first)}</time>
                <FitLabel className="flex-1 text-center">daily counts</FitLabel>
                <time dateTime={summary.last}>{formatSeriesDate(summary.last)}</time>
              </span>
              {summary.missingDays > 0 ? <span className="block">{summary.missingDays} missing {summary.missingDays === 1 ? "day" : "days"}</span> : null}
            </> : "No report history"}
          />
          );
        })}
      </SmallMultipleStrip>
    </section>
  );
}
