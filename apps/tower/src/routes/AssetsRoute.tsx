import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ASSET_STATUS_LABEL, assetStatusLabel } from "@shared/asset-detail";
import { ageMs, formatAge } from "@shared/freshness";
import { siteNoun } from "@shared/site-noun";
import { sitePath } from "@shared/first-run";
import {
  DEFAULT_RANGE_DAYS,
  SURFACE_RANGES,
} from "@shared/surface";
import type { AssetCard as AssetData } from "@shared/wall";
import { AddSiteButton } from "@/components/AddSite";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
import { STATE_TONE, type StateTone } from "@/components/StateChip";
import { FilterControls, FilterFold, FilterToggle } from "@/components/surface/FilterBar";
import { RangeSelector } from "@/components/surface/RangeSelector";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { useSiteIssues } from "@/hooks/useSiteIssues";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { monthFigure, visitorsFigure } from "@/lib/home-brief";
import { SITE_HEALTH, siteHealth, type SiteHealthKey } from "@/lib/site-health";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AssetsTable,
  bookingState,
  usersDelta,
  type AssetSortKey,
} from "@/routes/assets/AssetsTable";

type HealthFilter = "all" | SiteHealthKey;

/** Worst first: what "Needs you first" orders by, and the order the health
 * chips are offered in. */
const HEALTH_RANK: Record<SiteHealthKey, number> = {
  "off-track": 4,
  "at-risk": 3,
  "setting-up": 2,
  "monitor-only": 1,
  "on-track": 0,
};
const HEALTH_KEYS = (Object.keys(HEALTH_RANK) as SiteHealthKey[]).sort((a, b) => HEALTH_RANK[b] - HEALTH_RANK[a]);

/**
 * `summary` is how the line above the table names the ordering; `null` on the
 * default, which the summary says nothing about because it is not a choice.
 *
 * THE SELECT AND THE HEADER ROW ARE ONE CONTROL (bead `ro-78qo.7`). The table's
 * header cells sort on a press, which is what a comparison table owes a pointer;
 * below `sm` that header row is hidden entirely (`Table stacked`), so this
 * `<select>` is the phone's only way to reorder — and both write the same
 * `?sort=`, so the two can never disagree about what the table is showing.
 */
const SORTS: { value: AssetSortKey; label: string; summary: string | null }[] = [
  { value: "seed", label: "Default order", summary: null },
  { value: "name", label: "Name (A–Z)", summary: "name" },
  { value: "health", label: "Needs you first", summary: "health" },
  { value: "work", label: "Most urgent work", summary: "urgent work" },
  { value: "users", label: "Most visitors", summary: "visitors" },
  // The move column follows the range, so the words that name it cannot be
  // fixed at seven days any more (bead `ro-78qo.35`).
  { value: "trend", label: "Best move over the range", summary: "the move over the range" },
  { value: "net", label: "Most net", summary: "net" },
];

/**
 * A fact the payload does not carry, sunk to the bottom of a descending sort.
 *
 * Finite on purpose: `-Infinity - -Infinity` is `NaN`, which makes a comparator
 * inconsistent and hands the operator an arbitrary order. Every real count here
 * is ≥ 0, so −1 sorts below all of them and subtracts from itself cleanly.
 *
 * It is also NOT a zero. "No beads snapshot for this asset" and "no urgent work"
 * are different claims, and a sort that ranked them together would put an
 * unmeasured asset among the calm ones.
 */
const UNKNOWN = -1;

function urgentWork(card: AssetData): number {
  return card.work?.highPriority ?? UNKNOWN;
}

function openWork(card: AssetData): number {
  return card.work?.open ?? UNKNOWN;
}

function latestDailyUsers(card: AssetData): number {
  return card.activeUsers.series.at(-1)?.v ?? UNKNOWN;
}

/**
 * The net this row STATES, or null when it states none.
 *
 * A sentinel would not do here and does everywhere else on this page: net is
 * signed, so any number chosen to mean "unmeasured" is a number some asset could
 * really have. Null travels instead and `unknownLast` puts it at the bottom,
 * which keeps "nothing booked" out of the run of losses it would otherwise join.
 */
function netOf(card: AssetData): number | null {
  const state = bookingState(card);
  if (state === null) return null;
  return state === "booked" ? card.booked.net : card.forecast.net;
}

/** Descending, with an unmeasured row last whichever way the numbers run. */
function unknownLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Every non-default ordering, each worst-first so the top of the table is the
 * asset the operator most likely came for. `Array.prototype.sort` is stable, so
 * ties fall back to the payload's seed order rather than to chance.
 *
 * IT TAKES THE RANGE, because one of them depends on it: the move column is the
 * range's own `periodDelta` since bead `ro-78qo.35`, and a table ordered by one
 * derivation while its column prints another is a table that disagrees with
 * itself (doc 14). At ninety days that comparison is null on every row — the
 * payload holds ninety days and cannot reach back a second ninety — so the
 * ordering falls to seed order there, which is what `unknownLast` already does
 * for a row nobody can rank.
 */
function comparatorFor(
  sort: Exclude<AssetSortKey, "seed">,
  rangeDays: number,
  healthOf: (card: AssetData) => SiteHealthKey,
): (a: AssetData, b: AssetData) => number {
  switch (sort) {
    case "name":
      return (a, b) => a.displayName.localeCompare(b.displayName);
    case "health":
      return (a, b) => HEALTH_RANK[healthOf(b)] - HEALTH_RANK[healthOf(a)] || b.openError - a.openError || b.openWarn - a.openWarn;
    case "work":
      return (a, b) => urgentWork(b) - urgentWork(a) || openWork(b) - openWork(a);
    case "users":
      return (a, b) => latestDailyUsers(b) - latestDailyUsers(a);
    case "trend":
      return (a, b) =>
        unknownLast(
          usersDelta(a, rangeDays)?.percent ?? null,
          usersDelta(b, rangeDays)?.percent ?? null,
        );
    case "net":
      return (a, b) => {
        const currency = (card: AssetData) => bookingState(card) === 'booked' ? card.booked.currency : card.forecast.currency;
        const left = currency(a), right = currency(b);
        return left === right ? unknownLast(netOf(a), netOf(b))
          : (left ?? '~').localeCompare(right ?? '~');
      };
  }
}

/** Portfolio summaries are independent of the table's filters. Only traffic
 * follows the selected day range; latest status and monthly money do not.
 * Filters, ordering and traffic range remain shareable URL state. */
export function AssetsRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  // Tasks is a core capability even when its latest reading is unavailable.
  const realtime = useGa4Realtime();
  const now = useNow();
  const [params, setParams] = useSearchParams();

  const status = params.get("status") ?? "all";
  const health = readKey<HealthFilter>(params.get("health"), ["all", ...HEALTH_KEYS]);
  const sort = readKey<AssetSortKey>(
    params.get("sort"),
    SORTS.map((option) => option.value),
  );
  const range = readRange(params.get("range"));

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    // The default never occupies the query string, so a cleared page is `/assets`
    // and two operators who narrowed to the same view produce the same link.
    if (
      value === "all" ||
      (name === "sort" && value === "seed") ||
      (name === "range" && value === String(DEFAULT_RANGE_DAYS))
    ) {
      next.delete(name);
    }
    else next.set(name, value);
    // `replace`: a filter is a view of one page, not a place — the back button
    // should leave Assets, not walk backwards through every control touched.
    setParams(next, { replace: true });
  }

  const assets = data?.assets ?? [];
  // Each site's one health word (D44), from the same open problems Home and
  // the site's own header read.
  const issues = useSiteIssues();
  const healthById = new Map(assets.map((card) => [card.id, siteHealth(card, issues)]));
  const healthOf = (card: AssetData): SiteHealthKey => healthById.get(card.id)?.key ?? "on-track";
  const matches = assets.filter(
    (card) =>
      (status === "all" || card.status === status) &&
      (health === "all" || healthOf(card) === health),
  );
  const visible =
    sort === "seed" ? matches : [...matches].sort(comparatorFor(sort, range, healthOf));

  const activeFilterCount = [status, health].filter((value) => value !== "all").length;
  const narrowed = activeFilterCount > 0;
  const ordered = sort !== "seed";

  /**
   * Counts are over the WHOLE portfolio, not over what the other controls have
   * already narrowed. "How many assets are live" is a fact about the portfolio
   * and stays true whatever else is picked; a count that moved every time
   * another control did would be a fourth number on a page whose summary line
   * already reconciles the arithmetic.
   */
  const statusCounts = new Map<string, number>();
  for (const card of assets) {
    statusCounts.set(card.status, (statusCounts.get(card.status) ?? 0) + 1);
  }
  // The five canonical stages always appear, in lifecycle order, even at zero:
  // the vocabulary is the asset lifecycle, not whatever this store happens to
  // hold today. A status a migration added and the Tower has never seen is
  // appended rather than dropped, the same stance `assetStatusLabel` takes —
  // including one that arrives only in the URL, so a link can never leave the
  // control showing nothing at all.
  const statusOptions = [
    ...Object.keys(ASSET_STATUS_LABEL),
    ...[
      ...new Set([
        ...statusCounts.keys(),
        ...(status === "all" ? [] : [status]),
      ]),
    ]
      .filter((value) => !(value in ASSET_STATUS_LABEL))
      .sort(),
  ];

  const healthCounts = new Map<SiteHealthKey, number>();
  for (const card of assets) healthCounts.set(healthOf(card), (healthCounts.get(healthOf(card)) ?? 0) + 1);
  const answer = sitesAnswer(assets, healthOf);
  const figures = data ? [monthFigure(data.portfolio, assets), visitorsFigure(assets)].filter((figure) => figure !== null) : [];

  const filterSummary: string[] = [];
  if (status !== "all") {
    filterSummary.push(`status: ${assetStatusLabel(status).toLowerCase()}`);
  }
  if (health !== "all") {
    filterSummary.push(`health: ${healthWord(health).toLowerCase()}`);
  }
  const noun = siteNoun(assets.length);
  const sortSummary = SORTS.find((option) => option.value === sort)?.summary;
  const summary = [
    narrowed
      ? `${visible.length} of ${assets.length} ${noun}`
      : `${assets.length} ${noun}`,
    ...filterSummary,
    ...(sortSummary ? [`sorted by ${sortSummary}`] : []),
  ].join(" · ");

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3.5 p-4 md:p-6">
      <PageHeader
        title="Sites"
        actions={
          // Opens Add a site over this page (bead `ro-ujb9.96.7.5`): adding a
          // site is one question, not a page of its own.
          <AddSiteButton>
            <Plus aria-hidden /> Add a site
          </AddSiteButton>
        }
        meta={
          data && assets.length > 0 ? (
            <span className="text-xs text-muted-foreground" data-assets-age>
              updated {formatAge(ageMs(now, data.generatedAt))} ago
            </span>
          ) : undefined
        }
      />

      {/* THE MACHINERY ARRIVES WITH SOMETHING TO COMPARE (bead
          `ro-ujb9.128`). Filters, a sort, a range and a strip adding the
          sites up are how two or more sites are compared; over none they are
          twelve controls round an empty state, and over one they filter a
          single row. So no sites is the header's Add a site and one empty
          state, and one site is its row. */}
      {!data ? (
        isError ? (
          <ReadFailed title="Couldn't load your sites" subject="read:sites" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">Loading…</div>
        )
      ) : assets.length === 0 ? (
        <section data-surface-hero data-assets-empty className="rounded-[10px] border border-border bg-card px-4 py-3">
          <EmptyState title="No sites yet" />
        </section>
      ) : assets.length === 1 ? (
        <section data-surface-hero className="rounded-[10px] border border-border bg-card p-1">
          <AssetsTable assets={assets} nowMs={now} ga4Realtime={realtime.data} />
        </section>
      ) : (
        <>
        {/* ONE ANSWER FIRST (D44 bar, D45): which sites need you, by the
            same health word Home and each site's page say, with the month's
            pace and yesterday's visitors beside it — the same derivations as
            Home, so September is one number everywhere. */}
        <PageAnswer
          answer={answer.line}
          detail={answer.detail}
          figures={figures}
          marks={{ "data-surface-hero": "", "data-sites-answer": answer.key }}
        />
        <FilterFold active={activeFilterCount} label="Filters & sort">
          {/* The fold's one press shares the range's row on a phone: the
              period stays in view (it changes what every number means), the
              filters and the sort wait behind the button (doc 21's phone first
              screen, bead `ro-ujb9.13`). */}
          <div className="flex flex-wrap items-end justify-between gap-2" data-assets-traffic-controls>
            <FilterToggle />
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <span className="text-xs font-medium text-muted-foreground max-sm:sr-only">Traffic period</span>
              <RangeSelector value={range} label="Traffic period" onChange={(days) => setFilter("range", String(days))} />
            </div>
          </div>
          <FilterControls
            className="flex flex-wrap items-center gap-x-4 gap-y-2"
            marks={{ "data-assets-filters": "" }}
          >
            <label className="sr-only" htmlFor="assets-status">
              Status
            </label>
            <select
              id="assets-status"
              className={fieldClass}
              value={status}
              onChange={(event) => setFilter("status", event.target.value)}
            >
              <option value="all">All stages · {assets.length}</option>
              {statusOptions.map((value) => (
                <option key={value} value={value}>
                  {assetStatusLabel(value)} · {statusCounts.get(value) ?? 0}
                </option>
              ))}
            </select>

            <FilterChips
              legend="Health"
              name="health"
              value={health}
              onPick={setFilter}
              options={[
                { value: "all", label: "All", count: assets.length },
                ...HEALTH_KEYS.filter((key) => (healthCounts.get(key) ?? 0) > 0 || key === health).map((key) => ({
                  value: key,
                  label: healthWord(key),
                  count: healthCounts.get(key) ?? 0,
                  glyph: <ToneDot tone={healthTone(key)} />,
                })),
              ]}
            />

            <label className="sr-only" htmlFor="assets-sort">
              Sort
            </label>
            <select
              id="assets-sort"
              className={cn(fieldClass, "ml-auto")}
              value={sort}
              onChange={(event) => setFilter("sort", event.target.value)}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FilterControls>

          <p
            className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground"
            data-assets-summary
          >
            <span>{summary}</span>
            {narrowed || ordered ? (
              <Link
                to={{ search: range === DEFAULT_RANGE_DAYS ? "" : `?range=${range}` }}
                replace
                className="font-medium text-foreground underline-offset-4 outline-none hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear
              </Link>
            ) : null}
          </p>

          <section className="rounded-[10px] border border-border bg-card p-1">
            <AssetsTable
              assets={visible}
              nowMs={now}
              ga4Realtime={realtime.data}
              rangeDays={range}
              sort={sort}
              onSort={(key) => setFilter("sort", key)}
              empty={
                // Not "No sites yet": there are sites, and a control hides
                // them. The line just above names those controls and holds
                // Clear, the way back — so this says only that nothing
                // matches, not a second copy of the filters with directions.
                <EmptyState title="No sites match these filters" />
              }
            />
          </section>
        </FilterFold>
        </>
      )}
    </div>
  );
}

/**
 * ALL THREE WINDOWS, at last (bead `ro-78qo.35`).
 *
 * This page shipped offering 7 and 28 only, because the wall payload carried 28
 * days of each asset's daily series and a 90d button would have drawn 28 days of
 * line under a label claiming three months. The payload reaches back ninety now
 * — `contextSeries` is 62 days beside a 28-day `series` — so the selector is
 * doc 21's own `SURFACE_RANGES` and nothing here narrows it.
 */
function readRange(value: string | null): number {
  const days = Number(value);
  return (SURFACE_RANGES as readonly number[]).includes(days)
    ? days
    : DEFAULT_RANGE_DAYS;
}

/**
 * THE PORTFOLIO'S DAILY ACTIVE USERS: every asset's own series, summed by day.
 *
 * By DATE rather than by position, because the assets do not report in step — a
 * provider that missed Tuesday for one asset must not shift that asset's
 * Wednesday onto the portfolio's Tuesday. A day nobody reported is absent
 * entirely rather than zero, which is the same rule every series on this desk
 * keeps.
 */
/** The page's answer: how many sites need the operator, by the one health
 * word, and which ones. */
function sitesAnswer(assets: AssetData[], healthOf: (card: AssetData) => SiteHealthKey): { key: string; line: string; detail: ReactNode } {
  const noun = siteNoun(assets.length);
  const worst = [...assets].sort((a, b) => HEALTH_RANK[healthOf(b)] - HEALTH_RANK[healthOf(a)]);
  const offTrack = worst.filter((card) => healthOf(card) === "off-track");
  const atRisk = worst.filter((card) => healthOf(card) === "at-risk");
  const settingUp = worst.filter((card) => healthOf(card) === "setting-up");
  const needs = [...offTrack, ...atRisk];
  if (needs.length > 0) {
    const word = atRisk.length === 0 ? "off track" : offTrack.length === 0 ? "at risk" : "need you";
    // Each named site is its own way in: the answer's one action.
    return {
      key: "needs-you",
      line: `${formatInt(needs.length)} of ${formatInt(assets.length)} ${noun} ${word}`,
      detail: (
        <span className="inline-flex flex-wrap gap-x-1">
          {needs.slice(0, 3).map((card, index) => (
            <span key={card.id}>
              {index > 0 ? "· " : null}
              <Link to={sitePath(card)} className="font-medium text-foreground underline-offset-4 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center" data-sites-answer-site={card.id}>
                {card.displayName}
              </Link>
            </span>
          ))}
          {needs.length > 3 ? <span>· {formatInt(needs.length - 3)} more</span> : null}
        </span>
      ),
    };
  }
  const fine = assets.length - settingUp.length;
  if (settingUp.length === 0) return { key: "on-track", line: `All ${formatInt(assets.length)} ${noun} on track`, detail: undefined };
  return {
    key: "setting-up",
    line: fine === 0 ? `${formatInt(assets.length)} ${noun} setting up` : `${formatInt(fine)} of ${formatInt(assets.length)} ${noun} on track`,
    detail: fine === 0 ? undefined : `${formatInt(settingUp.length)} setting up`,
  };
}

function healthWord(key: SiteHealthKey): string {
  return SITE_HEALTH[key].word;
}

function healthTone(key: SiteHealthKey): StateTone {
  return SITE_HEALTH[key].tone;
}

function readKey<K extends string>(
  value: string | null,
  allowed: readonly K[],
): K {
  return allowed.includes(value as K) ? (value as K) : (allowed[0] as K);
}

/** The dot a `StateChip` draws, on its own — the sanctioned way for a control to
 * carry a state's meaning color without a rival mapping (see `STATE_TONE`).
 * `aria-hidden` because the chip's own words already say which state it is. */
function ToneDot({ tone }: { tone: StateTone }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATE_TONE[tone].dot)}
    />
  );
}

interface FilterChipOption {
  value: string;
  label: string;
  count: number;
  /** The registry glyph for this state. Absent on the "All" option, which is
   * the absence of a state rather than one more of them. */
  glyph?: ReactNode;
}

/**
 * One three-way filter, as chips carrying their glyph and their count.
 *
 * Route layout over a payload slice, not a registry component (doc 14's rule for
 * `AssetDetailRoute`'s strips): it exists to put the assets index's own counts
 * on screen, and a second surface wanting this would earn it an entry then. It
 * is not a rival to `KnobEditor`'s segmented control either — that one STAGES a
 * changeset op into the cart, this one narrows a view.
 */
function FilterChips({
  legend,
  name,
  value,
  options,
  onPick,
}: {
  legend: string;
  name: string;
  value: string;
  options: FilterChipOption[];
  onPick: (name: string, value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={legend}
      className="inline-flex flex-wrap items-center gap-1"
      data-assets-filter={name}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(name, option.value)}
            /* The choice dialect of `ui/pill.ts` (bead `ro-s4rg`) — the same
               box and the same pair as /work's filter row and the asset
               wizard's choices, which is what it was a third copy of. The
               phone thumb floor arrives with it. */
            className={cn(pillChoiceClass, pillChoiceStateClass(active))}
          >
            {/* Hidden from the accessible name: the words beside it already
                say which state this is, and a dot's own label ("Warning") read
                out in front of them would name the state twice. */}
            {option.glyph ? (
              <span aria-hidden className="inline-flex">
                {option.glyph}
              </span>
            ) : null}
            <span>
              {option.label}{" "}
              <span className="tabular-nums">{option.count}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default AssetsRoute;
