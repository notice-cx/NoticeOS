import type { Ga4RealtimePayload } from "@noticeos/contract";
import { Activity, Cable, Check, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { translateAlert } from "@shared/alert-language";
import { sourceReadings } from "@shared/connection-status";
import { firstRunSite, firstRunSteps, type FirstRunStep, type FirstRunStepKey } from "@shared/first-run";
import { viewCovers } from "@shared/asset-detail-views";
import { ageMs, formatAge, isAmber } from "@shared/freshness";
import { siteCount } from "@shared/site-noun";
import { DEFAULT_RANGE_DAYS } from "@shared/surface";
import {
  osReportMissing,
  unreadOperatorPosture,
  type AssetCard,
  type AttentionItem,
  type OperatorPosture,
  type PortfolioBand,
  type SystemBand as SystemData,
} from "@shared/wall";
import {
  WORK_POLL_CADENCE_HOURS,
  type WorkItem,
  type WorkPayload,
} from "@shared/work";
import { isGrouped, memberNames } from "@/lib/attention";
import { operatorState } from "@/lib/operator-posture";
import { AddSiteButton } from "@/components/AddSite";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
import { SegmentBar } from "@/components/SegmentBar";
import { SeverityDot } from "@/components/SeverityDot";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { pillControlClass } from "@/components/ui/pill";
import { useAssetDetail } from "@/hooks/useAssetDetail";
import { useConnections } from "@/hooks/useConnections";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useNow } from "@/hooks/useNow";
import { portfolioHeadline, portfolioHeadlineWord } from "@/lib/portfolio-headline";
import { coverageSeverity, openAlertsLabel } from "@/lib/severity";
import { useWall } from "@/hooks/useWall";
import { useSitePath } from "@/hooks/useSitePath";
import { useWork } from "@/hooks/useWork";
import { formatInt, formatPeriodMonth, formatPeriodMonthYear, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
// Home and Sites share the comparison table; the caller controls ordering.
import { AssetsTable } from "@/routes/assets/AssetsTable";
import { SiteLead } from "@/routes/asset-detail/SiteLead";
import { ClockProposal } from "@/routes/home/ClockProposal";
import { askFace } from "@/routes/tasks/task-face";
/** Home separates an accounting month's money from the latest reported status.
 * Neither group has a user-selected time window. */
export function HomeRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const realtime = useGa4Realtime();
  const now = useNow();
  const { credentials, items } = useConnections();
  // Setup is done at the first collected number (bead `ro-ujb9.123`); until
  // then Home is the guide, following the newest site.
  const guide = data ? firstRunSite(data.assets) : null;
  const oneSite = data && !guide && data.assets.length === 1 ? data.assets[0]! : null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3.5 p-4 md:p-6">
      <PageHeader
        title="Home"
        // The census is a FACT about the page, not a control, and doc 21 seats
        // it at the end of the header row: how many assets this covers and how
        // old the reading is, in one quiet line. `actions` is the only slot on
        // that row; `meta` sits under the title, where the mockup has nothing.
        actions={
          data && !guide ? (
            <Census assetCount={data.assets.length} generatedAt={data.generatedAt} nowMs={now} />
          ) : null
        }
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
            guide.site ? sourceReadings(guide.site.id, guide.site.dataSources, { credentials, items }, now) : [],
          )}
          footer={<ClockProposal />}
        />
      ) : (
        <>
          {/* ONE SITE IS THAT SITE (bead `ro-ujb9.127`). With one site the
              portfolio is the site, so Home leads with its own numbers and
              chart — the Overview's lead, from the same read — and the
              comparison table of one row goes. From two sites the table is
              the answer again. */}
          {/* ON A PHONE, WHAT NEEDS YOU COMES FIRST (bead `ro-ujb9.13`, doc
              21's phone first screen). Stacked in desk order, a phone put the
              one site's chart (or the month's money) above Needs you and Open
              alerts, which landed at 942px of an 844px screen. Below `sm` the
              status strip leads, then the site, then the rows that need you,
              then the money — by `order`, so the desk's composition, and its
              reading order, are untouched. */}
          {oneSite ? <OneSiteLead site={oneSite} nowMs={now} className="max-sm:order-2" /> : null}

          <div className="grid gap-3.5 lg:grid-cols-4 max-sm:contents">
            <section aria-labelledby="home-financials-scope" className="overflow-hidden rounded-[10px] border border-border bg-card max-sm:order-4">
              <SectionLabel id="home-financials-scope" title={`Financials · ${formatPeriodMonthYear(data.portfolio.period)}`} className="min-h-10 border-b border-border/60 px-4 py-2" />
              <KpiStrip columns={1}>
                <NetKpi portfolio={data.portfolio} />
              </KpiStrip>
            </section>
            <section
              aria-labelledby="home-status-scope"
              data-surface-hero={oneSite ? undefined : ""}
              className="overflow-hidden rounded-[10px] border border-border bg-card lg:col-span-3 max-sm:order-1"
            >
              <SectionLabel id="home-status-scope" title="Latest status" className="min-h-10 border-b border-border/60 px-4 py-2" />
              <KpiStrip columns={3}>
                <NeedsYouKpi operator={data.operator ?? unreadOperatorPosture()} nowMs={now} />
                <OpenAlertsKpi items={data.attention} />
                <SystemKpi system={data.system} nowMs={now} />
              </KpiStrip>
            </section>
          </div>

          <div className="grid gap-3.5 max-sm:order-3 lg:grid-cols-2">
            <LiveWaitingPanel nowMs={now} />
            <AlertsPanel items={data.attention} nowMs={now} />
          </div>

          {oneSite ? null : <AssetsPanel assets={data.assets} nowMs={now} ga4Realtime={realtime.data} className="max-sm:order-5" />}
        </>
      )}
    </div>
  );
}

/**
 * THE ONE SITE'S OWN LEAD (bead `ro-ujb9.127`): the Overview's strip and
 * chart for that site, read through the same view the Overview reads (so
 * opening the site is instant), over the default 28 days. The header row's end
 * is the site — its state marks, as the Sites table's State cell draws them,
 * and its name as the way to its page.
 */
function OneSiteLead({ site, nowMs, className }: { site: AssetCard; nowMs: number; className?: string }) {
  const { data } = useAssetDetail(site.id, "overview");
  const connections = useConnections();
  const to = `/assets/${encodeURIComponent(site.id)}`;
  const aside = (
    <>
      <SeverityDot
        severity={site.worstSeverity}
        title={openAlertsLabel(site.openError, site.openWarn)}
      />
      <DataSourceIcons sources={sourceReadings(site.id, site.dataSources, connections, nowMs)} />
      <Link
        to={to}
        className={cn(
          "text-xs font-medium text-foreground underline-offset-4 hover:underline",
          pillControlClass,
          "max-sm:-my-2.5 max-sm:inline-flex max-sm:items-center",
        )}
      >
        {site.displayName} →
      </Link>
    </>
  );
  return (
    <div data-surface-hero data-one-site-lead={site.id} className={className}>
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
 * What this page covers and how old the reading is — doc 21's Home header line.
 *
 * The age is the payload's own `generatedAt` rather than a per-lane freshness:
 * the question here is "am I looking at a stale tab", and every lane's own age
 * is a badge on the row that owes it.
 */
function Census({
  assetCount,
  generatedAt,
  nowMs,
}: {
  assetCount: number;
  generatedAt: string;
  nowMs: number;
}) {
  return (
    <span className="text-xs text-muted-foreground" data-portfolio-census>
      {/* One site is named on the lead below; "1 site" would count nothing. */}
      {assetCount === 1 ? "updated" : `${siteCount(assetCount)} · updated`}{" "}
      {formatAge(ageMs(nowMs, generatedAt))} ago
    </span>
  );
}

/**
 * First-run steps: add a site, connect its first source, see its first number.
 *
 * EACH STEP IS ITS TITLE (bead `ro-ujb9.96.6.12`). Every step carried a
 * two-sentence note under it — what the wizard asks, where providers are
 * connected, that missing data is not zero — and every one of those sentences
 * is said again, at the moment it matters, by the screen the step opens. A
 * blankslate is one line and its actions (Primer's blankslate guideline:
 * secondary text "brief and non-redundant"), so the notes are gone.
 *
 * THE STEPS ARE DERIVED, NOT LISTED (bead `ro-ujb9.123`): `firstRunSteps`
 * ticks what the store shows is done, makes the next one the screen's ONE
 * primary action (docs/15 principle 4) and points each at this site — Add
 * opens over Home (bead `ro-ujb9.96.7.5`), Connect opens the site's first
 * source in the connect panel, and the last step opens the site's Overview,
 * where its first number appears.
 */
const FIRST_RUN_ICON: Record<FirstRunStepKey, typeof Plus> = {
  add: Plus,
  connect: Cable,
  number: Activity,
};

/**
 * WHAT A STRANGER SEES ON A FRESH INSTALL (bead `ro-vtf7`).
 *
 * With an empty store the strip reads zero, the two panels read all-clear and
 * the table reads "No assets onboarded yet" — five designed empty states adding
 * up to an undesigned page, and the one page that is the product's first
 * impression once NoticeOS is open-sourced. docs/15 principle 2 says every
 * state is designed, so Home carries the orientation: what this thing does, and
 * the way to a first asset — step 1 being the add-asset wizard itself since bead
 * `ro-qsoo` built it.
 *
 * So the strip, the panels and the table do not render at all here — a zero
 * claims something was measured, and nothing has been. What renders instead is
 * one sentence saying what this thing does, and the three steps to a first
 * asset, each a glyph and a link rather than a paragraph (doc 14, 2026-09-04).
 * The System KPI goes with them: the OS watches itself as asset #0, and an empty
 * store has no such row.
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

        {/* Stepper's vocabulary at tile scale: monochrome, numbered, ordered
            left to right, a done step filled with a tick and the current one
            ringed. Not the `Stepper` component itself — that one takes a flat
            label list and an active index, and these steps carry a glyph and a
            destination each. Used once, so it stays local (doc 14
            new-component budget). */}
        <ol className="grid gap-3 md:grid-cols-3">
          {steps.map((step, index) => {
            const Icon = step.state === "done" ? Check : FIRST_RUN_ICON[step.key];
            return (
              <li
                key={step.key}
                data-first-run-step={index + 1}
                data-first-run-state={step.state}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-4",
                  step.state === "current" ? "border-foreground/40" : "border-border",
                )}
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                      step.state === "done"
                        ? "bg-foreground text-background"
                        : "border border-border bg-muted text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      Step {index + 1}
                    </span>
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

/**
 * MONEY LEADS (D13). The same figure `/financials` states, chosen by the same
 * rule (`portfolioHeadline`) rather than re-derived —
 * a KPI quoting a different net than the page it links to would be worse than no
 * KPI.
 *
 * Its movement carries NO VERDICT (doc 21): a month whose net fell because an
 * annual invoice landed is not a worse month, so the KPI shows its COMPOSITION
 * instead — "revenue $441 · cost $241 · estimated" — and spends no colour on a
 * direction it cannot judge. That is `improvement="none"`, which also mutes the
 * sparkline under it.
 *
 * THE SERIES IS THE RAW MONTHLY NET, not a trailing average (bead
 * `ro-78qo.18`). Seven periods of a MONTHLY series is seven months, and on a
 * portfolio with six months of history that mean is almost a straight line with
 * the one dip worth seeing smoothed out of it. `sparkAverage={false}` draws the
 * months themselves, and `sparkProvisionalFrom` keeps the endpoint hollow while
 * the month is still being lived in.
 */
function NetKpi({ portfolio }: { portfolio: PortfolioBand }) {
  const lead = portfolioHeadline(portfolio);
  /**
   * The month still being lived in, or `null` when the headline fell back to a
   * closed one (bead `ro-bdkp`). A hollow endpoint ASSERTS that the last point
   * is incomplete, and on a fallback month nothing here is open — so it falls
   * silent exactly as the Wall's card does.
   */
  const openPeriod = portfolio.periodIsCurrent ? portfolio.period : null;

  // THE MONTH IS THE LABEL, not a sentence under the figure (bead `ro-bdkp`,
  // restated on `ro-78qo.6`). `period` is NOT always this month — the payload
  // falls back to the latest month that HAS ledger rows, so on the 2nd of
  // September this figure can be August's — and the rule that has to hold is
  // that a fallback is never read as today's money. Naming the month in the
  // eyebrow does that in two words, where "August 2026 · latest month on the
  // ledger" spent a whole line under the figure saying it. The reason a month
  // can be the fallback is About material, and that is where it now lives.
  const monthLabel = `Net · ${formatPeriodMonth(portfolio.period)}`;

  if (lead === null) {
    // A dash rather than $0, which would claim a month was counted.
    return (
      <Kpi
        label={monthLabel}
        value="—"
        improvement="none"
        caption={`no revenue or costs for ${formatPeriodMonth(portfolio.period)} yet`}
      />
    );
  }

  return (
    <Kpi
      label={monthLabel}
      value={formatMoney(lead.figure.net, lead.figure.currency)}
      improvement="none"
      caption={
        <>
          revenue {formatMoney(lead.figure.revenue, lead.figure.currency)} · cost{" "}
          {formatMoney(lead.figure.cost, lead.figure.currency)} · {portfolioHeadlineWord(lead.state)}
        </>
      }
      // Below three points a line is two dots joined by a segment, which the
      // eye reads as a trend the data cannot support — `Kpi` draws nothing at
      // all there, so the months are handed over whole.
      spark={portfolio.netTrendAll}
      sparkAverage={false}
      sparkProvisionalFrom={openPeriod}
      format={(value) => formatMoney(value, portfolio.netTrendAllCurrency)}
    />
  );
}

/**
 * The operator's own inbox: how many of the things waiting are URGENT.
 *
 * The urgent count leads because that is the number that decides whether the
 * next hour is spent here (doc 21's mockup, and `bd`'s own ranking); the rest of
 * the queue rides the caption. A zero is calm ONLY when the snapshot earned it,
 * which is `operatorState`'s rule and the reason "Inbox unknown" and "Inbox
 * stale" are warn even though both count zero.
 *
 * The bar needs BOTH figures to be exact. `operatorLabel` renders "12+" and "3+"
 * whenever a project failed to supply an untruncated count — visible lower
 * bounds, on purpose — and a proportion drawn from two lower bounds is not a
 * lower bound, it is a wrong fraction drawn loud. So the bar appears only on a
 * complete snapshot with something actually waiting.
 */
function NeedsYouKpi({
  operator,
  nowMs,
}: {
  operator: OperatorPosture;
  nowMs: number;
}) {
  const state = operatorState(operator, nowMs)!;
  const exactSplit = state.complete && state.urgentComplete && operator.waiting > 0;
  const rest = operator.waiting - operator.urgent;

  if (!state.complete || !state.urgentComplete) {
    // A lower bound is stated as one. `+` on the figure and the reason in the
    // caption, rather than an exact-looking number nobody measured.
    return (
      <Kpi
        label="Needs you"
        value={`${operator.urgentMeasuredProjects > 0 ? operator.urgent : 0}+`}
        valueTone="warn"
        seriesUnavailable="Only the current urgent-request count is available here."
        caption={
          operator.projectCount > 0
            ? `urgent · ${operator.measuredProjects} of ${operator.projectCount} projects measured`
            : "urgent · no project has been read yet"
        }
      />
    );
  }

  return (
    <Kpi
      label="Needs you"
      value={formatInt(operator.urgent)}
      valueTone={state.needsAttention ? "warn" : "healthy"}
      seriesUnavailable={exactSplit ? undefined : "Only the current urgent-request count is available here."}
      caption={
        operator.waiting === 0
          ? state.stale
            ? "urgent · the reading is stale"
            : "urgent · nothing is waiting on you"
          : `urgent · ${formatInt(rest)} more waiting`
      }
      explanation={exactSplit ? <>
        <span>{operator.urgent} urgent of the {operator.waiting} waiting on you.</span>
        <span>Gates and P0/P1 asks.</span>
      </> : undefined}
      footer={
        exactSplit ? (
          // WHAT SHARE OF MY INBOX IS URGENT — the one thing "3 urgent · 12
          // waiting" makes the operator work out. Three of twelve and three of
          // four are the same two numbers describing two different mornings.
          <SegmentBar
            className="mt-2"
            ariaLabel={`${operator.urgent} of ${operator.waiting} waiting on you are urgent`}
            data-inbox-urgency=""
            segments={[
              { name: "urgent", value: operator.urgent, fill: "bg-warn" },
              { name: "rest", value: rest, fill: "bg-muted-foreground/30" },
            ]}
          />
        ) : null
      }
    />
  );
}

/** The portfolio's open exceptions as ONE number, split by severity beneath it.
 * The panel below lists the alerts behind the total.
 * Falling is GOOD here, which is what `improvement="down"` tells the strip. */
function OpenAlertsKpi({ items }: { items: AttentionItem[] }) {
  const errors = items.filter((item) => item.severity === "error").length;
  const warnings = items.filter((item) => item.severity === "warn").length;

  if (items.length === 0) {
    return (
      <Kpi
        label="Open alerts"
        value="0"
        valueTone="healthy"
        improvement="down"
        caption="all clear · no open warnings or errors"
        seriesUnavailable="Only the current open-alert count is available here."
      />
    );
  }

  return (
    <Kpi
      label="Open alerts"
      value={formatInt(items.length)}
      improvement="down"
      caption={
        <span className="inline-flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
          {errors > 0 ? (
            <span className="font-medium text-error">
              {errors} {errors === 1 ? "error" : "errors"}
            </span>
          ) : null}
          {errors > 0 && warnings > 0 ? <span aria-hidden>·</span> : null}
          {warnings > 0 ? (
            <span className="font-medium text-warn">
              {warnings} {warnings === 1 ? "warning" : "warnings"}
            </span>
          ) : null}
        </span>
      }
      explanation={<span>{errors} error and {warnings} warning flags are open.</span>}
      footer={
        errors + warnings > 0 ? (
          // HOW MUCH OF THIS COUNT IS RED. Seven open alerts that are six
          // warnings and one error, and seven that are six errors, are the same
          // headline and two different days — and the split is the fact that
          // decides whether the operator opens `/alerts` now or after coffee.
          <SegmentBar
            className="mt-2"
            ariaLabel={`${errors} of ${items.length} open alerts are errors, ${warnings} are warnings`}
            data-alert-split=""
            segments={[
              { name: "error", value: errors, fill: "bg-error" },
              { name: "warn", value: warnings, fill: "bg-warn" },
            ]}
          />
        ) : null
      }
    />
  );
}

/**
 * The OS's own posture as one KPI: how much of the portfolio reported, how many
 * job lanes ran, and whether asset #0 sent its own report.
 *
 * Shared freshness rules keep this summary consistent with System health.
 *
 * THE SHAPE IS A BAR, so the strip has ONE GRAMMAR (2026-09-05, design review
 * on `ro-78qo.6`). It was a `ProgressRing` — the fraction as an arc — which put
 * a third kind of graphic in a four-cell strip whose other two counts are bars,
 * and at 16px a part-filled segmented ring reads as a spinner, which is why the
 * same shape had just left the assets table. The strip is now Net's line, then
 * three compositions: the eye learns one alphabet and reads across.
 *
 * The split shows fresh, stale and assets outside the reporting obligation.
 */
function SystemKpi({ system }: { system: SystemData; nowMs: number }) {
  const severity = coverageSeverity(system.ingest);
  const { fresh, stale, notExpected, expected } = system.ingest;

  return (
    <Kpi
      label="System"
      value={expected > 0 ? formatInt(fresh) : "—"}
      note={expected > 0 ? `/ ${expected} fresh` : "nothing expected to report"}
      seriesUnavailable={expected > 0 ? undefined : "No sites are expected to report."}
      valueTone={severity ?? "default"}
      caption={
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <span className="tabular-nums">
            {formatInt(system.scheduledLanes.length)}{" "}
            {system.scheduledLanes.length === 1 ? "job" : "jobs"}
          </span>
          {/* Only what the OS owes: agents and queue have no producer, so
            * their absence is not a gap (bead `ro-trai.1`), and an
            * installation with no OS row owes no report (`ro-ujb9.161`). */}
          {osReportMissing(system) ? (
            <span className="font-medium text-error">no System report</span>
          ) : null}
        </span>
      }
      explanation={expected > 0 ? <span>{fresh} fresh · {stale} stale{
        notExpected > 0 ? ` · ${notExpected} not expected to report` : ""
      }</span> : undefined}
      footer={
        expected > 0 ? (
          // Unconfigured reporters remain outside the expected denominator.
          <SegmentBar
            className="mt-2"
            // The one place this sentence is READ OUT, so it is written as a
            // sentence: "1 are stale" is what a template with a hard-coded verb
            // gives you on the day exactly one asset goes quiet.
            ariaLabel={`${fresh} of ${siteCount(expected)} owing a report sent a fresh one; ${stale} ${
              stale === 1 ? "is" : "are"
            } stale`}
            data-coverage-split=""
            segments={[
              { name: "fresh", value: fresh, fill: "bg-healthy" },
              { name: "stale", value: stale, fill: "bg-warn" },
              {
                name: "not-expected",
                value: notExpected,
                fill: "bg-muted-foreground/30",
              },
            ]}
          />
        ) : null
      }
    />
  );
}

/** How many rows each panel shows before its own expander. Doc 21's Home
 * template says five: this is the portfolio's queue rather than one asset's, so
 * three rows would be one row per two assets. */
const PANEL_ROWS = 5;

/** One waiting bead with the project it belongs to attached. The board renders
 * these per project; Home has to flatten them, so the name travels with the row
 * or a gate on one asset is indistinguishable from a gate on another. */
interface WaitingRow {
  item: WorkItem;
  project: string;
}

/** Epoch ms of a bead's last activity; unknown sorts LAST, because "we have no
 * timestamp" is not the same claim as "this has waited longest". */
function updatedMs(item: WorkItem): number {
  const parsed = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Gate first, then priority, then oldest.
 *
 * A gate is not merely an ask: it is HOLDING a bead out of `bd ready` until the
 * operator resolves it, so it blocks work that is otherwise claimable and leads
 * regardless of its own priority. After that it is `bd`'s own ranking, and age
 * breaks the tie — the thing that has waited longest is the thing most likely to
 * have been forgotten.
 */
function byWaitingUrgency(a: WaitingRow, b: WaitingRow): number {
  const gate =
    Number(b.item.issueType === "gate") - Number(a.item.issueType === "gate");
  if (gate !== 0) return gate;
  if (a.item.priority !== b.item.priority) {
    return a.item.priority - b.item.priority;
  }
  return updatedMs(a.item) - updatedMs(b.item);
}

/** The core task board reading for Home's Waiting on you panel. */
function LiveWaitingPanel({ nowMs }: { nowMs: number }) {
  const work = useWork();
  return <WaitingPanel work={work.data} failed={work.isError} nowMs={nowMs} />;
}

/**
 * WAITING ON YOU — every project's operator inbox, flattened.
 *
 * `/tasks` shows this per project, which answers "what is this repo waiting
 * for". Home asks the other question: across the whole portfolio, what is the OS
 * unable to move without me. Same payload field (`WorkProject.waiting`), same
 * warn register — the operator being the blocker is a call for attention, not a
 * failure.
 *
 * The three empty states are three different facts and never share a sentence:
 * the poll has not answered yet, no snapshot has ever been filed, or the inbox
 * is genuinely clear. Only the third one is good news.
 */
function WaitingPanel({
  work,
  failed,
  nowMs,
}: {
  work: WorkPayload | undefined;
  failed: boolean;
  nowMs: number;
}) {
  const location = useLocation();
  const projects = work?.projects ?? [];
  const rows: WaitingRow[] = projects.filter((project) => project.ok).flatMap((project) =>
    project.waiting.map((item) => ({ item, project: project.name })),
  );
  const ordered = [...rows].sort(byWaitingUrgency);
  // Rows are capped per project. Only measured counts describe the full queue.
  const measured = projects.filter((project) => project.ok && project.counts.waiting !== null);
  const complete = projects.length > 0 && measured.length === projects.length;
  const total = measured.reduce((sum, project) => sum + project.counts.waiting!, 0);
  const hasSnapshot = work !== undefined && work.capturedAt !== null;
  const stale =
    hasSnapshot &&
    isAmber(nowMs, work.capturedAt, WORK_POLL_CADENCE_HOURS);
  const count = complete
    ? `${formatInt(total)} waiting`
    : total > 0
      ? `${formatInt(total)}+ waiting · partial read`
      : "Waiting count unknown · incomplete read";

  // ONE STATUS PER SUBJECT (bead `ro-ujb9.96.6.12`): the header line above
  // already says partial, stale or failed, and "All tasks" sits beside it — the
  // empty row says only what the LIST holds, never the queue's state again.
  const empty =
    failed && !hasSnapshot
      ? "Could not refresh your tasks. The current waiting queue is unknown."
      : work === undefined
        ? "Reading your tasks…"
        : !hasSnapshot
          ? "No tasks have been read yet."
          : !complete || stale || failed
            ? "Current waiting queue unknown."
            : total > 0
              ? "No request details captured."
              : "Nothing is waiting on you.";

  return (
    <ListPanel
      title="Waiting on you"
      count={
        hasSnapshot ? (
          <span className="grid gap-1">
            <span>{count}{stale ? " · stale snapshot" : ""}{failed ? " · refresh failed" : ""}
              {ordered.length > 0 && (ordered.length < total || !complete) ? ` · ${ordered.length} captured in preview` : ""}
            </span>
            <span>Task status read {formatAge(ageMs(nowMs, work.capturedAt))} ago</span>
          </span>
        ) : undefined
      }
      action={{ label: "All tasks", to: "/tasks" }}
      limit={PANEL_ROWS}
      empty={empty}
    >
      {ordered.map(({ item, project }) => (
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
              {project} · <code className="font-mono">{item.id}</code>
              {/* Doc 17: "gate" is the task hub's word, not the operator's.
                  What it MEANS is the part worth reading — this one is holding
                  work out of the ready queue until it is answered. */}
              {item.issueType === "gate" ? " · needs your approval" : null}
            </>
          }
          value={formatAge(ageMs(nowMs, item.updatedAt))}
          valueLabel="updated"
        />
      ))}
    </ListPanel>
  );
}

/**
 * ALERTS — the portfolio's open exceptions, newest first, in payload order.
 *
 * Payload order, never re-sorted: the read model already ranks these, and a
 * second ordering on Home would disagree with the page it links to.
 *
 * Deliberately not `/alerts`' table: no Mark read, no Resolve. Disposition is a
 * decision, and a decision made from a five-row preview is a decision made
 * without the history beside it. What the row DOES do is open in place — the
 * rule's own words, verbatim from the store, and the way through to the asset —
 * which is doc 21's "a row expands in place to show evidence and its actions".
 */
function AlertsPanel({ items, nowMs }: { items: AttentionItem[]; nowMs: number }) {
  const openSite = useSitePath();
  return (
    <ListPanel
      title="Alerts"
      count={items.length > 0 ? `${items.length} open` : undefined}
      action={{ label: "All alerts", to: "/alerts" }}
      limit={PANEL_ROWS}
      empty="No open warnings or errors."
    >
      {items.map((item) => {
        const alert = translateAlert(item);
        const grouped = isGrouped(item);
        return (
          <ListRow
            key={item.id}
            tone={item.severity}
            // Doc 21's mark for a finding: the ring says how bad, the triangle
            // says what kind, so an alert never reads as an unfinished task.
            glyph="△"
            title={alert.headline}
            caption={
              <>
                {/* A cross-asset row (`ro-kukv.6`) has no single asset to name:
                    its headline carries the count and the caption carries the
                    assets it stands for. */}
                {grouped ? memberNames(item) : item.assetDisplayName}
                {/* `occurrences` counts ASSETS on a grouped row, so the phrase
                    that means re-firings stays away from it. */}
                {!grouped && item.occurrences > 1
                  ? ` · recurred ${item.occurrences}× in ${formatAge(ageMs(nowMs, item.firstFiredAt))}`
                  : null}
              </>
            }
            // Aged from the FIRST firing, and labelled so — the sentence that
            // said this lived in an About at the foot of the page.
            value={formatAge(ageMs(nowMs, item.firstFiredAt))}
            valueLabel="first seen"
            actions={
              grouped ? (
                <Button asChild size="sm" variant="outline">
                  <Link to="/alerts">Open in Alerts</Link>
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link to={openSite(item.asset)}>Open {item.assetDisplayName}</Link>
                </Button>
              )
            }
          >
            {/* WHAT NOW, when the rule has something specific to say, then the
                rule's own words — the audit trail the headline above is a
                reading of. A rule the translator does not know has its message
                AS its headline, and printing it twice would be the duplication
                doc 14 exists to stop. */}
            {alert.hint ? <span>{alert.hint}</span> : null}
            {alert.headline === item.message ? null : <span>{item.message}</span>}
          </ListRow>
        );
      })}
    </ListPanel>
  );
}

/**
 * ASSETS — one row per asset, in the payload's fixed seed order.
 *
 * NEVER SORTED. The order is the seed order the read model preserves, on every
 * surface, so spatial memory holds: the operator learns where each site is and it
 * stays there whether or not it had a good week. A table that reordered itself
 * by today's traffic would make the same portfolio look different every morning.
 *
 * Each column is one fact the asset page states in full, so the row is a scan
 * line rather than a summary: identity, state, today, the shape of the last
 * month, the week, the month's money, open work, and whether the nightly report
 * arrived. Every cell that has no answer says so — an em dash, "not booked",
 * "No work data" — and never a zero, which would claim something was measured.
 */
function AssetsPanel({
  assets,
  nowMs,
  ga4Realtime,
  className,
}: {
  assets: AssetCard[];
  nowMs: number;
  ga4Realtime: Ga4RealtimePayload | undefined;
  className?: string;
}) {
  return (
    <section
      className={cn("flex flex-col rounded-[10px] border border-border bg-card", className)}
      aria-label="Sites"
    >
      {/* The vocabulary's eyebrow rather than this file's own copy of it
          (bead `ro-78qo.27`) — same 11px tracked title, same one-line caption,
          same claimed 44px target on the link. */}
      <SectionLabel
        title="Sites"
        // "All sites" over a list of one is a promise of more (ro-ujb9.130).
        action={assets.length > 1 ? { to: "/assets", label: "All sites →" } : undefined}
        className="px-4 pb-2 pt-3"
      />

      <div className="px-1 pb-1">
        {/* HOME NEVER SORTS AND HOME HAS NO RANGE (bead `ro-78qo.7`). It hands
            the table the payload's own order and no `onSort`, so the header row
            renders as headers rather than as nine controls: the ordering
            question belongs to `/assets`, which is the page that exists to
            compare. The table itself is the same one, in one file. */}
        <AssetsTable assets={assets} nowMs={nowMs} ga4Realtime={ga4Realtime} />
      </div>
    </section>
  );
}

export default HomeRoute;
