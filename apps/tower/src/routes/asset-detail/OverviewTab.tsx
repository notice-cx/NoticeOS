import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { useState } from "react";
import { useLocation } from "react-router-dom";

import type {
  AssetDetailPayload,
  ExecutiveEvidence,
  ExecutiveInsight,
  ExecutiveInsightKind,
  PulseMetric,
  SiteCounters,
} from "@shared/asset-detail";
import { assetSetupChecklist } from "@shared/asset-setup";
import { sourceReadings } from "@shared/connection-status";
import { ageMs, formatAge, isAmber, pulseAmber } from "@shared/freshness";
import { productReportSummary } from "@shared/product-reports";
import { watchSeriesForSources, type WatchSeed } from "@shared/watch-windows";
import { WATCH_SERIES } from "@noticeos/contract/create-watch-window";
import { WORK_POLL_CADENCE_HOURS } from "@shared/work";
import { AgeBadge } from "@/components/AgeBadge";
import { ExecutiveFindingsList } from "@/components/ExecutiveFindingsList";
import { AnalysisEvidence, RecommendationReview, useRecommendationAssessor, useRecommendationValidity } from "@/components/AnalysisEvidence";
import { findingBasis } from "@shared/recommendation-validity";
import { InfoTooltip } from "@/components/InfoTooltip";
import {
  EXECUTIVE_INSIGHT_META,
  findingTaskHandoff,
  savedEvidenceLabel,
} from "@/components/ExecutiveInsightRow";
import { HeroChart } from "@/components/surface/HeroChart";
import { Kpi } from "@/components/surface/KpiStrip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import {
  ListPanel,
  ListRow,
} from "@/components/surface/ListPanel";
import {
  SmallMultiple,
  SmallMultipleStrip,
} from "@/components/surface/SmallMultiple";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { FileTaskButton } from "@/components/TaskComposer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConnections } from "@/hooks/useConnections";
import { useDecisionWriters } from "@/hooks/useDecisionWriters";
import {
  formatCalendarRange,
  formatInt,
  formatPeriodMonthYear,
  formatSignedMoney,
  formatSeriesDate,
} from "@/lib/format";
import { findingEvidenceUrl, taskHandoffPrefill } from "@/lib/task-handoff";
import { useAssetTabPath } from "@/routes/asset-detail/AssetTabs";
import { alertPosture, ledgerMonth } from "@/routes/asset-detail/overview-metrics";
import { SiteLead } from "@/routes/asset-detail/SiteLead";
import { useRange } from "@/routes/asset-detail/useRange";
import { askFace } from "@/routes/tasks/task-face";

/**
 * THE OVERVIEW TAB — the index tab, so `/assets/:id` IS this (`ro-pbzu.4`),
 * rebuilt to doc 21's Asset · Overview template (bead `ro-78qo.3`).
 *
 * It answers ONE question in three parts: how is this asset doing, what needs
 * me, and what matters. Traffic follows the selected day range; financials and
 * alerts have separate accounting-month/latest-recorded scopes. The operator's queue,
 * ranked findings and nightly counts follow those evidence groups.
 *
 * What LEFT, and where it went: the setup checklist to Sources (a banner stands
 * in its place while the asset is still being set up), the search-context strip
 * and its four reference tables to the new Search tab, the reclamation pipeline
 * and the timeline to Activity, the planned-modules row to nowhere — a list of
 * what does not exist yet is not part of the question this tab answers.
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
  const [monthlyHistory, setMonthlyHistory] = useState(false);
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

  return (
    <div className="flex flex-col gap-3.5">
      {/* `#setup` still lands here (`HASH_TAB` sends it to Overview), and the
          banner is what it lands on: the checklist itself is on Sources now,
          one link away, and a deep link that scrolled to nothing would be worse
          than one that scrolls to the sentence saying where it went. */}
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
            {/* A row of values, not a sentence (bead `ro-ujb9.96.7.16`): the
                fraction, then each step still to do by its own name. */}
            {setup.remaining.length === 0
              ? `${setup.done} of ${setup.total} done`
              : `${setup.done} of ${setup.total} done · to do: ${setup.remaining.join(" · ").toLowerCase()}`}
          </StatusBanner>
        </div>
      ) : null}

      <SiteLead data={data} days={days} nowMs={nowMs} />

      <div className="grid items-start gap-3.5 lg:grid-cols-2" data-independent-snapshots>
        <section aria-labelledby="overview-financials" data-financial-snapshot className="overflow-hidden rounded-[10px] border border-border bg-card">
          <SectionLabel
            id="overview-financials"
            title={moneyPeriod ? `Financials · ${formatPeriodMonthYear(moneyPeriod)}` : "Financials · no accounting month"}
            action={{ label: "View financials", to: `/assets/${encodeURIComponent(data.asset.id)}/financials` }}
            className="px-4 pt-3"
          />
          {/* The month is in the title and the Booked / Estimated chip is on
              the figure, so the snapshot's scope is read, not explained. */}
          <Kpi
            label="Net"
            value={money ? formatSignedMoney(money.net, money.currency, { cents: true }) : "—"}
            note={money ? <> <Badge variant="secondary" className="ms-1 align-middle">{money.booking === "forecast" ? "Estimated" : "Booked"}</Badge></> : undefined}
            improvement="none"
            caption={money?.composition ?? "No financial totals recorded"}
            spark={money && money.series.length >= 3 ? money.series : undefined}
            sparkLabel="Net by accounting month"
            sparkAverage={false}
            sparkTone="muted"
            format={(value) => formatSignedMoney(value, money?.currency ?? null, { cents: true })}
            seriesUnavailable={money ? "At least three accounting months are needed for a trend." : "No financial totals recorded"}
          />
          {money ? <details
            open={monthlyHistory}
            onToggle={(event) => setMonthlyHistory(event.currentTarget.open)}
            className="border-t border-border/60 px-4 py-2"
          >
            <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium">Monthly net history</summary>
            {monthlyHistory ? <HeroChart
              title={`Net · by accounting month, ${money.booking === "forecast" ? "Estimated" : "Booked"}`}
              variant="monthly"
              range={money.series.length}
              format={(value) => formatSignedMoney(value, money?.currency ?? null)}
              formatValue={(value) => formatSignedMoney(value, money?.currency ?? null, { cents: true })}
              series={[{ name: "Net", points: money.series, tone: "primary" }]}
              footnote="One point per accounting month. Independent of the traffic date range."
            /> : null}
          </details> : null}
        </section>
        {/* THE SPLIT IS THE ANSWER (doc 21: a number whose shape is how a
            total divides shows the division). One row names the errors and
            warnings open now, in the severity ring, with when one last fired —
            and opens the Alerts tab, where each one is verified. It draws no
            trend on purpose: saved records cannot say which conditions were
            open on a past day, so there is no honest line to draw. */}
        <div data-alert-current>
          <ListPanel title="Open alerts">
            <ListRow
              title={alertSplit(alerts)}
              tone={alerts.error > 0 ? "error" : alerts.warn > 0 ? "warn" : "info"}
              glyph={alerts.open === 0 ? "✓" : undefined}
              value={alerts.latestFiredAt === null ? "never" : formatAge(ageMs(nowMs, alerts.latestFiredAt))}
              valueLabel="last fired"
              to={assetTabPath(data.asset.id, "alerts")}
            />
          </ListPanel>
        </div>
      </div>

      <div className="grid gap-3.5 lg:grid-cols-2">
        <NeedsYou assetId={data.asset.id} operator={data.operator} nowMs={nowMs} />
        {/* `#insights` is the findings' anchor and has been since before the
            tabs; it now names the panel rather than the whole ranked list. */}
        <div id="insights" className="min-w-0 scroll-mt-4">
          <WhatMatters
            data={data}
            nowMs={nowMs}
            onWatch={onWatch}
            onAll={() => setAllFindings(true)}
          />
        </div>
      </div>

      <ProductUse assetId={data.asset.id} metrics={data.metrics}
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

      {/* NO "ABOUT THESE NUMBERS" (doc 21 principle 3a, bead
          `ro-ujb9.96.6.6`). Its three paragraphs each restated something the
          surface already draws: the provider in each chart legend, the
          averaged or totalled measure in each KPI label, the compared window in
          each delta's own label, "provisional" as the hollow last point and its
          legend key, "not comparable" on the delta itself, Booked / Estimated
          on the net figure, the analysis age on What matters, and the report
          age on Product use. */}
    </div>
  );
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
        ? "Task details not captured"
        : "Nothing waiting";
  return (
    <ListPanel
      title="Needs you"
      count={<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{count}
          {measured && rows.length < operator.waiting! ? ` · ${rows.length} captured in preview` : ""}
        </span>
        <InfoTooltip label="About this task preview" trigger={age === null ? "Time unknown" : stale ? "Outdated snapshot" : `Read ${formatAge(age)} ago`}>
          <span className="block">{age === null ? "Task status time unknown" : `Task status read ${formatAge(age)} ago${stale ? " · outdated snapshot" : ""}`}</span>
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
          // The Tasks board's own ask face (bead ro-ujb9.240): warn at every
          // priority and a gate's △. Priority is the ORDER, never the colour.
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
      // A STATE, NOT A SENTENCE (bead `ro-ujb9.96.6.21`): the empty panel
      // names what it holds in the panel's own noun. It used to explain an
      // internal job ("the archive analysis has not run") the operator meets
      // nowhere else and cannot start; with an analysis saved, the header
      // already carries its age.
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
            // The finding's one decision sits on its row (bead
            // `ro-ujb9.96.7.11`, PagerDuty's Create Jira issue): a composer
            // prefilled from the finding, then File task — two presses.
            rowActions={<FindingFileTask insight={insight} assetId={data.asset.id} />}
            actions={
              <FindingActions
                insight={insight}
                onWatch={onWatch}
                onDismiss={() => dismiss(insight.key)}
              />
            }
          >
            {/* EVIDENCE, NOT PROSE (doc 21: "a row expands in place to show
                evidence and its actions"). The producer writes `summary` and
                `whyItMatters` as free paragraphs — two or three sentences of
                them — and doc 21's acceptance forbids a paragraph visible by
                default outside `About`. The mockup shows one because it is
                illustration; the rule is the document. Both sentences are one
                press away, with the sources and the limitation, in All findings. */}
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {findingEvidence(insight).map((row) => (
                <div key={`${row.label}-${row.value}`} className="flex justify-between gap-3">
                  <dt className="truncate text-muted-foreground">{savedEvidenceLabel(row.label)}</dt>
                  <dd className="max-w-[16ch] truncate font-medium tabular-nums" title={row.value}>
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
 * THE ROW'S RIGHT-HAND FIGURE: the count, when the title already carries the
 * share.
 *
 * "11.3% of sessions are unattributed · 11.3% unattributed sessions" is one
 * fact stated twice in one row (doc 14), and the half that was missing is the
 * one an operator acts on — eight thousand sessions. So a `primary` whose value
 * is a percentage the TITLE already prints steps aside for the first absolute
 * count in the finding's own evidence. A percentage the title does not carry
 * stays: dropping it would lose the fact rather than de-duplicate it.
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

/**
 * An internal identifier — a rule id, a decision key, the machine name of the
 * thing that produced the finding.
 *
 * Doc 17: an operator never has to read one. They are real evidence and they
 * stay in All findings beside the sources and the limitation, where the reader
 * has asked for the machinery; on the row itself they spend a line of the four
 * this panel has on a string nobody can act on.
 */
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

/**
 * THE WHOLE RANKED LIST, one disclosure below the panel.
 *
 * "All findings →" has nowhere else to go yet: the Search tab (`ro-78qo.4`) is
 * being built beside this one and the eight-card list is not its subject. So
 * the existing list — evidence, sources, limitations, the suppressed-card
 * mention, the marks and the restore — stays reachable on this tab, closed, and
 * moves when a page exists that owns it.
 */
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
 * THE SITE'S ALL-TIME TOTALS (bead `ro-trai.21`): accounts, leads, catalog
 * counts — the stock figures config/counters.json declares, which only the old
 * Wall card drew until D28 moved them here (docs/25-the-wall.md § What leaves
 * the Wall). The register's own heading, one cell per total that has a number.
 *
 * AN AGE ONLY WHERE IT IS ITS OWN (doc 14, one representation): a figure from
 * the 15-minute counters lane carries its read age, amber past twice the lane's
 * cadence; a figure the nightly report supplied carries none, because the
 * header's report age already states exactly that age. A total neither lane has
 * is left out, never drawn as 0, and a site with nothing to show draws nothing.
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
  const common = cells[0]!.summary;
  const sharedHistory = common.first !== null && common.last !== null && cells.every(({ summary }) =>
    summary.first === common.first && summary.last === common.last && summary.missingDays === common.missingDays);
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
          {/* Exact times and dates only. What each figure IS is printed on the
              cell ("in 24h", "Prior 7 reports: … / day", "Daily counts",
              "1 missing day"), so the two methodology paragraphs that restated
              it are gone (doc 21 principle 3a). */}
          <span className="block">{receivedLabel === null ? "Report time unknown" : `Report received ${receivedLabel} · ${formatAge(age)} ago.`}</span>
          {cells.map(({ metric, summary }) => summary.previousMean === null ? null : <span key={metric.name} className="block">{metricLabel(metric.name)} comparison: {summary.previousCount} reports · {formatCalendarRange(summary.previousFirst!, summary.previousLast!)}.</span>)}
        </InfoTooltip>
      </SectionLabel>
      <SmallMultipleStrip columns={Math.min(metrics.length, 5)}>
        {cells.map(({ metric, summary }) => {
          return (
          <SmallMultiple
            key={metric.name}
            label={metricLabel(metric.name)}
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
            spark={summary.series}
            sparkAverage={false}
            sparkCaption={sharedHistory ? undefined : summary.first && summary.last ? <>
              <span className="block">Daily counts</span>
              <span className="flex justify-between gap-2"><span>{formatSeriesDate(summary.first)}</span><span>{formatSeriesDate(summary.last)}</span></span>
              {summary.missingDays > 0 ? <span className="block">{summary.missingDays} missing {summary.missingDays === 1 ? "day" : "days"}</span> : null}
            </> : "No report history"}
          />
          );
        })}
      </SmallMultipleStrip>
      {sharedHistory ? <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground" data-product-history>
        <span>Daily counts · {formatCalendarRange(common.first!, common.last!)}</span>
        {common.missingDays > 0 ? <span>{common.missingDays} missing {common.missingDays === 1 ? "day" : "days"}</span> : null}
      </div> : null}
    </section>
  );
}
