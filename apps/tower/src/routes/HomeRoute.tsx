import { Activity, Cable, Check, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { sourceReadings } from "@shared/connection-status";
import { firstRunSite, firstRunSteps, sitePath, type FirstRunStep, type FirstRunStepKey } from "@shared/first-run";
import { viewCovers } from "@shared/asset-detail-views";
import { ageMs, formatAge, isAmber } from "@shared/freshness";
import { siteCount } from "@shared/site-noun";
import { DEFAULT_RANGE_DAYS } from "@shared/surface";
import type { AssetCard, SystemBand } from "@shared/wall";
import { WORK_POLL_CADENCE_HOURS, type WorkItem, type WorkPayload } from "@shared/work";
import { AddSiteButton } from "@/components/AddSite";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { HighlightCard } from "@/components/HighlightCard";
import { PageHeader } from "@/components/PageHeader";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { ReadFailed } from "@/components/ReadFailed";
import { SeverityDot } from "@/components/SeverityDot";
import { StateChip } from "@/components/StateChip";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { pillControlClass } from "@/components/ui/pill";
import { useAssetDetail } from "@/hooks/useAssetDetail";
import { useConnections } from "@/hooks/useConnections";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { useWallFeed } from "@/hooks/useWallFeed";
import { useWork } from "@/hooks/useWork";
import { useDemoReadonly } from "@/lib/browser-context";
import { formatInt, formatPercent, formatSeriesDate, formatTimestamp, formatUsd } from "@/lib/format";
import { greeting, homeBrief, type HomeBrief } from "@/lib/home-brief";
import { openAlertsLabel } from "@/lib/severity";
import { siteHealth } from "@/lib/site-health";
import { askVerb } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";
import { hasRevenueSource, monthRevenue, yesterdayTotal } from "@/lib/wall-revenue";
import { SiteLead } from "@/routes/asset-detail/SiteLead";
import { ClockProposal } from "@/routes/home/ClockProposal";
import { useAskActions } from "@/routes/tasks/ask-actions";
import { askFace } from "@/routes/tasks/task-face";

/**
 * HOME IS THE MORNING BRIEF (D44, doc 21 § Home; the research and the prior
 * art in docs/briefs/2026-10-08-home-overview-redesign.md).
 *
 * It answers one question — what changed since I last looked, and what needs
 * me — in this order: a greeting line with three small figures (yesterday's
 * money, the month's pace, yesterday's visitors); at most five highlight
 * cards, the first the big thing; Decide, at most three rows with their verbs
 * on the row; the sites in seed order with one health word each; and a finish
 * line. The OS never describes itself here: freshness, jobs and snapshots
 * belong to System health, and a broken thing arrives as a highlight card.
 */
export function HomeRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const feed = useWallFeed();
  const now = useNow();
  const connections = useConnections();
  // Setup is done at the first collected number (bead `ro-ujb9.123`); until
  // then Home is the guide, following the newest site.
  const guide = data ? firstRunSite(data.assets) : null;
  const oneSite = data && !guide && data.assets.length === 1 ? data.assets[0]! : null;
  const brief = data && !guide
    ? homeBrief({
        assets: data.assets,
        attention: data.attention,
        portfolio: data.portfolio,
        system: data.system,
        connections,
        feed: feed.data ?? null,
        nowMs: now,
        sitePath: (id) => {
          const card = data.assets.find((candidate) => candidate.id === id);
          return card ? sitePath(card) : `/assets/${encodeURIComponent(id)}`;
        },
      })
    : null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3.5 p-4 md:p-6">
      <PageHeader
        title="Home"
        documentTitle={null}
        // The census is a FACT about the page, not a control, and doc 21 seats
        // it at the end of the header row: how old the reading is, in one
        // quiet line.
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
        <>
          <Brief brief={brief!} assets={data.assets} portfolio={data.portfolio} system={data.system} nowMs={now} generatedAt={data.generatedAt} />

          <div className={cn("grid gap-3.5", !oneSite && "lg:grid-cols-2")}>
            <LiveDecidePanel nowMs={now} />
            {oneSite ? null : <SitesStrip assets={data.assets} brief={brief!} nowMs={now} />}
          </div>

          {/* ONE SITE IS THAT SITE (bead `ro-ujb9.127`): its own numbers and
              chart, the Overview's lead from the same read, under the brief. */}
          {oneSite ? <OneSiteLead site={oneSite} nowMs={now} /> : null}
        </>
      )}
    </div>
  );
}

// ─── the brief ───────────────────────────────────────────────────────────────

/**
 * THE GREETING LINE AND THE CARDS. The three figures are the Wall's own
 * derivations (`monthRevenue`, `yesterdayTotal`) and the brief's visitors;
 * "since 6 PM yesterday · N things changed" is the feed's window, the
 * time-blindness aid the research asks for — relative, exact on hover.
 */
function Brief({
  brief,
  assets,
  portfolio,
  system,
  nowMs,
  generatedAt,
}: {
  brief: HomeBrief;
  assets: AssetCard[];
  portfolio: Parameters<typeof monthRevenue>[0];
  system: SystemBand;
  nowMs: number;
  generatedAt: string;
}) {
  const money = monthRevenue(portfolio, assets);
  const yesterday = yesterdayTotal(assets, nowMs);
  const sinceAge = brief.since ? ageMs(nowMs, brief.since) : null;
  // What the materiality suite reads: every open condition the brief stands
  // for, so a problem the Wall's Needs you lists is listed here too.
  const conditions = new Set<string>(["open-flags", "human-gates"]);
  if (system) for (const condition of ["os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail"]) conditions.add(condition);
  for (const card of brief.cards) for (const condition of card.conditions) conditions.add(condition);

  return (
    <section
      aria-labelledby="home-brief"
      data-surface-hero=""
      data-home-brief={brief.cards.length}
      data-material-condition={[...conditions].join(" ")}
      className="flex flex-col gap-3.5"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="home-brief" className="m-0 text-[26px] font-bold leading-[1.1] tracking-[-0.03em] text-foreground max-sm:text-[22px]">
            {greeting(nowMs)}
          </h2>
          <span className="text-[13px] tabular-nums text-muted-foreground" data-brief-since>
            {brief.since ? (
              <>
                since <time dateTime={brief.since} title={formatTimestamp(brief.since)}>{sinceAge === null ? "yesterday" : `${formatAge(sinceAge)} ago`}</time>
                {" · "}
              </>
            ) : null}
            {brief.changed === 0 ? "nothing changed" : `${formatInt(brief.changed)} ${brief.changed === 1 ? "thing" : "things"} changed`}
          </span>
        </div>
        <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2 tabular-nums" data-brief-figures>
          {yesterday && !yesterday.mixedBasis && yesterday.amount !== null ? (
            <Figure label="Yesterday" value={formatUsd(yesterday.amount, { cents: true })} note="est." tone="text-financial-revenue" />
          ) : null}
          {money?.pace ? (
            <Figure
              label={`${formatSeriesDate(`${money.period}-01`).replace(/\s\d+$/, "")} pace`}
              value={formatUsd(money.pace.projected)}
              note={money.pace.changePercent === null ? undefined : `${money.pace.changePercent >= 0 ? "↑" : "↓"} ${formatPercent(Math.abs(money.pace.changePercent))}%`}
            />
          ) : money && money.revenue !== null ? (
            <Figure label={`${formatSeriesDate(`${money.period}-01`).replace(/\s\d+$/, "")} so far`} value={formatUsd(money.revenue)} />
          ) : null}
          {brief.people ? (
            <Figure label="Visitors yesterday" value={formatInt(brief.people.total)} />
          ) : null}
        </dl>
      </div>

      <div className="grid gap-3.5 lg:grid-cols-3" data-brief-cards>
        {brief.cards.map((card, index) => (
          <HighlightCard
            key={card.key}
            kind={card.kind}
            severity={card.severity}
            site={card.site}
            title={card.title}
            detail={card.detail}
            figure={card.figure}
            spark={card.spark}
            action={card.action}
            big={index === 0}
            marks={{ "data-brief-card": card.key, ...(card.assetId ? { "data-subject": `asset:${card.assetId}` } : {}) }}
          />
        ))}
        <FinishLine quiet={brief.cards.length === 0} since={brief.since} generatedAt={generatedAt} nowMs={nowMs} />
      </div>
    </section>
  );
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

function Figure({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className={cn("m-0 text-[22px] font-semibold leading-none tracking-[-0.02em]", tone ?? "text-foreground")}>
        {value}
        {note ? <span className="ms-1.5 text-xs font-medium text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}

/**
 * THE END OF THE BRIEF (doc 21 § Home; Intuit's and Pivotlog's empty-state
 * guidance in the brief): a list the eye can finish. One line, then how old
 * the reading is. On a quiet day it is the whole brief.
 */
function FinishLine({ quiet, since, generatedAt, nowMs }: { quiet: boolean; since: string | null; generatedAt: string; nowMs: number }) {
  const age = ageMs(nowMs, generatedAt);
  const sinceWords = since ? `since ${sinceClock(since, nowMs)}` : "since yesterday";
  return (
    <Card
      kind="neutral"
      data-finish-line={quiet ? "quiet" : ""}
      className={cn("flex min-h-24 flex-col items-center justify-center gap-1 border-dashed p-4 text-center", quiet && "lg:col-span-3")}
    >
      <span className="text-sm font-medium text-foreground">{quiet ? `Nothing changed ${sinceWords}.` : `That's everything ${sinceWords}.`}</span>
      <span className="text-xs tabular-nums text-muted-foreground">data as of {age === null ? "unknown" : `${formatAge(age)} ago`}</span>
    </Card>
  );
}

// ─── decide ──────────────────────────────────────────────────────────────────

/** How many rows Decide shows before its own expander: three, the number a
 * person can hold while reading the cards above (doc 21). */
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

/**
 * DECIDE — every project's operator inbox, flattened, with the verb on the row
 * (doc 21 § Home; Linear Triage, Superhuman and Codex in the brief's prior
 * art). A gate offers Approve; an ask offers Answer and Dismiss; both go
 * through the Tasks board's own path, with its Undo toast.
 *
 * The three empty states are three different facts and never share a
 * sentence: the read has not answered yet, nothing has ever been read, or
 * there is genuinely nothing to decide. Only the third one is good news.
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
  const count = !hasSnapshot
    ? undefined
    : complete
      ? `${formatInt(total)} waiting${stale ? " · outdated" : ""}`
      : total > 0
        ? `${formatInt(total)}+ waiting · partial read`
        : "count unknown";
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

  return (
    <ListPanel
      title="Decide"
      count={count}
      action={{ label: ordered.length > DECIDE_ROWS ? `${formatInt(ordered.length - DECIDE_ROWS)} more` : "All tasks", to: "/tasks" }}
      limit={DECIDE_ROWS}
      empty={empty}
    >
      {ordered.map((row) => (
        <DecideRow key={row.item.id} row={row} nowMs={nowMs} />
      ))}
    </ListPanel>
  );
}

function DecideRow({ row, nowMs }: { row: WaitingRow; nowMs: number }) {
  const location = useLocation();
  const readonly = useDemoReadonly();
  const { item, project, asset } = row;
  const { buttons, box } = useAskActions({
    ask: askVerb(item),
    id: item.id,
    title: item.title,
    project: asset,
    disabledReason: readonly ? "Read-only demo" : null,
    placement: "row",
  });
  return (
    <ListRow
      marks={{ "data-subject": `task:${item.id}` }}
      to={`/tasks/${encodeURIComponent(item.id)}`}
      returnTo={`${location.pathname}${location.search}`}
      // The Tasks board's own ask face (bead ro-ujb9.240): warn at every
      // priority and a gate's △. Priority is the ORDER, never the colour.
      {...askFace(item)}
      title={item.title}
      // Business altitude (doc 17): the project and what the row asks, never
      // the task's id — that is on the page the row opens.
      caption={item.issueType === "gate" ? `${project} · needs your approval` : project}
      value={formatAge(ageMs(nowMs, item.updatedAt))}
      valueLabel="waiting"
      rowActions={buttons}
      below={box}
    />
  );
}

// ─── sites ───────────────────────────────────────────────────────────────────

/**
 * THE SITES, IN SEED ORDER, ONE HEALTH WORD EACH (doc 21 § Home). Never
 * sorted: the operator learns where each site is and it stays there whether
 * or not it had a good week. The comparison table is on Sites; this strip
 * says the one word and the one figure a glance needs.
 */
function SitesStrip({ assets, brief, nowMs }: { assets: AssetCard[]; brief: HomeBrief; nowMs: number }) {
  return (
    <section aria-label="Sites" className="flex flex-col rounded-[10px] border border-border bg-card" data-sites-strip>
      <SectionLabel title="Sites" caption={siteCount(assets.length)} action={{ to: "/assets", label: "All sites →" }} className="px-4 pb-2 pt-3" />
      <ul className="m-0 grid list-none gap-px bg-border/60 p-0 sm:grid-cols-2 xl:grid-cols-3">
        {assets.map((asset) => {
          const health = siteHealth(asset, brief.issues);
          const yesterday = hasRevenueSource(asset) ? yesterdayTotal([asset], nowMs) : null;
          const people = settledPeople(asset);
          return (
            <li key={asset.id} className="m-0 bg-card" data-site-cell={asset.id} data-subject={`asset:${asset.id}`}>
              <Link
                to={sitePath(asset)}
                className={cn(pillControlClass, "flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-muted/40 motion-safe:transition-colors max-sm:min-h-11")}
              >
                <PropertyFavicon domain={asset.id} displayName={asset.displayName} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium text-foreground">{asset.displayName}</span>
                  <span className="truncate text-xs tabular-nums text-muted-foreground">
                    {yesterday && yesterday.amount !== null && !yesterday.mixedBasis
                      ? `${formatUsd(yesterday.amount, { cents: true })} yesterday${people !== null ? ` · ${formatInt(people)} people` : ""}`
                      : people !== null
                        ? `${formatInt(people)} people a day`
                        : health.key === "setting-up"
                          ? "no numbers yet"
                          : "nothing reported yesterday"}
                  </span>
                </span>
                <StateChip label={health.word} tone={health.tone} subject={`asset:${asset.id}`} />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A site's visitors on its latest settled day, or null when nothing settled. */
function settledPeople(asset: AssetCard): number | null {
  const { series, provisionalFrom } = asset.activeUsers;
  const settled = series.filter((point) => provisionalFrom === null || point.t < provisionalFrom);
  return settled.at(-1)?.v ?? null;
}

// ─── one site ────────────────────────────────────────────────────────────────

/**
 * THE ONE SITE'S OWN LEAD (bead `ro-ujb9.127`): the Overview's strip and
 * chart for that site, read through the same view the Overview reads (so
 * opening the site is instant), over the default 28 days. The header row's end
 * is the site — its state marks and its name as the way to its page.
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

/**
 * How old the reading is — doc 21's Home header line. The age is the payload's
 * own `generatedAt` rather than a per-source freshness: the question here is
 * "am I looking at a stale tab".
 */
function Census({ assetCount, generatedAt, nowMs }: { assetCount: number; generatedAt: string; nowMs: number }) {
  return (
    <span className="text-xs text-muted-foreground" data-portfolio-census>
      {/* One site is named on its lead; "1 site" would count nothing. */}
      {assetCount === 1 ? "updated" : `${siteCount(assetCount)} · updated`} {formatAge(ageMs(nowMs, generatedAt))} ago
    </span>
  );
}

// ─── first run ───────────────────────────────────────────────────────────────

/**
 * First-run steps: add a site, connect its first source, see its first number.
 *
 * EACH STEP IS ITS TITLE (bead `ro-ujb9.96.6.12`), and THE STEPS ARE DERIVED,
 * NOT LISTED (bead `ro-ujb9.123`): `firstRunSteps` ticks what the store shows
 * is done and makes the next one the screen's ONE primary action.
 */
const FIRST_RUN_ICON: Record<FirstRunStepKey, typeof Plus> = {
  add: Plus,
  connect: Cable,
  number: Activity,
};

/**
 * WHAT A STRANGER SEES ON A FRESH INSTALL (bead `ro-vtf7`): one sentence
 * saying what this thing does, and the three steps to a first site, each a
 * glyph and a link rather than a paragraph.
 */
export function FirstRun({
  steps = firstRunSteps(null, []),
  footer,
}: {
  steps?: FirstRunStep[];
  /** A line under the steps: Home puts the clock proposal here (bead
   * `ro-ujb9.134`), which draws nothing once the clock is chosen. */
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
