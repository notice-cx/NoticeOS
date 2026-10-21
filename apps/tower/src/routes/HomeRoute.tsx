import { Activity, Cable, Check, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { sourceReadings, type ConnectionReads } from "@shared/connection-status";
import { firstRunSite, firstRunSteps, sitePath, type FirstRunStep, type FirstRunStepKey } from "@shared/first-run";
import { viewCovers } from "@shared/asset-detail-views";
import { ageMs, formatAge, isAmber } from "@shared/freshness";
import { siteCount } from "@shared/site-noun";
import { siteDisplayOf, sitesShownOn } from "@shared/site-display";
import { DEFAULT_RANGE_DAYS } from "@shared/surface";
import type { HomeModuleId, WordLevel } from "@shared/views";
import type { AssetCard, WallPayload } from "@shared/wall";
import type { WallFeedPayload } from "@shared/wall-feed";
import { WORK_POLL_CADENCE_HOURS, type WorkItem, type WorkPayload } from "@shared/work";
import { AddSiteButton } from "@/components/AddSite";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { PageHeader } from "@/components/PageHeader";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { ReadFailed } from "@/components/ReadFailed";
import { PageSkeleton } from "@/components/Skeleton";
import { SeverityDot } from "@/components/SeverityDot";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { pillControlClass } from "@/components/ui/pill";
import { BarStrip } from "@/components/viz/BarStrip";
import { DecisionQueue, type QueueItem } from "@/components/viz/DecisionQueue";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { IncidentList } from "@/components/viz/IncidentList";
import { PortfolioRows, type PortfolioRow } from "@/components/viz/PortfolioRows";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { StatTile } from "@/components/viz/StatTile";
import { useAssetDetail } from "@/hooks/useAssetDetail";
import { useConnections } from "@/hooks/useConnections";
import { useFirstDraw } from "@/hooks/useFirstDraw";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { useWallFeed } from "@/hooks/useWallFeed";
import { useTasksLive } from "@/hooks/useTasks";
import { useView } from "@/hooks/useView";
import { useWork } from "@/hooks/useWork";
import { formatInt, formatPercent, formatPeriodMonthLong, formatSeriesDate, formatTimestamp, formatUsd } from "@/lib/format";
import { AGENTS_ROUTE } from "@/components/nav-items";
import { greeting, peopleInLast28Days } from "@/lib/home-brief";
import { homeMoney, siteDays, yesterdayMoney, type HomeMoney } from "@/lib/home-money";
import { openAlertsLabel } from "@/lib/severity";
import { siteHealth } from "@/lib/site-health";
import { rowFacts, techHealth, techHealthSummary } from "@/lib/tech-health";
import { cn } from "@/lib/utils";
import { incidentsFromIssues, timelineFromWall } from "@/lib/viz-adapters";
import { weekOnWeek } from "@/lib/sites-index";
import { completeDays } from "@/lib/wall-sites";
import { wallIssues, type WallIssue } from "@/lib/wall-issues";
import { hasRevenueSource, yesterdayTotal } from "@/lib/wall-revenue";
import { withSystemIssues } from "@/lib/wall-system-state";
import { SiteLead } from "@/routes/asset-detail/SiteLead";
import { ClockProposal } from "@/routes/home/ClockProposal";
import { ChannelsModule } from "@/routes/home/ChannelsModule";
import { FactoryModule } from "@/routes/home/FactoryModule";
import { GapsModule } from "@/routes/home/GapsModule";
import { HealthModule } from "@/routes/home/HealthModule";
import { HomeModules } from "@/routes/home/modules";
import { ViewQuestions } from "@/routes/home/ViewSteps";
import { MoneyHero } from "@/routes/home/MoneyHero";

/**
 * Home answers how the business is doing, what is broken and what needs the
 * operator, drawn from the data: the month's money as the lead with
 * yesterday's revenue within it and the last 28 days' visitors and sites beside it;
 * the ranked problems, the decisions waiting and the agents' work; the last day on a time axis. The
 * person's view picks which of these regions are drawn and in what order. A
 * fresh install sees the three steps to a first number instead.
 */
export function HomeRoute() {
  const wall = useWall();
  const { data, isError, error, isFetching, refetch } = wall;
  const feed = useWallFeed();
  const now = useNow();
  const connections = useConnections();
  // Every read the first screen draws from starts now and the screen is drawn
  // once they have answered, so its counts do not change as reads land. The
  // task capability read starts with them; it only enables Decide's verbs.
  const work = useWork();
  useTasksLive();
  const drawn = useFirstDraw([wall, feed, connections.providers, connections.monitoring, work]);
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
        actions={data && drawn && !guide ? <Census assetCount={data.assets.length} generatedAt={data.generatedAt} nowMs={now} /> : null}
      />

      {!data || !drawn ? (
        isError && !data ? (
          <ReadFailed title="Couldn't load Home" subject="read:home" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <PageSkeleton subject="read:home" shape="board" />
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
  const { modules, view } = useView();
  // Everything keeps its twelve-column grid; every other view stacks its
  // modules in columns, each at its own content's height.
  const stacks = view.id !== "everything";
  const issues = withSystemIssues(wallIssues({ assets: data.assets, attention: data.attention, connections, nowMs }), data.system, nowMs);
  const money = homeMoney(data.portfolio, data.assets);
  // The site rows (the sites compared and the day's lanes)
  // draw the sites whose Home and Sites list switch is on. A hidden site's
  // problems are still counted and listed; the money stays the portfolio's.
  const listed = sitesShownOn(data.assets, siteDisplayOf(data), "list");
  const hiddenIds = new Set(data.assets.filter((asset) => !listed.includes(asset)).map((asset) => asset.id));
  const aboutHidden = (ids: readonly string[]) => ids.length > 0 && ids.every((id) => hiddenIds.has(id));
  const oneSite = data.assets.length === 1 && listed.length === 1 ? listed[0]! : null;
  const since = feed?.since ?? null;
  const timeline = timelineFromWall(
    listed,
    issues.filter((issue) => !aboutHidden(issue.assets)),
    (feed?.items ?? []).filter((item) => item.asset === null || !aboutHidden([item.asset])),
    sitePath,
  );
  const changed = issues.filter((issue) => since !== null && issue.since !== null && issue.since >= since).length + timeline.events.length;
  // What the materiality suite reads: every open condition Home stands for, so
  // a problem the Wall lists is drawn here too.
  const conditions = new Set<string>(["open-flags", "human-gates", "os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail"]);
  for (const issue of issues) for (const condition of issue.conditions) conditions.add(condition);

  const sitesUnderVisitors = modules.includes("yesterday") && modules.includes("sites");
  const shownModules = sitesUnderVisitors ? modules.filter((module) => module !== "sites" && (money !== null || module !== "yesterday")) : modules;
  const draw: Record<HomeModuleId, () => ReactNode> = {
    money: () => (
      <div className="@3xl:col-span-2 @6xl:col-span-8" data-surface-hero="">
        {money ? <MoneyHero money={money} yesterday={yesterdayTotal(data.assets, nowMs)} className={stacks ? undefined : "h-full"} wordLevel={view.wordLevel} /> : <div className="flex flex-col gap-5"><PeopleLead assets={data.assets} />{sitesUnderVisitors ? draw.sites() : null}</div>}
      </div>
    ),
    yesterday: () => (
      <div className="flex flex-col gap-5 @3xl:col-span-2 @6xl:col-span-4" data-home-visitors="">
        {money ? <VisitorsLast28Days assets={data.assets} /> : null}
        {sitesUnderVisitors ? draw.sites() : null}
      </div>
    ),
    problems: () => (
      <IncidentList
        items={incidentsFromIssues(issues, { to: (issue) => issueLink(issue, data.assets) })}
        nowMs={nowMs}
        marker={since}
        compact
        action={{ label: "All alerts →", to: "/alerts" }}
        empty="Nothing is broken."
      />
    ),
    decide: () => <LiveDecidePanel nowMs={nowMs} />,
    agents: () => <LiveAgentsLine nowMs={nowMs} />,
    sites: () => (
      <div className="@3xl:col-span-2 @6xl:col-span-12" data-home-sites="">
        {oneSite ? <OneSiteLead site={oneSite} nowMs={nowMs} /> : <Sites assets={listed} issues={issues} money={money} nowMs={nowMs} />}
      </div>
    ),
    health: () => <HealthModule cards={listed} issues={issues} nowMs={nowMs} />,
    factory: () => <LiveFactory cards={listed} nowMs={nowMs} />,
    channels: () => <ChannelsModule cards={listed} />,
    gaps: () => <GapsModule cards={listed} />,
    timeline: () => (
      <section aria-labelledby="home-timeline-title" className="flex flex-col gap-4 rounded-xl bg-card px-5 py-4 ring-1 ring-border/70 @3xl:col-span-2 @6xl:col-span-12" data-home-timeline="">
        <SectionLabel id="home-timeline-title" title="Problems and activity" caption="Last 24 hours" />
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
    ),
  };

  return (
    // Laid out by its own width, not the window's: the sidebar, a portrait
    // monitor or a narrow window all leave Home less than the viewport, and
    // the twelve columns need room to be twelve.
    <div className="@container flex flex-col gap-5" data-home-brief={issues.length} data-material-condition={[...conditions].join(" ")}>
      <Answer
        money={money}
        issues={issues}
        since={since}
        changed={changed}
        nowMs={nowMs}
        health={view.id === "business" ? healthWords(listed, issues, nowMs) : null}
        wordLevel={view.wordLevel}
      />
      <HomeModules modules={shownModules} draw={draw} layout={stacks ? "stacks" : "grid"} />
    </div>
  );
}

/** Where a problem's row opens: its site, the System, or the alerts. */
function issueLink(issue: WallIssue, assets: readonly AssetCard[]): string {
  const asset = issue.assets.length === 1 ? assets.find((candidate) => candidate.id === issue.assets[0]) : undefined;
  if (asset) return issue.key.startsWith("source-") ? `/assets/${encodeURIComponent(asset.id)}/sources` : sitePath(asset);
  return issue.key.startsWith("system-") || issue.key.startsWith("source-") ? "/health" : "/alerts";
}

/** The sites' technical health in a sentence or two: how many are fine, then
 * the one most in need of a look and why. Null while no site is measured. */
export function healthWords(cards: readonly AssetCard[], issues: readonly WallIssue[], nowMs: number | null = null): { words: string; tone: "error" | "warn" | null } | null {
  const { fine, measured, lead } = techHealthSummary(cards, issues, nowMs);
  if (measured === 0) return null;
  const only = measured === 1 ? cards.find((card) => techHealth(card, issues, nowMs).key !== "unknown") : undefined;
  const count = lead === null
    ? only
      ? `${only.displayName} is fine.`
      : `All ${formatInt(measured)} sites are fine.`
    : `${formatInt(fine)} of ${formatInt(measured)} ${measured === 1 ? "site is" : "sites are"} fine.`;
  if (lead === null) return { words: count, tone: null };
  const facts = rowFacts(lead.health);
  const worst = facts.find((fact) => fact.state === "bad" && fact.note) ?? facts.find((fact) => fact.note);
  const note = worst?.note ? `: ${worst.note.charAt(0).toLowerCase()}${worst.note.slice(1)}` : ` is ${lead.health.word.toLowerCase()}`;
  return { words: `${count} ${lead.card.displayName}${note}.`, tone: lead.health.key === "trouble" ? "error" : "warn" };
}

/**
 * The screen's answer in one line under a quiet greeting: where the month is
 * heading, what is broken. The greeting and the window are an eyebrow; the
 * numbers below are the large type. Given the sites' health in words (the
 * business view), the line leads with it, and the count of open problems is
 * drawn only when there is one.
 */
function Answer({ money, issues, since, changed, nowMs, health = null, wordLevel = "technical" }: { money: HomeMoney | null; issues: readonly WallIssue[]; since: string | null; changed: number; nowMs: number; health?: { words: string; tone: "error" | "warn" | null } | null; wordLevel?: WordLevel }) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  const month = money ? formatPeriodMonthLong(money.period) : null;
  const previous = money?.previousPeriod ? formatPeriodMonthLong(money.previousPeriod) : null;
  const moneyWords = !money || month === null
    ? null
    : money.projected !== null
      ? `${month} is projected at ${usd(money.projected)}${money.changePercent !== null && previous ? `, ${formatPercent(Math.abs(money.changePercent))}% ${money.changePercent < 0 ? "under" : "over"} ${previous}` : ""}.`
      : money.soFar !== null
        ? `${month} so far ${usd(money.soFar)}${money.estimated && wordLevel !== "business" ? " est." : "."}`
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
      {health ? (
        <h2 className="m-0 text-figure-sm text-foreground [text-wrap:balance]" data-home-answer-health="">
          <span className={health.tone === "error" ? "text-error" : health.tone === "warn" ? "text-warn" : undefined}>{health.words}</span>
          {moneyWords ? <span> {moneyWords}</span> : null}
          {errors > 0 || warnings > 0 ? <span className={errors > 0 ? "text-error" : "text-warn"}> {problemWords}</span> : null}
        </h2>
      ) : (
        <h2 className="m-0 text-figure-sm text-foreground [text-wrap:balance]">
          {moneyWords ? <span>{moneyWords} </span> : null}
          <span className={errors > 0 ? "text-error" : warnings > 0 ? "text-warn" : undefined}>{problemWords}</span>
        </h2>
      )}
    </header>
  );
}

function VisitorsLast28Days({ assets, display = false }: { assets: readonly AssetCard[]; display?: boolean }) {
  const people = peopleInLast28Days(assets);
  const reported = people?.series.filter((point) => point.v !== null) ?? [];
  const usual = reported.length >= 3 ? reported.reduce((sum, day) => sum + (day.v ?? 0), 0) / reported.length : null;
  return (
    <StatTile
      label="Visitors in the last 28 days"
      value={people?.total ?? null}
      absent="nothing reported yet"
      format={formatInt}
      role="people"
      size={display ? "display" : "figure"}
      to="/assets"
      history={people && people.series.length >= 3 ? (
        <BarStrip contributors={people.contributors} partial={people.partial} data={people.series} tone="text-traffic" baseline={usual !== null ? { value: usual, label: `usual ${formatInt(usual)}` } : null} ariaLabel="Visitors a day, last 28 days" className={display ? "h-20" : "h-10"} />
      ) : null}
      context={people ? <>as of <b>{formatSeriesDate(people.date)}</b>{reported.length < DEFAULT_RANGE_DAYS ? ` · ${reported.length} of ${DEFAULT_RANGE_DAYS} days reported` : people.partial.length > 0 ? " · some sites have missing days" : null}</> : null}
    />
  );
}

/** With no revenue source anywhere, people lead: no money figure nobody counted. */
function PeopleLead({ assets }: { assets: readonly AssetCard[] }) {
  return <VisitorsLast28Days assets={assets} display />;
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
      icon: <PropertyFavicon domain={asset.id} icons={asset.icons} displayName={asset.displayName} />,
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

/** Home shows the most urgent decisions; Tasks holds the full queue. */
const DECIDE_ROWS = 3;

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

function LiveFactory({ cards, nowMs }: { cards: readonly AssetCard[]; nowMs: number }) {
  const work = useWork();
  return <FactoryModule cards={cards} work={work.data ?? null} nowMs={nowMs} />;
}

function LiveAgentsLine({ nowMs }: { nowMs: number }) {
  const work = useWork();
  return <AgentsLine work={work.data} failed={work.isError} nowMs={nowMs} />;
}

/** The agents' completed and active work, from the same snapshot as Decisions. */
export function AgentsLine({ work, failed = false, nowMs = Date.now() }: { work: WorkPayload | undefined; failed?: boolean; nowMs?: number }) {
  const totals = new Map<string, { name: string; closed: number; active: number; agent: boolean }>();
  const projects = work?.projects ?? [];
  for (const project of projects) {
    for (const worker of project.ok ? project.workers ?? [] : []) {
      const entry = totals.get(worker.id) ?? { name: worker.id, closed: 0, active: 0, agent: false };
      totals.set(worker.id, { ...entry, closed: entry.closed + worker.closedRecent, active: entry.active + worker.inProgress, agent: entry.agent || worker.model !== null });
    }
  }
  const agents = [...totals.values()].filter((entry) => entry.agent).sort((a, b) => b.closed - a.closed || a.name.localeCompare(b.name));
  const hasSnapshot = work?.capturedAt != null;
  const complete = projects.length > 0 && projects.every((project) => project.ok && project.workers !== undefined);
  const note = failed || !complete ? "partial read" : hasSnapshot && isAmber(nowMs, work.capturedAt, WORK_POLL_CADENCE_HOURS) ? "outdated" : undefined;
  const closed = agents.reduce((sum, entry) => sum + entry.closed, 0);
  const active = agents.reduce((sum, entry) => sum + entry.active, 0);
  const empty = failed ? "Could not read agent activity." : work === undefined ? "Reading agent activity…" : !hasSnapshot ? "No agent activity read yet." : !complete ? "Agent activity not fully read." : "No agent activity reported.";
  return (
    <section aria-label="Agents" className="flex min-w-0 flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70" data-home-agents="">
      <SectionLabel title="Agents" action={{ label: "Agents →", to: AGENTS_ROUTE }} />
      {!hasSnapshot || agents.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{empty}</p> : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div><span className="block text-figure tabular-nums" data-agents-closed="">{formatInt(closed)}</span><span className="text-xs text-muted-foreground">Closed in 7 days</span></div>
            <div><span className="block text-figure tabular-nums" data-agents-active="">{formatInt(active)}</span><span className="text-xs text-muted-foreground">In progress</span></div>
          </div>
          {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {agents.slice(0, 3).map((entry) => (
              <li key={entry.name} className="flex min-w-0 items-center gap-2 text-xs" aria-label={`${entry.name}: ${formatInt(entry.closed)} closed, ${formatInt(entry.active)} in progress`}>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.name}</span>
                <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-viz-track"><span className="block h-full rounded-full bg-muted-foreground/60" style={{ width: `${closed > 0 ? entry.closed / closed * 100 : 0}%` }} /></span>
                <span className="w-10 text-end tabular-nums">{formatInt(entry.closed)}</span>
              </li>
            ))}
          </ul>
          {agents.length > 3 ? <span className="text-xs text-muted-foreground">{formatInt(agents.length - 3)} more {agents.length === 4 ? "agent" : "agents"}</span> : null}
        </>
      )}
    </section>
  );
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
    returnTo: "/",
  };
}

/** Home's bounded decision summary; full requests and their actions open on Tasks. */
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
      title="Decisions"
      compact
      action={{ label: "All tasks →", to: "/tasks/all" }}
      limit={DECIDE_ROWS}
      empty={empty}
      className="flex-1"
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
 * thing does, the two view questions until the person answers them, and the
 * three steps to a first site. */
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
        <ViewQuestions />
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
