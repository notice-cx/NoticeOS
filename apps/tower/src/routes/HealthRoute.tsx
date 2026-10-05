import { Link } from "react-router-dom";
import { TabPanel } from "@/components/Tabs";
import { HealthNavigation } from "./health/HealthNavigation";
import { ServiceOverview } from "./health/ServiceOverview";
import { IntegrationHealthPanel } from "@/components/IntegrationHealthPanel";
import { utcRunReference } from "@shared/scheduled-jobs";
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CredentialSummary, IntegrationHealthItem } from "@noticeos/contract";
import {
  SITE_UNBLOCKER_KINDS,
  integrationLabel,
  unblockers,
  type DataSpendSummary,
  type IntegrationCatalogRow,
  type IntegrationCellBase,
  type IntegrationsHistory,
  type IntegrationsMatrix,
  type UnblockerKind,
  unusedWithoutConnectPath,
} from "@shared/integrations";
import { laneProvider, laneStatus, type ConnectionKind } from "@shared/connection-status";
import { legacyEnvProviders } from "@shared/integrations-page";
import { ageMs, formatAge } from "@shared/freshness";
import { evidenceInstant } from "@shared/signal-liveness";
import { siteCount } from "@shared/site-noun";
import { IntegrationMatrix } from "@/components/IntegrationMatrix";
import { IntegrationSummaryStrip } from "@/components/IntegrationSummaryStrip";
import { PageHeader } from "@/components/PageHeader";
import { SegmentBar } from "@/components/SegmentBar";
import { StateChip } from "@/components/StateChip";
import { HeroChart } from "@/components/surface/HeroChart";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { ListPanel, ListRow, type ListRowTone } from "@/components/surface/ListPanel";
import { SectionLabel, eyebrowClass } from "@/components/surface/SectionLabel";
import { SmallMultiple, SmallMultipleStrip } from "@/components/surface/SmallMultiple";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { pillControlClass } from "@/components/ui/pill";
import { useConnections } from "@/hooks/useConnections";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useNow } from "@/hooks/useNow";
import { formatPeriodMonth, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

function FreshnessChart({
  sources,
  nowMs,
}: {
  sources: IntegrationsHistory["sources"];
  nowMs: number;
}) {
  const worst = new Map<string, number>();
  for (const source of sources) {
    for (const point of source.points) {
      worst.set(point.t, Math.max(worst.get(point.t) ?? 0, point.v));
    }
  }
  const points = [...worst.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => ({ t, v }));
  // No history, or not enough of it for a line: the section says which, in
  // a state and a count, and draws nothing it cannot draw honestly.
  if (points.length < MIN_HISTORY_POINTS) return <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3" aria-label="Source history" data-source-history="building">
    <h3 className="text-sm font-medium">Source history</h3>
    <span className="text-xs tabular-nums text-muted-foreground">{points.length} of {MIN_HISTORY_POINTS} days recorded</span>
  </section>;
  const range = Math.min(28, Math.max(1, Math.round((Date.parse(points.at(-1)!.t) - Date.parse(points[0]!.t)) / 86_400_000) + 1));
  const shown = points.filter((point) => Date.parse(point.t) >= Date.parse(points.at(-1)!.t) - (range - 1) * 86_400_000).length;
  const missing = range - shown;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="Source history">
    <p className="text-xs text-muted-foreground tabular-nums">{shown} daily snapshots · {missing ? `${missing} ${missing === 1 ? 'day' : 'days'} without a recorded snapshot` : 'No gaps in this period'}</p>
    <HeroChart
      title="Oldest source evidence · daily snapshots"
      series={[{ name: "Stalest source", points, tone: "neutral" }]}
      variant="step"
      range={range}
      showPoints
      height={180}
      provisionalFrom={todayOf(nowMs)}
      format={(hours) => formatAge(hours * 3_600_000)}
      ariaLabel="Hours since the stalest data source's newest evidence, by day"
      footnote="Includes failed attempts"
    />
    </section>
  );
}

const MIN_HISTORY_POINTS = 3;

function todayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * SYSTEM HEALTH, ONE STATUS PER CONNECTION (bead `ro-ujb9.96.7.3`). The page
 * used to answer "is it working" three times in three vocabularies — the
 * operations list ("Failing"), a register strip ("Degraded", "Not verified")
 * and an unblock list ("Review … degradation") — about the same site. Now the
 * Connections panel is where a provider connection and its sites are read, in
 * the connection model's words; the rest of the page holds only what no
 * provider collects (the asset's own wiring, uptime, revenue) and the audit
 * grid, in the same words.
 */
export function HealthRoute() {
  const { data, isPending, isError, refetch } = useIntegrations();
  const { providers, monitoring, credentials, items } = useConnections();
  const onEnv = legacyEnvProviders(providers.data);
  const now = useNow(5_000);
  const current = Boolean(data && !isError && now - Date.parse(data.generatedAt) >= -10_000 && now - Date.parse(data.generatedAt) < 90_000);
  const wiring = data ? wiringCounts(data, now) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="System health"
        description="Integration reliability, service activity and data coverage."
        actions={<Link className="inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted/40" to="/integrations">Manage integrations</Link>}
      />

      <HealthNavigation />
      <TabPanel idBase="health-view" id="health-view-panel" activeKey="overview" className="space-y-6">
      <ServiceOverview dataCurrent={current} degraded={wiring?.failing ?? 0} unverified={wiring?.unchecked ?? 0} setup={wiring?.setup ?? 0} integrations={monitoring.status} />
      <div data-surface-hero>
        <IntegrationHealthPanel data={monitoring.data} isError={monitoring.isError} nowMs={now} providers={providers.data?.providers} />
      </div>
      {data && !current ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-warn/30 bg-warn/5 px-4 py-2 text-sm" data-snapshot-stale data-status-for="snapshot:health">
          <StateChip tone="caution" label="Last recorded snapshot" subject="snapshot:health" />
          <span className="text-xs tabular-nums text-muted-foreground">{formatAge(ageMs(now, data.generatedAt))} old</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
        </div>
      ) : null}

      {!data ? (
        <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">
          {isPending ? "Loading data connection health…" : "Data connection health is unavailable."}
        </div>
      ) : (
        <Layers
          matrix={data}
          nowMs={now}
          credentials={credentials}
          items={items}
          expiring={expiringCount(providers.data, now)}
          credentialCount={providers.data?.providers?.length ?? 0}
        />
      )}
      <StatusBanner
        open={onEnv.length > 0}
        subject="credentials:legacy"
        lead={
          onEnv.length === 1
            ? "One connection uses a legacy credential"
            : `${onEnv.length} connections use legacy credentials`
        }
        severity={null}
        action={{ label: "Manage connection", to: "/integrations" }}
      >
        {onEnv.join(", ")} — manage this connection in Integrations.
      </StatusBanner>
      </TabPanel>
    </div>
  );
}

function expiringCount(
  payload: ReturnType<typeof useConnections>["providers"]["data"],
  nowMs: number,
): number | null {
  if (!payload) return null;
  let seen = 0;
  // `?? []` because this payload crosses the wire: a build that answers with a
  // shape this one has not seen is a dash, not a crash on a page whose whole
  // job is to say what is broken.
  for (const status of payload.providers ?? []) {
    const expires = status.credential.metadata?.expiresAt;
    if (typeof expires !== "string") continue;
    const remaining = Date.parse(expires) - nowMs;
    if (Number.isNaN(remaining)) continue;
    if (remaining <= 14 * 86_400_000) seen += 1;
  }
  return seen;
}

/** Every cell the page counts. A source nothing on Integrations connects is
 * not counted as "not set up" while that is all it is (`unusedWithoutConnectPath`,
 * bead `ro-ujb9.133`) — the grid draws no row for it either. */
function allCells(matrix: IntegrationsMatrix): IntegrationCellBase[] {
  return [
    ...Object.values(matrix.cells).flat(),
    ...matrix.derivedLanes.flatMap((lane) => Object.values(lane.cells)),
  ].filter((cell) => !unusedWithoutConnectPath(cell));
}

/** Every lane, catalog and derived, by id. */
function lanesOf(matrix: IntegrationsMatrix): Map<string, IntegrationCatalogRow> {
  return new Map([...matrix.catalog, ...matrix.derivedLanes.map((lane) => lane.catalog)].map((lane) => [lane.id, lane]));
}

/** The sources no provider credential collects, as the register records them:
 * the counts the status summary speaks for beside the connections. */
function wiringCounts(matrix: IntegrationsMatrix, nowMs: number): { failing: number; unchecked: number; setup: number } {
  const counts = { failing: 0, unchecked: 0, setup: 0 };
  const lanes = lanesOf(matrix);
  for (const cell of allCells(matrix)) {
    if (laneProvider(cell.laneId) !== null) continue;
    const kind = laneStatus({ laneId: cell.laneId, assetId: cell.assetId, cell, scope: lanes.get(cell.laneId)?.scope, credentials: undefined, items: null, nowMs }).kind;
    if (kind === "failing" || kind === "overdue") counts.failing += 1;
    else if (kind === "not-checked") counts.unchecked += 1;
    else if (kind === "not-connected") counts.setup += 1;
  }
  return counts;
}

const SHORT_LANE_NAME: Record<string, string> = {
  gsc: "Search Console",
  ga4: "GA4",
  "bing-webmaster": "Bing",
  dataforseo: "DataForSEO",
  clarity: "Clarity",
  posthog: "PostHog",
  "nightly-report": "Nightly report",
  egress: "Internet connection",
  uptime: "Uptime",
  "ad-network": "Ad network",
  "affiliate-cj": "Affiliate — CJ",
  "affiliate-amazon": "Affiliate — Amazon",
  "deploy-annotations": "Deploy annotations",
  "github-app": "GitHub App",
  "discord-webhooks": "Discord",
};

function shortLaneName(id: string, label: string): string {
  return SHORT_LANE_NAME[id] ?? label.replace(/\s*\(.*\)\s*$/, "");
}

interface LaneReport {
  id: string;
  label: string;
  at: string;
}

function lastReports(matrix: IntegrationsMatrix, nowMs: number): LaneReport[] {
  const byLane = lanesOf(matrix);
  const newest = new Map<string, string>();
  for (const cell of allCells(matrix)) {
    for (const evidence of cell.evidence) {
      const at = evidenceInstant(evidence.at, nowMs);
      if (!at) continue;
      const held = newest.get(cell.laneId);
      if (held === undefined || at > held) newest.set(cell.laneId, at);
    }
  }

  return [...newest.entries()]
    .flatMap(([id, at]) => {
      const lane = byLane.get(id);
      if (!lane) return [];
      return [{ id, label: integrationLabel(id, lane.label), at }];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

const UNBLOCKER_MARK: Record<UnblockerKind, { tone: ListRowTone; glyph: string }> = {
  degraded: { tone: "warn", glyph: "△" },
  "missing-status": { tone: "warn", glyph: "?" },
  "shared-credential": { tone: "info", glyph: "!" },
  "property-setup": { tone: "info", glyph: "◦" },
};

/**
 * What to do about the sources no provider credential collects: the asset's
 * own wiring, uptime, affiliate revenue, deploy history. A provider's sources
 * are the Connections panel's; listing them here too would be the same site
 * in a second vocabulary on one screen. A site with no status for a data
 * source — any source, a provider's included — is named here too: the
 * Connections panel cannot show a source the register hides (bead
 * `ro-ujb9.96.15`).
 */
function otherSources(matrix: IntegrationsMatrix) {
  const lanes = [...matrix.catalog, ...matrix.derivedLanes.map((lane) => lane.catalog)].filter((lane) => laneProvider(lane.id) === null);
  const keep = new Set(lanes.map((lane) => lane.id));
  const cells: Record<string, IntegrationCellBase[]> = {};
  for (const asset of matrix.assets) {
    cells[asset.id] = [
      ...(matrix.cells[asset.id] ?? []),
      ...matrix.derivedLanes.flatMap((lane) => (lane.cells[asset.id] ? [lane.cells[asset.id]!] : [])),
    ].filter((cell) => keep.has(cell.laneId));
  }
  return unblockers({ catalog: lanes, assets: matrix.assets, cells, undeclared: matrix.undeclared });
}

function Layers({
  matrix,
  nowMs,
  credentials,
  items,
  expiring,
  credentialCount,
}: {
  matrix: IntegrationsMatrix;
  nowMs: number;
  credentials: ReadonlyMap<string, CredentialSummary> | undefined;
  items: IntegrationHealthItem[] | null;
  expiring: number | null;
  credentialCount: number;
}) {
  const lanes = lanesOf(matrix);
  const statusOf = (cell: IntegrationCellBase): ConnectionKind | "not-applicable" =>
    laneStatus({ laneId: cell.laneId, assetId: cell.assetId, cell, scope: lanes.get(cell.laneId)?.scope, credentials, items, nowMs }).kind;
  const cells = allCells(matrix);
  const counts: Partial<Record<ConnectionKind | "not-applicable", number>> = {};
  for (const cell of cells) {
    const kind = statusOf(cell);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const applicable = cells.length - (counts["not-applicable"] ?? 0);
  const todo = otherSources(matrix);
  const reports = lastReports(matrix, nowMs);
  const spend = matrix.dataSpend;
  const atCap = spend.capUsd > 0 && spend.spentUsd >= spend.capUsd;

  return (
    <>
      <ListPanel
        title="Other sources"
        action={{ label: "Manage integrations", to: "/integrations" }}
        count={todo.length === 0 ? undefined : <span className="tabular-nums">{todo.length}</span>}
        limit={3}
        empty="Nothing to set up"
      >
        {todo.map((item) => {
          const mark = UNBLOCKER_MARK[item.kind];
          const onSite = SITE_UNBLOCKER_KINDS.includes(item.kind);
          return (
            <ListRow
              key={`${item.kind}:${item.key}`}
              tone={mark.tone}
              glyph={mark.glyph}
              title={item.action}
              caption={item.unlocks.join(" · ")}
              value={item.cells}
              valueLabel={item.cells === 1 ? "source" : "sources"}
              actions={<Link className="inline-flex min-h-11 items-center text-xs font-medium underline underline-offset-4" to={onSite ? `/assets/${encodeURIComponent(item.key)}/sources` : '/integrations'}>{onSite ? 'Open site sources' : 'Open integrations'}</Link>}
            />
          );
        })}
      </ListPanel>
      <FreshnessChart sources={matrix.history.sources} nowMs={nowMs} />

      {reports.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionLabel title="Latest evidence" />
          <SmallMultipleStrip columns={5}>
            {reports.slice(0, 5).map((report) => (
              <SmallMultiple
                key={report.id}
                className="min-w-0 grid-cols-[minmax(0,1fr)]"
                label={
                  <span className="block truncate" title={`${report.label} · ${utcRunReference(report.at)}`}>
                    {shortLaneName(report.id, report.label)}
                  </span>
                }
                value={formatAge(ageMs(nowMs, report.at))}
                secondary="ago"
              />
            ))}
          </SmallMultipleStrip>
        </div>
      ) : null}

      <Panel
        title={matrix.assets.length > 1 ? "Every source, site by site" : "Every source"}
        count={`${applicable} ${applicable === 1 ? "source" : "sources"} · ${siteCount(matrix.assets.length)}`}
        mark="audit"
      >
        <IntegrationSummaryStrip
          className="mb-3"
          counts={counts}
          sharedCredential={matrix.sharedCredential}
        />
        <IntegrationMatrix matrix={matrix} nowMs={nowMs} statusOf={statusOf} />
      </Panel>

      <Panel
        title="Credential expiry and data costs"
        count={formatPeriodMonth(spend.period)}
        mark="spend"
      >
        <KpiStrip columns={2}>
            <Kpi
              className="min-w-0 grid-cols-[minmax(0,1fr)]"
              label="Expiring"
              value={expiring === null ? "—" : expiring}
              valueTone={expiring !== null && expiring > 0 ? "warn" : "default"}
              caption={
                expiring === null
                  ? "the credential store has not answered"
                  : `of ${credentialCount} credentials, inside 14 days`
              }
              footer={
                <SegmentBar
                  className="mt-2"
                  ariaLabel={
                    expiring === null
                      ? "Nothing is known about credential expiry yet"
                      : `${expiring} of ${credentialCount} credentials expire within 14 days`
                  }
                  segments={[
                    { name: "expiring", value: expiring ?? 0, fill: "bg-warn" },
                    {
                      name: "rest",
                      value: Math.max(0, credentialCount - (expiring ?? 0)),
                      fill: "bg-muted-foreground/30",
                    },
                  ]}
                />
              }
            />
            <Kpi
              className="min-w-0 grid-cols-[minmax(0,1fr)]"
              label="Data spend"
              value={<>{formatUsd(spend.spentUsd, { cents: true })}<UnknownPriceCount count={spend.unknownPrices} /></>}
              valueTone={atCap ? "warn" : "default"}
              caption={`of ${formatUsd(spend.capUsd)} in ${formatPeriodMonth(spend.period)}`}
              footer={
                <SegmentBar
                  className="mt-2"
                  ariaLabel={`${formatUsd(spend.spentUsd, { cents: true })} of the ${formatUsd(spend.capUsd)} monthly cap is spent`}
                  segments={[
                    {
                      name: "spent",
                      value: spend.spentUsd,
                      fill: atCap ? "bg-warn" : "bg-foreground/70",
                    },
                    {
                      name: "left",
                      value: Math.max(0, spend.capUsd - spend.spentUsd),
                      fill: "bg-muted-foreground/25",
                    },
                  ]}
                />
              }
            />
        </KpiStrip>
        <DataSpend
          spend={spend}
          atCap={atCap}
          displayNames={new Map(matrix.assets.map((a) => [a.id, a.displayName]))}
        />
      </Panel>
    </>
  );
}

function Panel({
  title,
  count,
  children,
  mark,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
  mark?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className="rounded-xl border border-border bg-card"
      data-panel={mark}
      data-panel-open={open ? "" : undefined}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-start",
          pillControlClass,
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform",
            open && "rotate-90",
          )}
        />
        <span className={eyebrowClass}>{title}</span>
        {count ? (
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </button>
      {open ? <div className="border-t border-border/60 p-4">{children}</div> : null}
    </section>
  );
}

function DataSpend({
  spend,
  atCap,
  displayNames,
}: {
  spend: DataSpendSummary;
  atCap: boolean;
  displayNames: Map<string, string>;
}) {
  const rows = spend.byAsset.length > 0 || spend.unattributedUsd > 0 || spend.unattributedUnknownPrices > 0;
  return (
    <div className="flex flex-col gap-2">
            {rows ? (
        <ul className="flex flex-col gap-1" data-data-spend-by-asset>
          {spend.byAsset.map((row) => (
            <li
              key={row.asset}
              className="flex items-baseline justify-between gap-3 text-[13px]"
              data-spend-asset={row.asset}
            >
              <span className="truncate text-muted-foreground">
                {displayNames.get(row.asset) ?? row.asset}
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {formatUsd(row.spentUsd, { cents: true })}
                <UnknownPriceCount count={row.unknownPrices} subject={`spend:${row.asset}`} />
              </span>
            </li>
          ))}
                    {spend.unattributedUsd > 0 || spend.unattributedUnknownPrices > 0 ? (
            <li
              className="flex items-baseline justify-between gap-3 text-[13px]"
              data-spend-unattributed
            >
              <span className="truncate text-muted-foreground">
                Research, not tied to a site
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {formatUsd(spend.unattributedUsd, { cents: true })}
                <UnknownPriceCount count={spend.unattributedUnknownPrices} subject="spend:unattributed" />
              </span>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Nothing metered has been bought this month.
        </p>
      )}
      {atCap ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-spend-capped>
          <StateChip tone="caution" label="Cap reached" subject="budget:portfolio" />
          Metered pulls paused until next month
        </p>
      ) : null}
    </div>
  );
}

export default HealthRoute;
import { UnknownPriceCount } from "@/components/UnknownPriceCount";
