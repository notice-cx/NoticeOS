import { Activity, Cable, Check, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { sourceReadings, type ConnectionReads } from "@shared/connection-status";
import { firstRunSite, firstRunSteps, sitePath, type FirstRunStep, type FirstRunStepKey } from "@shared/first-run";
import { viewCovers } from "@shared/asset-detail-views";
import { ageMs, formatAge, isAmber } from "@shared/freshness";
import { siteCount } from "@shared/site-noun";
import { DEFAULT_RANGE_DAYS } from "@shared/surface";
import type { AssetCard, WallPayload } from "@shared/wall";
import type { WallFeedPayload } from "@shared/wall-feed";
import { WORK_POLL_CADENCE_HOURS, type WorkItem, type WorkPayload } from "@shared/work";
import { AddSiteButton } from "@/components/AddSite";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { PageHeader } from "@/components/PageHeader";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { ReadFailed } from "@/components/ReadFailed";
import { SeverityDot } from "@/components/SeverityDot";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { pillControlClass } from "@/components/ui/pill";
import { BarStrip } from "@/components/viz/BarStrip";
import { DecisionQueue, QueueRow, type QueueItem } from "@/components/viz/DecisionQueue";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { HealthGrid } from "@/components/viz/HealthGrid";
import { IncidentList } from "@/components/viz/IncidentList";
import { PortfolioRows, type PortfolioRow } from "@/components/viz/PortfolioRows";
import { StatTile } from "@/components/viz/StatTile";
import { useAssetDetail } from "@/hooks/useAssetDetail";
import { useConnections } from "@/hooks/useConnections";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { useWallFeed } from "@/hooks/useWallFeed";
import { useWork } from "@/hooks/useWork";
import { useDemoReadonly } from "@/lib/browser-context";
import { formatInt, formatPercent, formatPeriodMonthLong, formatSeriesDate, formatTimestamp, formatUsd } from "@/lib/format";
import { greeting, peopleYesterday } from "@/lib/home-brief";
import { homeMoney, siteDays, yesterdayMoney, type HomeMoney } from "@/lib/home-money";
import { openAlertsLabel } from "@/lib/severity";
import { siteHealth } from "@/lib/site-health";
import { askVerb } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";
import { healthGridRows, incidentsFromIssues, sourceColumns, timelineFromWall } from "@/lib/viz-adapters";
import { weekOnWeek } from "@/lib/sites-index";
import { completeDays } from "@/lib/wall-sites";
import { wallIssues, type WallIssue } from "@/lib/wall-issues";
import { hasRevenueSource } from "@/lib/wall-revenue";
import { withSystemIssues } from "@/lib/wall-system-state";
import { SiteLead } from "@/routes/asset-detail/SiteLead";
import { ClockProposal } from "@/routes/home/ClockProposal";
import { MoneyHero } from "@/routes/home/MoneyHero";
import { useAskActions } from "@/routes/tasks/ask-actions";

/**
 * Home answers how the business is doing, what is broken and what needs the
 * operator, drawn from the data: the month's money as the lead with
 * yesterday's revenue and visitors beside it; every site's data sources as
 * one grid beside the ranked problems the grid does not draw; the decisions
 * waiting beside the sites compared; the last day on a time axis. A fresh
 * install sees the three steps to a first number instead.
 */
export function HomeRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const feed = useWallFeed();
  const now = useNow();
  const connections = useConnections();
  // Setup is done at the first collected number; until then Home is the
  // guide, following the newest site.
  const guide = data ? firstRunSite(data.assets) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 md:p-6">
      <PageHeader
        title="Home"
        documentTitle={null}
        // The census is a fact about the page, not a control: how old the
        // reading is, in one quiet line at the end of the header row.
        actions={data && !guide ? <Census assetCount={data.assets.length} generatedAt={data.generatedAt} nowMs={now} /> : null}
      />

      {!data ? (
        isError ? (
          <ReadFailed title="Couldn't load Home" subject="read:home" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">Loading…</div>
        )
      ) : guide ? (
        <FirstRun
          steps={firstRunSteps(
            guide.site,
            guide.site ? sourceReadings(guide.site.id, guide.site.dataSources, connections, now) : [],
          )}
          footer={<ClockProposal />}
        />
      ) : (
        <Board data={data} feed={feed.data ?? null} connections={connections} nowMs={now} />
      )}
    </div>
  );
}

// --- the board ----------------------------------------------------------------

const usd = (value: number) => formatUsd(value);
const cents = (value: number) => formatUsd(value, { cents: true });
const DAY_MS = 86_400_000;

function Board({ data, feed, connections, nowMs }: { data: WallPayload; feed: WallFeedPayload | null; connections: ConnectionReads; nowMs: number }) {
  const issues = withSystemIssues(wallIssues({ assets: data.assets, attention: data.attention, connections, nowMs }), data.system, nowMs);
  const money = homeMoney(data.portfolio, data.assets);
  const oneSite = data.assets.length === 1 ? data.assets[0]! : null;
  const since = feed?.since ?? null;
  const timeline = timelineFromWall(data.assets, issues, feed?.items ?? [], sitePath);
  const changed = issues.filter((issue) => since !== null && issue.since !== null && issue.since >= since).length + timeline.events.length;
  // What the materiality suite reads: every open condition Home stands for, so
  // a problem the Wall lists is drawn here too.
  const conditions = new Set<string>(["open-flags", "human-gates", "os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail"]);
  for (const issue of issues) for (const condition of issue.conditions) conditions.add(condition);

  return (
    // Laid out by its own width, not the window's: the desk's sidebar, a
    // portrait monitor or a narrow window all leave Home less than the
    // viewport, and the twelve columns need room to be twelve.
    <div className="@container flex flex-col gap-5" data-home-brief={issues.length} data-material-condition={[...conditions].join(" ")}>
      <Answer money={money} issues={issues} since={since} changed={changed} nowMs={nowMs} />

      <div className="grid gap-5 @3xl:grid-cols-2 @6xl:grid-cols-12 [&>*]:min-w-0">
        <div className="@3xl:col-span-2 @6xl:col-span-8" data-surface-hero="">
          {money ? <MoneyHero money={money} className="h-full" /> : <PeopleLead assets={data.assets} />}
        </div>
        <div className="grid gap-5 @3xl:col-span-2 @3xl:grid-cols-2 @6xl:col-span-4 @6xl:grid-cols-1">
          {money ? <YesterdayRevenue assets={data.assets} money={money} nowMs={nowMs} /> : null}
          {money ? <VisitorsYesterday assets={data.assets} /> : null}
        </div>

        <section aria-label="Data sources" className="self-start rounded-xl bg-card p-5 ring-1 ring-border/70 @3xl:col-span-2 @6xl:col-span-8" data-home-health="">
          <HealthGrid
            rows={healthGridRows(data.assets, data.system, connections, nowMs, sitePath).map((row) => {
              const asset = data.assets.find((candidate) => candidate.id === row.id);
              return asset ? { ...row, icon: <PropertyFavicon domain={asset.id} displayName={asset.displayName} /> } : row;
            })}
            columns={sourceColumns(data.assets)}
            nowMs={nowMs}
            calm
            action={<Link to="/integrations" className="whitespace-nowrap text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Integrations →</Link>}
          />
        </section>
        <div className="grid content-start items-start gap-5 @3xl:col-span-2 @3xl:grid-cols-2 @6xl:col-span-4 @6xl:grid-cols-1 [&>*]:min-w-0">
          <IncidentList
            items={incidentsFromIssues(issues, { besideGrid: true, to: (issue) => issueLink(issue, data.assets) })}
            nowMs={nowMs}
            marker={since}
            action={{ label: "All alerts →", to: "/alerts" }}
            empty="Nothing else is broken."
          />
          <LiveDecidePanel nowMs={nowMs} />
        </div>

        <div className="@3xl:col-span-2 @6xl:col-span-12">
          {oneSite ? <OneSiteLead site={oneSite} nowMs={nowMs} /> : <Sites assets={data.assets} issues={issues} money={money} nowMs={nowMs} />}
        </div>

        <section aria-label="The last 24 hours" className="rounded-xl bg-card px-5 py-4 ring-1 ring-border/70 @3xl:col-span-2 @6xl:col-span-12" data-home-timeline="">
          <EventTimeline
            lanes={timeline.lanes}
            spans={timeline.spans}
            events={timeline.events}
            window={{ from: new Date(nowMs - DAY_MS).toISOString(), to: new Date(nowMs).toISOString() }}
            nowMs={nowMs}
            marker={since ? { at: since, label: `Since ${sinceClock(since, nowMs)}` } : undefined}
            ariaLabel="What happened in the last 24 hours"
          />
        </section>
      </div>
    </div>
  );
}

/** Where a problem's row opens: its site, the System, or the alerts. */
function issueLink(issue: WallIssue, assets: readonly AssetCard[]): string {
  const asset = issue.assets.length === 1 ? assets.find((candidate) => candidate.id === issue.assets[0]) : undefined;
  if (asset) return sitePath(asset);
  return issue.key.startsWith("system-") || issue.key.startsWith("source-") ? "/health" : "/alerts";
}

/**
 * The screen's answer in one line under a quiet greeting: where the month is
 * heading, what is broken. The greeting and the window are an eyebrow; the
 * numbers below are the large type.
 */
function Answer({ money, issues, since, changed, nowMs }: { money: HomeMoney | null; issues: readonly WallIssue[]; since: string | null; changed: number; nowMs: number }) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  const month = money ? formatPeriodMonthLong(money.period) : null;
  const previous = money?.previousPeriod ? formatPeriodMonthLong(money.previousPeriod) : null;
  const moneyWords = !money || month === null
    ? null
    : money.projected !== null
      ? `${month} is projected at ${usd(money.projected)}${money.changePercent !== null && previous ? `, ${formatPercent(Math.abs(money.changePercent))}% ${money.changePercent < 0 ? "under" : "over"} ${previous}` : ""}.`
      : money.soFar !== null
        ? `${month} so far ${usd(money.soFar)}${money.estimated ? " est." : "."}`
        : null;
  const problemWords = errors === 0 && warnings === 0
    ? "Nothing is broken."
    : `${errors > 0 ? `${formatInt(errors)} ${errors === 1 ? "thing is" : "things are"} broken` : ""}${errors > 0 && warnings > 0 ? ", " : ""}${warnings > 0 ? `${formatInt(warnings)} at risk` : ""}.`;
  return (
    <header className="flex flex-col gap-1" data-home-answer="">
      <span className="text-sm text-muted-foreground" data-brief-since="">
        {greeting(nowMs)}
        {since ? (
          <>
            {" · since "}
            <time dateTime={since} title={formatTimestamp(since)}>{sinceClock(since, nowMs)}</time>
          </>
        ) : null}
        {" · "}
        {changed === 0 ? "nothing changed" : `${formatInt(changed)} ${changed === 1 ? "thing" : "things"} changed`}
      </span>
      <h2 className="m-0 text-figure-sm text-foreground [text-wrap:balance]">
        {moneyWords ? <span>{moneyWords} </span> : null}
        <span className={errors > 0 ? "text-error" : warnings > 0 ? "text-warn" : undefined}>{problemWords}</span>
      </h2>
    </header>
  );
}

function YesterdayRevenue({ assets, money, nowMs }: { assets: readonly AssetCard[]; money: HomeMoney; nowMs: number }) {
  const yesterday = yesterdayMoney(assets, nowMs, money.days);
  const usual = yesterday && yesterday.days.length >= 3 ? yesterday.days.reduce((sum, day) => sum + (day.v ?? 0), 0) / yesterday.days.length : null;
  return (
    <StatTile
      label="Revenue, yesterday"
      value={yesterday?.amount ?? null}
      absent="not reported yet"
      format={cents}
      note={money.estimated ? "est." : undefined}
      role="money"
      to="/financials"
      comparison={yesterday?.weekBefore != null ? { percent: yesterday.changePercent, change: yesterday.amount - yesterday.weekBefore, against: "vs a week before" } : null}
      history={yesterday && yesterday.days.length >= 3 ? (
        <BarStrip data={yesterday.days} tone="text-financial-revenue" baseline={usual !== null ? { value: usual, label: `usual ${cents(usual)}` } : null} format={cents} ariaLabel="Revenue a day, this month" className="h-10" />
      ) : null}
    />
  );
}

function VisitorsYesterday({ assets, display = false }: { assets: readonly AssetCard[]; display?: boolean }) {
  const people = peopleYesterday(assets);
  const usual = people && people.series.length >= 3 ? people.series.reduce((sum, day) => sum + day.v, 0) / people.series.length : null;
  return (
    <StatTile
      label="Visitors, yesterday"
      value={people?.total ?? null}
      absent="nothing reported yet"
      format={formatInt}
      role="people"
      size={display ? "display" : "figure"}
      to="/assets"
      comparison={people && people.previous !== null ? { percent: people.changePercent, change: people.total - people.previous, against: "vs a week before" } : null}
      history={people && people.series.length >= 3 ? (
        <BarStrip data={people.series} tone="text-traffic" baseline={usual !== null ? { value: usual, label: `usual ${formatInt(usual)}` } : null} ariaLabel="Visitors a day, last two weeks" className={display ? "h-20" : "h-10"} />
      ) : null}
      context={people ? <>as of <b>{formatSeriesDate(people.date)}</b></> : null}
    />
  );
}

/** With no revenue source anywhere, people lead: no money figure nobody counted. */
function PeopleLead({ assets }: { assets: readonly AssetCard[] }) {
  return <VisitorsYesterday assets={assets} display />;
}

/** The sites compared: health, people a day, yesterday's money and its
 * change, share of the month. Sources are left to the grid above. */
function Sites({ assets, issues, money, nowMs }: { assets: readonly AssetCard[]; issues: readonly WallIssue[]; money: HomeMoney | null; nowMs: number }) {
  const total = money?.bySite.reduce((sum, site) => sum + site.amount, 0) ?? 0;
  const rows: PortfolioRow[] = assets.map((asset) => {
    const health = siteHealth(asset, issues);
    const days = siteDays(asset);
    const yesterday = hasRevenueSource(asset) ? yesterdayMoney([asset], nowMs, days) : null;
    const earned = money?.bySite.find((site) => site.id === asset.id)?.amount ?? null;
    return {
      id: asset.id,
      name: asset.displayName,
      icon: <PropertyFavicon domain={asset.id} displayName={asset.displayName} />,
      to: sitePath(asset),
      health: { word: health.word, tone: health.key === "off-track" ? "error" : health.key === "at-risk" ? "warn" : "quiet" },
      people: asset.activeUsers.series,
      peopleProvisionalFrom: asset.activeUsers.provisionalFrom,
      peopleLatest: settledPeople(asset),
      peopleChange: weekOnWeek(completeDays(asset.activeUsers)),
      revenue: yesterday?.amount ?? null,
      revenueChange: yesterday?.changePercent ?? null,
      share: earned !== null && total > 0 ? earned / total : null,
      sources: [],
    };
  });
  return <PortfolioRows rows={rows} formatMoney={cents} showSources={false} action={{ label: "All sites →", to: "/assets" }} className="h-full" />;
}

/** A site's visitors on its latest settled day, or null when nothing settled. */
function settledPeople(asset: AssetCard): number | null {
  const { series, provisionalFrom } = asset.activeUsers;
  const settled = series.filter((point) => provisionalFrom === null || point.t < provisionalFrom);
  return settled.at(-1)?.v ?? null;
}

/** "6 PM yesterday" — the window's start as a clock reading, on the reader's
 * own clock, with the day only when it is not today. */
function sinceClock(since: string, nowMs: number): string {
  const at = new Date(since);
  const today = new Date(nowMs);
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: at.getMinutes() === 0 ? undefined : "2-digit" }).format(at);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  if (sameDay) return clock;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const wasYesterday = at.getFullYear() === yesterday.getFullYear() && at.getMonth() === yesterday.getMonth() && at.getDate() === yesterday.getDate();
  return wasYesterday ? `${clock} yesterday` : `${clock} ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at)}`;
}

// --- decide -----------------------------------------------------------------

/** How many rows Decide shows before its own expander. */
const DECIDE_ROWS = 4;

interface WaitingRow {
  item: WorkItem;
  project: string;
  asset: string;
}

/** Epoch ms of a task's last activity; unknown sorts LAST, because "we have no
 * timestamp" is not the same claim as "this has waited longest". */
function updatedMs(item: WorkItem): number {
  const parsed = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Gate first, then priority, then oldest.
 *
 * A gate is HOLDING work out of the ready queue until the operator answers,
 * so it leads regardless of its own priority. After that it is the task
 * database's own ranking, and age breaks the tie — the thing that has waited
 * longest is the thing most likely to have been forgotten.
 */
export function byWaitingUrgency(a: WaitingRow, b: WaitingRow): number {
  const gate = Number(b.item.issueType === "gate") - Number(a.item.issueType === "gate");
  if (gate !== 0) return gate;
  if (a.item.priority !== b.item.priority) return a.item.priority - b.item.priority;
  return updatedMs(a.item) - updatedMs(b.item);
}

function LiveDecidePanel({ nowMs }: { nowMs: number }) {
  const work = useWork();
  return <DecidePanel work={work.data} failed={work.isError} nowMs={nowMs} />;
}

function queueItem(row: WaitingRow, nowMs: number): QueueItem {
  const age = ageMs(nowMs, row.item.updatedAt);
  return {
    id: row.item.id,
    title: row.item.title,
    // The project, never the task's id, which is on the page the row opens;
    // the glyph and the verb say what the row asks.
    project: row.project,
    kind: row.item.issueType === "gate" ? "approval" : "question",
    ageDays: age === null ? null : age / DAY_MS,
    to: `/tasks/${encodeURIComponent(row.item.id)}`,
  };
}

/**
 * Decide: every project's operator inbox, flattened, drawn as a queue — how
 * many wait, how old the wait is, then the rows with their verbs. A gate
 * offers Approve; an ask offers Answer and Dismiss; both go through the Tasks
 * board's own path, with its Undo toast. The three empty states are three
 * different facts: the read has not answered yet, nothing has ever been read,
 * or there is genuinely nothing to decide.
 */
export function DecidePanel({ work, failed, nowMs }: { work: WorkPayload | undefined; failed: boolean; nowMs: number }) {
  const projects = work?.projects ?? [];
  const rows: WaitingRow[] = projects
    .filter((project) => project.ok)
    .flatMap((project) => project.waiting.map((item) => ({ item, project: project.name, asset: project.asset })));
  const ordered = [...rows].sort(byWaitingUrgency);
  const measured = projects.filter((project) => project.ok && project.counts.waiting !== null);
  const complete = projects.length > 0 && measured.length === projects.length;
  const total = measured.reduce((sum, project) => sum + project.counts.waiting!, 0);
  const hasSnapshot = work !== undefined && work.capturedAt !== null;
  const stale = hasSnapshot && isAmber(nowMs, work.capturedAt, WORK_POLL_CADENCE_HOURS);
  const note = !hasSnapshot ? undefined : complete ? (stale ? "outdated" : undefined) : total > 0 ? "partial read" : "count unknown";
  const empty =
    failed && !hasSnapshot
      ? "Could not read your tasks."
      : work === undefined
        ? "Reading your tasks…"
        : !hasSnapshot
          ? "No tasks read yet."
          : !complete || stale || failed
            ? "Queue not fully read."
            : total > 0
              ? "No request details read."
              : "Nothing to decide.";
  const items = ordered.map((row) => queueItem(row, nowMs));

  return (
    <DecisionQueue
      items={items}
      total={hasSnapshot && total > 0 ? total : null}
      totalNote={note}
      title="Decide"
      action={{ label: "All tasks →", to: "/tasks" }}
      limit={DECIDE_ROWS}
      empty={empty}
      className="flex-1"
    >
      {ordered.map((row, index) => (
        <DecideRow key={row.item.id} row={row} item={items[index]!} index={index} />
      ))}
    </DecisionQueue>
  );
}

function DecideRow({ row, item, index }: { row: WaitingRow; item: QueueItem; index: number }) {
  const location = useLocation();
  const readonly = useDemoReadonly();
  const { buttons, box } = useAskActions({
    ask: askVerb(row.item),
    id: row.item.id,
    title: row.item.title,
    project: row.asset,
    disabledReason: readonly ? "Read-only demo" : null,
    placement: "row",
  });
  return (
    <QueueRow
      item={{ ...item, returnTo: `${location.pathname}${location.search}`, actions: buttons, below: box }}
      index={index}
    />
  );
}

// --- one site ---------------------------------------------------------------

/**
 * The one site's own lead: the Overview's strip and chart for that site, read
 * through the same view the Overview reads (so opening the site is instant),
 * over the default 28 days.
 */
function OneSiteLead({ site, nowMs, className }: { site: AssetCard; nowMs: number; className?: string }) {
  const { data } = useAssetDetail(site.id, "overview");
  const connections = useConnections();
  const to = `/assets/${encodeURIComponent(site.id)}`;
  const aside = (
    <>
      <SeverityDot severity={site.worstSeverity} title={openAlertsLabel(site.openError, site.openWarn)} />
      <DataSourceIcons sources={sourceReadings(site.id, site.dataSources, connections, nowMs)} />
      <Link
        to={to}
        className={cn("text-xs font-medium text-foreground underline-offset-4 hover:underline", pillControlClass, "max-sm:-my-2.5 max-sm:inline-flex max-sm:items-center")}
      >
        {site.displayName} →
      </Link>
    </>
  );
  return (
    <div data-one-site-lead={site.id} className={className}>
      {data && viewCovers(data, "overview") ? (
        <SiteLead data={data} days={DEFAULT_RANGE_DAYS} nowMs={nowMs} aside={aside} />
      ) : (
        // Until the site's read arrives: the site itself, in the place its
        // numbers will take, so nothing below jumps when they land.
        <div className="flex min-h-[152px] flex-wrap items-start justify-end gap-2 rounded-[10px] border border-border bg-card px-4 py-3">
          {aside}
        </div>
      )}
    </div>
  );
}

/** How old the reading is. The age is the payload's own `generatedAt` rather
 * than a per-source freshness: the question is "am I looking at a stale tab". */
function Census({ assetCount, generatedAt, nowMs }: { assetCount: number; generatedAt: string; nowMs: number }) {
  return (
    <span className="text-xs text-muted-foreground" data-portfolio-census>
      {/* One site is named on its lead; "1 site" would count nothing. */}
      {assetCount === 1 ? "updated" : `${siteCount(assetCount)} · updated`} {formatAge(ageMs(nowMs, generatedAt))} ago
    </span>
  );
}

// --- first run --------------------------------------------------------------

/** First-run steps: add a site, connect its first source, see its first
 * number. `firstRunSteps` ticks what the store shows is done and makes the
 * next one the screen's one primary action. */
const FIRST_RUN_ICON: Record<FirstRunStepKey, typeof Plus> = {
  add: Plus,
  connect: Cable,
  number: Activity,
};

/** What a stranger sees on a fresh install: one sentence saying what this
 * thing does, and the three steps to a first site. */
export function FirstRun({
  steps = firstRunSteps(null, []),
  footer,
}: {
  steps?: FirstRunStep[];
  /** A line under the steps: Home puts the clock proposal here, which draws
   * nothing once the clock is chosen. */
  footer?: ReactNode;
}) {
  return (
    <Card data-first-run>
      <CardContent className="flex flex-col gap-5 p-5">
        <h2 className="m-0 text-base font-semibold text-foreground">
          Your sites’ traffic, money and open work, in one place
        </h2>
        <ol className="grid gap-3 md:grid-cols-3">
          {steps.map((step, index) => {
            const Icon = step.state === "done" ? Check : FIRST_RUN_ICON[step.key];
            return (
              <li
                key={step.key}
                data-first-run-step={index + 1}
                data-first-run-state={step.state}
                className={cn("flex flex-col gap-2 rounded-lg border p-4", step.state === "current" ? "border-foreground/40" : "border-border")}
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                      step.state === "done" ? "bg-foreground text-background" : "border border-border bg-muted text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-xs tabular-nums text-muted-foreground">Step {index + 1}</span>
                    <FirstRunAction step={step} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {footer}
      </CardContent>
    </Card>
  );
}

/** A step as the one thing it can be: said as done, the primary action, a
 * link, or — with nowhere to go yet — its title alone. */
function FirstRunAction({ step }: { step: FirstRunStep }) {
  if (step.state === "done") {
    return <span className="font-medium text-muted-foreground">{step.title}</span>;
  }
  if (step.state === "current") {
    return step.key === "add" || step.to === null ? (
      <AddSiteButton size="sm" className="mt-0.5 self-start">
        {step.title}
      </AddSiteButton>
    ) : (
      <Button asChild size="sm" className="mt-0.5 self-start">
        <Link to={step.to}>{step.title}</Link>
      </Button>
    );
  }
  return step.to === null ? (
    <span className="font-medium text-muted-foreground">{step.title}</span>
  ) : (
    <Link
      to={step.to}
      className="inline-flex items-center max-sm:min-h-11 max-sm:min-w-11 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {step.title}
    </Link>
  );
}

export default HomeRoute;
