import { useDemoReadonly } from '@/lib/browser-context';
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { Ban, Check } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type {
  AssetGa4Config,
  FetchFailure,
  HygieneCheckHistory,
  HygieneHistory,
  HygieneStatus,
  PulseMetric,
} from "@shared/asset-detail";
import { assetSetupChecklist } from "@shared/asset-setup";
import { productReportSummary } from "@shared/product-reports";
import { NIGHTLY_REPORT_LANE_ID, PROPERTY_DATA_SOURCE_IDS, UPTIME_LANE_ID, integrationLabel, type AssetIntegrationLane, type AssetIntegrations, type IntegrationEvidence } from "@shared/integrations";
import { ageMs, formatAge } from "@shared/freshness";
import { integrationFailureMessage, type IntegrationHealthItem } from "@noticeos/contract/integration-health";
import { integrationProvider } from "@noticeos/contract/integrations";
import { connectionFacts, laneStatus, sourceReadings, type ConnectionKind } from "@shared/connection-status";
import { connectable, connectHref, connectsInPanel, firstToConnect, providerName } from "@shared/connect-panel";
import { connectBlockers } from "@shared/integrations-page";
import { ProviderConnectPanel, providerPanelOpening, type ProviderPanelOpening } from "@/routes/integrations/ProviderConnectPanel";
import { INTEGRATION_HEALTH_KEY } from "@/hooks/useIntegrationHealth";
import { INTEGRATION_PROVIDERS_KEY, useIntegrationProviders } from "@/hooks/useIntegrationProviders";
import { useWall } from "@/hooks/useWall";
import { CADENCE_HOURS } from "@shared/wall";
import type { SeriesPointOrGap } from "@shared/surface";
import { AgeBadge } from "@/components/AgeBadge";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { EvidencePopover } from "@/components/EvidencePopover";
import { InfoTooltip } from "@/components/InfoTooltip";
import { ConnectionFacts, IntegrationStateChip } from "@/components/IntegrationStateChip";
import { useConnections } from "@/hooks/useConnections";
import { ScheduledLanesPanel } from "@/components/ScheduledLanes";
import { StateChip, type StateTone, type StatusSubject } from "@/components/StateChip";
import { Sparkline } from "@/components/surface/Sparkline";
import { ListPanel, ListRow, type ListRowTone } from "@/components/surface/ListPanel";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { humanizeMetric, pullFailureCause, READINGS_SHOWN } from "@shared/alert-language";
import { formatInt, formatSeriesDate, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Eyebrow, Hero, Panel, LaneAge } from "@/routes/asset-detail/shared";
import { SetupChecklistPanel } from "@/routes/asset-detail/SetupChecklist";
import { MediavineSettings } from '@/routes/asset-detail/MediavineSettings';
import {
  GA4_LANE_ID,
  Ga4LaneConfig,
  LaneConfig,
  LanePostureAction,
  NotApplicableLanes,
} from "@/routes/asset-detail/LaneConfig";
import { declineReason } from "@shared/lane-decline";

/**
 * The Sources tab: where this asset's numbers come from. The setup checklist
 * is the hero while the asset is still being set up and renders nothing on a
 * live asset, where the data sources take the first screen. What this source's
 * own record says is inside its row; what is still owed stays on the face of
 * the row, because that is the next action rather than an explanation.
 */
export function SourcesTab({
  data,
  nowMs,
}: {
  data: AssetDetailFor<"sources">;
  nowMs: number;
}) {
  const { credentials, items } = useConnections();
  const readings = sourceReadings(data.asset.id, data.integrations.sources, { credentials, items }, nowMs);
  const setup = assetSetupChecklist({
    id: data.asset.id,
    displayName: data.asset.displayName,
    status: data.asset.status,
    sources: readings,
    firstReportAt: data.asset.firstReportAt,
    reportDays: data.asset.reportDays,
    latestReportAt: data.freshness.pulseReceivedAt,
    noNightlyReport: data.asset.noNightlyReport,
    nowMs,
  });
  const sources = (
    <IntegrationsSection
      integrations={data.integrations}
      asset={data.asset.id}
      isOs={data.asset.isOs}
      ga4Config={data.ga4Config}
      nowMs={nowMs}
    />
  );
  return (
    <div className="flex flex-col gap-3.5">
      {/* The hero is whichever block answers the tab's question TODAY. While the
          asset is still being set up that is what is still owed; once it is live
          there is no checklist at all, and the question becomes "are my sources
          working". */}
      <Hero>{sources}</Hero>
      {/* Closed on arrival, a new site's included: each source row above
          already carries its own Connect, so the checklist is the count, not
          the next step. */}
      {setup ? <SetupChecklistPanel setup={setup} /> : null}
      {data.scheduledLanes !== null ? (
        <ScheduledLanesPanel lanes={data.scheduledLanes} nowMs={nowMs} />
      ) : null}
      {/* Only a site whose report the OS fetches has fetches to fail. */}
      {data.wiring.pull ? <FetchFailuresPanel failures={data.fetchFailures} nowMs={nowMs} /> : null}
      {/* Nothing to show until the first nightly report: its absence is the
          header's "Nightly report · never" and the Nightly report source row,
          so an empty panel here would say it a third time. */}
      {data.metrics.length > 0 || data.freshness.pulseReceivedAt !== null ? (
        <PulseMetricsSection
          metrics={data.metrics}
          reportDate={data.wiring.lastPulseDate}
          pulseReceivedAt={data.freshness.pulseReceivedAt}
          nowMs={nowMs}
        />
      ) : null}
      <SiteHealthSection hygiene={data.hygiene} nowMs={nowMs} />
    </div>
  );
}

// --- integrations (observed health + file-backed applicability) -------------

/** Attention first, then the settled ones. A source that needs something is the
 * reason this panel exists; a working one is a tick you scroll past. */
const KIND_RANK: Record<ConnectionKind | "not-applicable", number> = {
  failing: 0, overdue: 1, unknown: 2, "not-checked": 3, collecting: 4, "key-accepted": 5, working: 6,
  "not-connected": 7, "not-using": 8, "not-applicable": 9,
};

/** The row's mark, from the same status its chip shows. */
const KIND_TONE: Record<ConnectionKind | "not-applicable", ListRowTone> = {
  failing: "error", overdue: "warn", working: "ok", "key-accepted": "ok", collecting: "info", "not-checked": "info",
  unknown: "info", "not-connected": "info", "not-using": "info", "not-applicable": "info",
};

type LaneReading = ReturnType<typeof laneStatus>;

const CONNECTED: ReadonlySet<ConnectionKind | "not-applicable"> = new Set(["working", "key-accepted", "collecting"]);

/** The tab's one answer: which of the site's own sources need the operator,
 * else how many work. The sentence counts, and names them only when they are
 * the problem. */
export function sourcesAnswer(direct: readonly { lane: { catalog: { label: string } }; reading: { kind: ConnectionKind | "not-applicable" } }[]): {
  answer: string;
  detail?: string;
  mark: "problem" | "none" | "working" | "empty";
} {
  // A source the operator declared unused is a decision, not a gap.
  const used = direct.filter(({ reading }) => reading.kind !== "not-using");
  const total = used.length;
  if (total === 0) return { answer: "No data sources in use", mark: "empty" };
  const problems = used.filter(({ reading }) => reading.kind === "failing" || reading.kind === "overdue");
  const connected = used.filter(({ reading }) => CONNECTED.has(reading.kind));
  if (problems.length > 0) {
    return {
      answer: problems.length === 1 ? `${problems[0]!.lane.catalog.label} needs you` : `${problems.length} of ${total} sources need you`,
      detail: problems.map(({ lane, reading }) => `${lane.catalog.label} ${reading.kind === "failing" ? "failing" : "overdue"}`).join(" · "),
      mark: "problem",
    };
  }
  if (connected.length === 0) return { answer: "No sources connected yet", detail: `${total} to connect`, mark: "none" };
  const open = total - connected.length;
  // Collecting or a key just accepted is connected, not yet proven working.
  const word = connected.every(({ reading }) => reading.kind === "working") ? "working" : "connected";
  return {
    answer: open > 0 ? `${connected.length} of ${total} sources ${word}` : total === 1 ? `${connected[0]!.lane.catalog.label} ${word}` : `All ${total} sources ${word}`,
    detail: open > 0 ? `${open} not connected` : undefined,
    mark: "working",
  };
}

/**
 * The asset's data sources, each row wearing the one status the connection
 * model gives this asset's site, so a source never reads Not connected here
 * while its provider reads Working on Integrations. A row opens in place on
 * what it needs. `limit` is seven, the direct sources an asset has: a panel
 * showing three of six has hidden half the work.
 */
function IntegrationsSection({
  integrations,
  asset,
  isOs,
  ga4Config,
  nowMs,
}: {
  integrations: AssetIntegrations;
  /** Whose page this is — the `{asset}` a per-asset config register is scoped to. */
  asset: string;
  /** The System's own page — which scope rule makes a source not apply. */
  isOs: boolean;
  ga4Config: AssetGa4Config;
  nowMs: number;
}) {
  const demoReadonly = useDemoReadonly();
  const { credentials, items } = useConnections();
  // The connect panel opens over this page, with this site first; every other
  // provider still links to its own page.
  const providers = useIntegrationProviders();
  const wall = useWall();
  const queryClient = useQueryClient();
  // Where the panel opened is fixed when it opens: a key accepted in it makes
  // the provider connected, and the panel must go on to that key's sites.
  const [connecting, setConnecting] = useState<{ provider: string; opened: ProviderPanelOpening } | null>(null);
  const panel = (providers.data?.providers ?? []).find((status) => status.provider.id === connecting?.provider) ?? null;
  const blockers = providers.data ? connectBlockers(providers.data) : [];
  // Until the providers are read, a row's Connect is the link to the same
  // panel on Integrations — never a press that does nothing.
  const openPanel = providers.data && !demoReadonly ? (provider: string) => {
    const status = providers.data.providers.find((entry) => entry.provider.id === provider);
    if (status) setConnecting({ provider, opened: providerPanelOpening(status) });
  } : undefined;
  const names = new Map((wall.data?.assets ?? []).map((entry) => [entry.id, entry.displayName]));
  const changed = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: INTEGRATION_PROVIDERS_KEY }),
      queryClient.invalidateQueries({ queryKey: INTEGRATION_HEALTH_KEY }),
      queryClient.invalidateQueries({ queryKey: ["asset-detail", asset] }),
    ]);
  };
  const read = (lane: AssetIntegrationLane) => laneStatus({
    laneId: lane.catalog.id, assetId: asset, cell: lane.cell, scope: lane.catalog.scope, credentials, items, nowMs,
  });
  const applicable = integrations.lanes
    .filter((l) => l.cell.declared !== "not-applicable")
    .map((lane) => ({ lane, reading: read(lane) }))
    .sort((a, b) => KIND_RANK[a.reading.kind] - KIND_RANK[b.reading.kind] || a.lane.catalog.label.localeCompare(b.lane.catalog.label));
  const notApplicable = integrations.lanes.filter((l) => l.cell.declared === "not-applicable");
  const direct = applicable.filter(({ lane }) => PROPERTY_DATA_SOURCE_IDS.has(lane.catalog.id) || lane.catalog.id === NIGHTLY_REPORT_LANE_ID);
  const optional = applicable.filter((entry) => !direct.includes(entry));
  // The first source still to connect carries the page's one primary action;
  // every other Connect is the outline weight. The same rule picks Home's
  // next first-run step (`firstToConnect`).
  const firstConnect = firstToConnect(direct.map(({ lane, reading }) => ({
    id: lane.cell.laneId, label: lane.catalog.label, kind: reading.kind, provider: reading.provider,
  })))?.id ?? null;
  const answer = sourcesAnswer(direct);
  return (
    <div id="integrations" className="flex scroll-mt-4 flex-col gap-2">
      <PageAnswer answer={answer.answer} detail={answer.detail} className="mb-1.5" marks={{ "data-sources-answer": answer.mark }} />
      <ListPanel
        title="Data sources"
        limit={7}
        empty="No data source applies to this site yet."
        // Every row carries its own Connect; this is the way to all of them.
        action={{ label: "All integrations", to: "/integrations" }}
      >
        {direct.map(({ lane, reading }) => (
          <LaneRow key={lane.cell.laneId} lane={lane} reading={reading} asset={asset} ga4Config={ga4Config} nowMs={nowMs} primary={lane.cell.laneId === firstConnect} onConnect={openPanel} />
        ))}
      </ListPanel>
      {/* The sources beyond the site's own data, revenue and deploys, as a
          second list. `ListPanel` keeps three rows and discloses the rest. */}
      {optional.length > 0 ? (
        <ListPanel title="More sources" count={<span className="tabular-nums">{optional.length}</span>} limit={3}>
          {optional.map(({ lane, reading }) => <LaneRow key={lane.cell.laneId} lane={lane} reading={reading} asset={asset} ga4Config={ga4Config} nowMs={nowMs} onConnect={openPanel} />)}
        </ListPanel>
      ) : null}
      {/* No file name here: a site's sources are set in the Tower and kept in
          the store. */}
      {notApplicable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
          <NotApplicableLanes lanes={notApplicable} asset={asset} isOs={isOs} />
        </div>
      ) : null}
      {panel && connecting ? (
        <ProviderConnectPanel
          status={panel}
          opened={connecting.opened}
          asset={asset}
          // This page has no blocker banner, so the panel says why Connect is
          // off, once, with the command that clears it.
          canConnect={blockers.length === 0}
          blockers={blockers}
          items={items ?? []}
          names={names}
          onClose={() => setConnecting(null)}
          onChanged={changed}
        />
      ) : null}
    </div>
  );
}

function LaneRow({
  lane,
  reading,
  asset,
  ga4Config,
  nowMs,
  primary = false,
  onConnect,
}: {
  lane: AssetIntegrationLane;
  reading: LaneReading;
  asset: string;
  ga4Config: AssetGa4Config;
  nowMs: number;
  /** This row's Connect is the page's one primary action. */
  primary?: boolean;
  /** Open a provider's connect panel over this page. */
  onConnect?: (provider: string) => void;
}) {
  const demoReadonly = useDemoReadonly();
  const { catalog, cell } = lane;
  const { kind, site, provider } = reading;
  const subject: StatusSubject = `source:${asset}:${catalog.id}`;
  const failure: IntegrationHealthItem | null = site?.failure ?? null;
  const identity = [cell.ref, cell.since ? `since ${cell.since}` : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const spec = provider ? integrationProvider(provider) : null;
  // One action on the face: a source whose provider is not connected shows
  // Connect where its status would be, and it goes straight to the connect
  // panel for this asset without opening the row first. It carries the status
  // it stands for, so every status reader still finds this source Not connected.
  const stands = { "aria-label": `${demoReadonly ? 'View' : 'Connect'} ${spec ? providerName(spec) : ""}`, "data-source-connect": catalog.id, "data-status-for": subject, "data-connection": "not-connected" };
  const connect = spec && connectable(reading) ? (
    // A provider that connects in the panel opens it over this page; any
    // other opens its own page on Integrations.
    connectsInPanel(spec) && onConnect ? (
      <Button type="button" size="sm" variant={primary ? "default" : "outline"} disabled={demoReadonly} onClick={() => onConnect(spec.id)} {...stands}>
        Connect
      </Button>
    ) : (
      <Button asChild size="sm" variant={primary ? "default" : "outline"}>
        <Link to={connectHref(spec.id, asset)} {...stands}>
          {demoReadonly ? 'View' : 'Connect'}
        </Link>
      </Button>
    )
  ) : undefined;
  // A failing source's one action is Fix, beside its Failing chip: the
  // connection itself, in the panel over this page for a provider that
  // connects there, else the provider's own page.
  const fix = kind === "failing" && spec ? (
    connectsInPanel(spec) && onConnect ? (
      <Button type="button" size="sm" variant="outline" onClick={() => onConnect(spec.id)} aria-label={`Fix ${providerName(spec)}`} data-source-fix={catalog.id}>
        Fix
      </Button>
    ) : (
      <Button asChild size="sm" variant="outline">
        <Link to={`/integrations?provider=${spec.id}`} aria-label={`Fix ${providerName(spec)}`} data-source-fix={catalog.id}>Fix</Link>
      </Button>
    )
  ) : undefined;
  return (
    <ListRow
      tone={KIND_TONE[kind]}
      marks={{ "data-subject": subject }}
      rowActions={connect ?? fix}
      rowActionsInline
      title={integrationLabel(catalog.id, catalog.label)}
      caption={
        kind === "failing" && failure ? <span className="text-error">{integrationFailureMessage(failure)}</span>
          : site && connectionFacts(site).length > 0 ? <ConnectionFacts status={site} subject={subject} />
            // A skipped source's reason is why it reads Not using: one line
            // beside the chip, in the operator's words, because the stored
            // prefix is the product's (`declineReason`).
            : kind === "not-using" && cell.note ? <span className="wrap-anywhere" data-lane-reason>{declineReason(cell.note) ?? cell.note}</span>
              : catalog.id === UPTIME_LANE_ID && cell.evidence[0]?.at ? <UptimeCheck evidence={cell.evidence[0]} nowMs={nowMs} />
                : undefined
      }
      value={connect ? undefined : <IntegrationStateChip state={kind === "not-applicable" ? "not-applicable" : kind} subject={subject} lane={catalog.id} />}
      // The one decision the file owns, in use or Not using with a reason
      // chip, as the expanded row's action. A derived source has no cell to
      // decide on.
      actions={cell.since === "" ? undefined : <LanePostureAction lane={lane} asset={asset} />}
    >
      {/* No link for a source nothing on Integrations connects: its evidence
          is what the row has to say. */}
      {kind === "not-connected" && cell.laneId === NIGHTLY_REPORT_LANE_ID ? <Link to="/health" className="inline-flex min-h-11 w-fit items-center text-sm font-medium text-foreground underline underline-offset-4">Nightly report in System health →</Link> : null}
      <span className="flex flex-wrap items-center gap-2">
        {identity ? <span className="tabular-nums">{identity}</span> : null}
        {cell.evidence.length > 0 ? (
          <EvidencePopover evidence={cell.evidence} nowMs={nowMs} contextLabel={catalog.label} />
        ) : null}
        {/* No documentation pointer on the row: its one action, Connect, is
            how it gets set up. */}
      </span>

      {/* The per-asset configuration of this lane: what is still owed, which
          property this asset maps to, and the one posture the file owns. It
          sits under the verdict. A derived lane (`nightly-report`, `egress`)
          has no cell in the register and nothing here to edit. */}
      {/* Ad revenue unconnected: the row's Connect is its one action, so its
          revenue section is not even asked for. */}
      {cell.laneId === 'ad-network' ? (connect ? null : <MediavineSettings asset={asset} />) : cell.since === "" ? null : <LaneConfig lane={lane} asset={asset} />}

      {cell.laneId === GA4_LANE_ID ? <Ga4LaneConfig asset={asset} config={ga4Config} /> : null}
    </ListRow>
  );
}

/**
 * When the OS last looked: the uptime row's one fact beside its Up or Down,
 * the check's age, and for a site that did not answer, what it answered with.
 * An Up whose first try failed says so after the age: "checked 12m ago · 1
 * failed try".
 */
function UptimeCheck({ evidence, nowMs }: { evidence: IntegrationEvidence; nowMs: number }) {
  const age = formatAge(ageMs(nowMs, evidence.at));
  const down = evidence.polarity === "against";
  // No proof on an answer that is not Down: the OS could not reach the network.
  const offline = !down && evidence.verification === undefined;
  return (
    <span className={cn("tabular-nums", down && "text-error")} data-uptime-check>
      {down ? `${evidence.detail} · checked ${age} ago`
        : offline ? `offline ${age} ago`
          : evidence.detail ? `checked ${age} ago · ${evidence.detail}` : `checked ${age} ago`}
    </span>
  );
}

/**
 * Every failed nightly fetch, one line each: a mark, the cause in the
 * provider's own words, and when. A red mark is the outage still open, a muted
 * one a past outage. The full response rides the cause's hover.
 */
function FetchFailuresPanel({ failures, nowMs }: { failures: FetchFailure[]; nowMs: number }) {
  const rows = failures;
  return (
    <ListPanel
      title="Failed fetches"
      count={rows.length > 0 ? <span className="tabular-nums">{rows.length}</span> : undefined}
      limit={READINGS_SHOWN}
      empty="No record yet"
    >
      {rows.map((failure) => {
        const cause = pullFailureCause(failure.ruleInputs) ?? failure.message ?? "Fetch failed";
        const response = typeof failure.ruleInputs?.error === "string" ? failure.ruleInputs.error : cause;
        return (
          <ListRow
            key={failure.at}
            tone={failure.ongoing ? "error" : "info"}
            glyph="✗"
            marks={{ "data-fetch-failure": failure.ongoing ? "ongoing" : "past" }}
            title={<span title={response}>{cause}</span>}
            value={
              <time dateTime={failure.at} title={formatTimestamp(failure.at)} className="tabular-nums">
                {formatAge(ageMs(nowMs, failure.at))} ago
              </time>
            }
          />
        );
      })}
    </ListPanel>
  );
}

// --- daily metrics ---------------------------------------------------------
function PulseMetricsSection({
  metrics,
  reportDate,
  pulseReceivedAt,
  nowMs,
}: {
  metrics: PulseMetric[];
  reportDate: string | null;
  pulseReceivedAt: string | null;
  nowMs: number;
}) {
  return (
    <Panel
      title="Daily metrics"
      count={
        <LaneAge iso={pulseReceivedAt} nowMs={nowMs} cadenceHours={CADENCE_HOURS.pulse} />
      }
    >
      {metrics.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          Nothing yet — metrics appear with this site's first nightly report.
        </span>
      ) : (
        // `stacked`: a metric row without its 30-day trend is a number with no
        // direction, and the trend would otherwise be off the edge at 390px.
        <Table stacked>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              <TableHead className="text-right">Latest report · 24h{reportDate ? <> <span className="block text-xs font-normal">{formatSeriesDate(reportDate)}</span></> : null}</TableHead>
              <TableHead className="text-right">Prior reports · avg / day</TableHead>
              <TableHead className="w-36">History · daily counts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {metrics.map((m) => {
              const summary = productReportSummary(m, reportDate);
              return (
              <TableRow key={m.name}>
                {/* The operator's words, not the envelope's key. `humanizeMetric`
                    is the same one `translateAlert` puts in every alert
                    headline. The raw key stays the row's React key and the
                    hover title, because it is what the operator greps the
                    envelope for. */}
                <TableCell className="font-medium" title={m.name}>
                  <span className="inline-flex items-center gap-1.5">{metricLabel(m.name)}
                    <InfoTooltip label={`${metricLabel(m.name)} report details`}>
                      <span className="block">Latest count: the last reported 24-hour period, not a live rolling total.</span>
                      <span className="block">{summary.previousMean === null ? "No prior reports to compare." : `Comparison: ${summary.previousCount} observed reports, ${formatSeriesDate(summary.previousFirst!)}–${formatSeriesDate(summary.previousLast!)}; the latest report is excluded.`}</span>
                      <span className="block">{summary.first && summary.last ? `Chart: daily counts · ${formatSeriesDate(summary.first)}–${formatSeriesDate(summary.last)} · UTC report dates` : "No report history."}</span>
                    </InfoTooltip>
                  </span>
                </TableCell>
                <TableCell label={`Latest report · 24h${reportDate ? ` · ${formatSeriesDate(reportDate)}` : ""}`} className="text-right tabular-nums">
                  {numOrDash(m.last24h)}
                </TableCell>
                <TableCell
                  label="Prior reports · avg / day"
                  className="text-right tabular-nums text-muted-foreground"
                >
                  {summary.previousMean === null ? "No prior reports" : <>
                    <span className="block">{summary.previousMean.toFixed(1)} · {summary.previousCount} {summary.previousCount === 1 ? "report" : "reports"}</span>
                  </>}
                </TableCell>
                <TableCell label="History · daily counts">
                  <Sparkline
                    data={summary.series}
                    size="cell"
                    average={false}
                    readout
                    ariaLabel={`${metricLabel(m.name)} daily report counts`}
                  />
                  {summary.missingDays > 0 ? <span className="block text-xs text-muted-foreground">{summary.missingDays} missing {summary.missingDays === 1 ? "day" : "days"}</span> : null}
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function numOrDash(n: number | null): string {
  return n === null ? "—" : formatInt(n);
}

/** The envelope's metric key as a sentence subject — "plansSaved" → "Plans
 * saved". One humaniser for the desk: this is `translateAlert`'s. */
function metricLabel(metric: string): string {
  const words = humanizeMetric(metric);
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : metric;
}

/**
 * The four hygiene statuses, in words and in colour.
 *
 * `error` and `unreachable` stay apart, exactly as they are at rest: "the origin
 * answered, but not with anything usable" is evidence about the asset, and
 * "we never reached the origin" is evidence about the fetch. Only the first is
 * an accusation, so only the first takes the error tone; a night we could not
 * look reads muted, because a gap in observation is not a finding.
 */
const HYGIENE_STATE: Record<HygieneStatus, { label: string; tone: StateTone }> = {
  ok: { label: "Fine", tone: "affirmative" },
  warn: { label: "Flagged", tone: "caution" },
  error: { label: "Bad response", tone: "critical" },
  unreachable: { label: "Not reached", tone: "na" },
};

/** A series of fewer than three points is a number, not a shape. */
const HYGIENE_MIN_SERIES = 3;

/**
 * One check's measured series, as a number and — when there is enough of it to
 * be a shape — a line.
 *
 * A failed check retains its dated empty position rather than becoming zero
 * or disappearing between successful checks.
 */
function HygieneSeries({
  history,
  unit,
  ariaLabel,
  nowMs,
}: {
  history: HygieneCheckHistory;
  unit: string;
  ariaLabel: string;
  nowMs: number;
}) {
  const points: SeriesPointOrGap[] = history.readings.map((reading) => ({ t: reading.date, v: reading.value }));
  const observations = points.filter((point) => point.v !== null).length;
  const latest = history.latest;
  const state = latest ? HYGIENE_STATE[latest.status] : null;
  return (
    <div
      className="min-w-0 rounded-md border border-border p-3"
      data-hygiene-check={history.check}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Eyebrow>{ariaLabel}</Eyebrow>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {state ? <StateChip label={state.label} tone={state.tone} subject={`hygiene:${history.check}`} /> : null}
          <AgeBadge
            iso={latest?.observedAt ?? null}
            cadenceHours={CADENCE_HOURS.hygiene}
            nowMs={nowMs}
          />
        </div>
      </div>
      {/* The small-multiple value: `text-xl` and not the 28px KPI type,
          because three of these sit in one strip. */}
      <div className="mt-2 flex flex-col gap-0.5">
        <span className="text-xl font-semibold tabular-nums">
          {latest?.value !== null && latest?.value !== undefined
            ? formatInt(latest.value)
            : "—"}
        </span>
        <span className="text-xs text-muted-foreground">
          {latest ? unit : "never checked"}
        </span>
      </div>
      {/* The full-width sparkline: the line is the shape; the number above it
          is the number. */}
      {observations >= HYGIENE_MIN_SERIES ? (
        <Sparkline
          className="mt-2"
          data={points}
          size="wide"
          area
          readout
          format={(value) => `${formatInt(value)} ${unit}`}
          ariaLabel={`${ariaLabel} over the stored nightly history`}
        />
      ) : null}
      {observations >= HYGIENE_MIN_SERIES ? (
        <InfoTooltip className="mt-1" label={`${ariaLabel} trend details`} trigger="7-day average">{formatSeriesDate(points[0]!.t)}–{formatSeriesDate(points.at(-1)!.t)} · observed checks only</InfoTooltip>
      ) : null}
    </div>
  );
}

/**
 * The nightly served-layer history. A rule fires on a step change; only the
 * history shows a slope. Read-only and absent when empty: the Tower cannot run
 * a check, so a section with no readings is a dead end rather than an
 * invitation.
 */
function SiteHealthSection({
  hygiene,
  nowMs,
}: {
  hygiene: HygieneHistory | null;
  nowMs: number;
}) {
  // The hourly uptime check writes the home-page reading on its own; this
  // section is the nightly sweep's history, so it waits for that sweep rather
  // than drawing two "never" tiles on a new site.
  if (!hygiene || (hygiene.robots.latest === null && hygiene.sitemap.latest === null)) return null;
  const robotsState = hygiene.robots.latest
    ? HYGIENE_STATE[hygiene.robots.latest.status]
    : null;
  return (
    <Panel title="Site health" count={`last ${hygiene.windowDays} days`}>
      <div className="grid gap-3.5 sm:grid-cols-3">
        <HygieneSeries
          history={hygiene.htmlDepth}
          unit="words of visible text"
          ariaLabel="Served home page"
          nowMs={nowMs}
        />

        <div
          className="min-w-0 rounded-md border border-border p-3"
          data-hygiene-check="robots-ai-access"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <Eyebrow>AI crawler access</Eyebrow>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {robotsState ? (
                <StateChip label={robotsState.label} tone={robotsState.tone} subject="hygiene:robots-ai-access" />
              ) : null}
              <AgeBadge
                iso={hygiene.robots.latest?.observedAt ?? null}
                cadenceHours={CADENCE_HOURS.hygiene}
                nowMs={nowMs}
              />
            </div>
          </div>
          {hygiene.bots.length === 0 ? (
            <span className="mt-2 block text-xs text-muted-foreground">
              No robots.txt to resolve — nothing is claimed about any crawler.
            </span>
          ) : (
            <ul className="mt-2 flex flex-col gap-1" data-hygiene-bots>
              {hygiene.bots.map((bot) => (
                <li
                  key={bot.bot}
                  className="flex items-center justify-between gap-2 text-xs"
                  data-hygiene-bot={bot.bot}
                >
                  <span className="truncate text-muted-foreground">{bot.bot}</span>
                  {/* Glyph and word: allowed/blocked survives a screenshot with
                      the colour stripped. */}
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 font-medium",
                      bot.allowed ? "text-foreground" : "text-error",
                    )}
                  >
                    {bot.allowed ? (
                      <Check className="size-3.5" aria-hidden />
                    ) : (
                      <Ban className="size-3.5" aria-hidden />
                    )}
                    {bot.allowed ? "allowed" : "blocked"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <HygieneSeries
          history={hygiene.sitemap}
          unit="URLs listed"
          ariaLabel="Sitemap"
          nowMs={nowMs}
        />
      </div>
    </Panel>
  );
}
