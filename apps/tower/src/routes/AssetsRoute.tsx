import { ArrowDownUp, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ASSET_STATUS_LABEL, assetStatusLabel } from "@shared/asset-detail";
import { ageMs, formatAge } from "@shared/freshness";
import { siteNoun } from "@shared/site-noun";
import { siteDisplayOf, sitesShownOn } from "@shared/site-display";
import { sitePath } from "@shared/first-run";
import { AddSiteButton } from "@/components/AddSite";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
import { LiveSiteArrange } from "@/components/SiteArrange";
import { ASSETS_ROUTE, SITES_ARRANGE_PARAM } from "@/components/nav-items";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "@/components/Skeleton";
import { FilterControls, FilterFold, FilterToggle } from "@/components/surface/FilterBar";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { useConnections } from "@/hooks/useConnections";
import { useNow } from "@/hooks/useNow";
import { useSiteIssues } from "@/hooks/useSiteIssues";
import { useWall } from "@/hooks/useWall";
import { formatInt } from "@/lib/format";
import { monthFigure } from "@/lib/home-brief";
import { SITE_HEALTH, type SiteHealthKey } from "@/lib/site-health";
import {
  HEALTH_KEYS,
  healthSplit,
  orderSites,
  siteLines,
  visitorsAnswerFigure,
  watchedLines,
  type SiteLine,
  type SitesOrder,
} from "@/lib/sites-index";
import { cn } from "@/lib/utils";
import { AssetsTable } from "@/routes/assets/AssetsTable";
import { HealthSplit } from "@/routes/assets/HealthSplit";

type HealthFilter = "all" | SiteHealthKey;

/** The orderings, each one press; the first is the default. */
const ORDERS: { value: SitesOrder; label: string }[] = [
  { value: "seed", label: "Your order" },
  { value: "health", label: "Needs attention" },
  { value: "money", label: "Money" },
  { value: "users", label: "People" },
  { value: "name", label: "A–Z" },
];

/** The answer, the health split and the stage counts are facts about every
 * listed site; the comparison under them is what the controls narrow and
 * order. A site whose Home and Sites list switch is off is counted as hidden
 * and listed nowhere here. Every control is shareable URL state. */
export function AssetsRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const now = useNow();
  const connections = useConnections();
  // Each site's one health word, from the same open problems Home and the
  // site's own header read.
  const issues = useSiteIssues();
  const [params, setParams] = useSearchParams();

  const status = params.get("status") ?? "all";
  const health = readKey<HealthFilter>(params.get("health"), ["all", ...HEALTH_KEYS]);
  const sort = readKey<SitesOrder>(params.get("sort"), ORDERS.map((option) => option.value));

  const arranging = params.get(SITES_ARRANGE_PARAM) === "1";

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    // A default never occupies the query string: one view, one link.
    if (value === "all" || (name === "sort" && value === "seed")) next.delete(name);
    else next.set(name, value);
    // `replace`: Back should leave Sites, not walk every control touched.
    setParams(next, { replace: true });
  }

  /** Arrange is a view of this page, kept in the address like the order and
   * the stage, so Done returns to the list exactly as it was narrowed. */
  function arrangeHref(open: boolean): string {
    const next = new URLSearchParams(params);
    if (open) next.set(SITES_ARRANGE_PARAM, "1");
    else next.delete(SITES_ARRANGE_PARAM);
    const search = next.toString();
    return search === "" ? ASSETS_ROUTE : `${ASSETS_ROUTE}?${search}`;
  }

  // The page lists the sites whose Home and Sites list switch is on; the
  // money and visitors figures stay the whole portfolio's.
  const all = data?.assets ?? [];
  const assets = sitesShownOn(all, siteDisplayOf(data), "list");
  const hidden = all.length - assets.length;
  const lines = data ? siteLines(assets, data.portfolio, issues, connections, now) : [];
  const matches = lines.filter(
    (line) => (status === "all" || line.card.status === status) && (health === "all" || line.health.key === health),
  );
  const visible = orderSites(matches, sort);
  const narrowed = status !== "all" || health !== "all";

  /** Counts are over every listed site, not over what the other control has
   * already narrowed: "how many sites are live" is a fact about the list. */
  const statusCounts = new Map<string, number>();
  for (const card of assets) statusCounts.set(card.status, (statusCounts.get(card.status) ?? 0) + 1);
  // Current derived stages and explicit lifecycle decisions appear even at zero.
  // An unknown status (from the store or only the URL) is appended rather than
  // dropped, as `assetStatusLabel` does, so the control never shows nothing.
  const statusOptions = [
    ...Object.keys(ASSET_STATUS_LABEL).filter((stage) => stage !== "baselining"),
    ...[...new Set([...statusCounts.keys(), ...(status === "all" ? [] : [status])])]
      .filter((value) => !(value in ASSET_STATUS_LABEL))
      .sort(),
  ];

  const split = healthSplit(lines);
  // A word picked from the URL that no site wears still shows, at zero, so
  // the press that clears it is on the screen.
  const parts = health !== "all" && !split.some((part) => part.key === health)
    ? [...split, { key: health, word: SITE_HEALTH[health].word, count: 0 }]
    : split;
  const answer = sitesAnswer(lines);
  const figures = data ? [monthFigure(data.portfolio, all), visitorsAnswerFigure(all)].filter((figure) => figure !== null) : [];

  const narrowing = [
    narrowed
      ? `${formatInt(visible.length)} of ${formatInt(assets.length)} ${siteNoun(assets.length)}`
      : `${formatInt(assets.length)} ${siteNoun(assets.length)}`,
    ...(status !== "all" ? [`stage: ${assetStatusLabel(status).toLowerCase()}`] : []),
    ...(health !== "all" ? [`health: ${SITE_HEALTH[health].word.toLowerCase()}`] : []),
  ].join(" · ");

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 md:p-6">
      <PageHeader
        title="Portfolio"
        actions={
          // Opens Add a site over this page: adding a site is one question,
          // not a page of its own.
          <AddSiteButton>
            <Plus aria-hidden /> Add an asset
          </AddSiteButton>
        }
        meta={
          data && all.length > 0 ? (
            <span className="text-xs text-muted-foreground" data-assets-age>
              updated {formatAge(ageMs(now, data.generatedAt))} ago
            </span>
          ) : undefined
        }
      />

      {/* The machinery arrives with something to compare: over no sites the
          answer, split and controls would surround an empty state, and over
          one they would sort a single row. So no sites is the header's Add a
          site and one empty state, and one site is its row. */}
      {!data ? (
        isError ? (
          <ReadFailed title="Couldn't load your assets" subject="read:sites" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <PageSkeleton subject="read:sites" shape="list" />
        )
      ) : all.length === 0 ? (
        <section data-surface-hero data-assets-empty className="rounded-[10px] border border-border bg-card px-4 py-3">
          <EmptyState title="No assets yet" />
        </section>
      ) : arranging ? (
        <section aria-labelledby="assets-arrange-heading" data-surface-hero data-assets-arrange className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="assets-arrange-heading" className="m-0 text-base font-semibold text-foreground">Arrange</h2>
            <Button asChild size="sm">
              <Link to={arrangeHref(false)} replace data-assets-arrange-done>
                Done
              </Link>
            </Button>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            Drag an asset by its grip or move it with its arrows. Home, this page and the TV use this order.
          </p>
          <LiveSiteArrange />
        </section>
      ) : assets.length === 0 ? (
        <section data-surface-hero data-assets-all-hidden className="rounded-[10px] border border-border bg-card px-4 py-3">
          <EmptyState title="Every asset is hidden" hint={<HiddenSites count={hidden} to={arrangeHref(true)} />} />
        </section>
      ) : assets.length === 1 ? (
        <div data-surface-hero className="flex flex-col gap-3">
          <AssetsTable lines={lines} />
          {hidden > 0 ? (
            <p className="m-0 text-sm text-muted-foreground" data-assets-summary>
              <HiddenSites count={hidden} to={arrangeHref(true)} />
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {/* The answer as a sentence and as a picture: which sites need you,
              by the one health word, and the whole portfolio split by it. The
              split's legend is the Health filter. */}
          <div className="flex flex-col gap-4">
            <PageAnswer
              answer={answer.line}
              detail={answer.detail}
              figures={figures}
              marks={{ "data-surface-hero": "", "data-sites-answer": answer.key }}
            />
            <HealthSplit parts={parts} value={health} onPick={(value) => setFilter("health", value)} />
          </div>

          <div className="flex flex-col gap-3">
            <FilterFold active={status === "all" ? 0 : 1} label="Order & stage">
              <div className="@container flex flex-wrap items-center gap-2" data-assets-controls>
                <FilterToggle />
                <FilterControls
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-2"
                  marks={{ "data-assets-filters": "" }}
                >
                  <OrderChips value={sort} onPick={(value) => setFilter("sort", value)} />
                  <label className="sr-only" htmlFor="assets-status">
                    Stage
                  </label>
                  <select
                    id="assets-status"
                    // Beside the order while the row has room for both, under it after.
                    className={cn(fieldClass, "@2xl:ml-auto")}
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
                  <Button asChild variant="outline" size="sm">
                    <Link to={arrangeHref(true)} replace data-assets-arrange-open>
                      <ArrowDownUp aria-hidden /> Arrange
                    </Link>
                  </Button>
                </FilterControls>
              </div>
            </FilterFold>

            {narrowed || hidden > 0 ? (
              <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground" data-assets-summary>
                <span>{narrowing}</span>
                {hidden > 0 ? <span aria-hidden>·</span> : null}
                {hidden > 0 ? <HiddenSites count={hidden} to={arrangeHref(true)} /> : null}
                {narrowed ? <Link
                  to={{ search: sort === "seed" ? "" : `?sort=${sort}` }}
                  replace
                  className="font-medium text-foreground underline-offset-4 outline-none hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear
                </Link> : null}
              </p>
            ) : null}

            {visible.length === 0 ? (
              // Not "No sites yet": a control hides them, and the line above
              // names the controls and holds Clear.
              <section className="rounded-[10px] border border-border bg-card px-4 py-3">
                <EmptyState title="No assets match these filters" />
              </section>
            ) : (
              <AssetsTable lines={visible} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The page's answer: how many sites need the operator, by the one health
 * word, and which ones. A retired site is counted in neither part. */
function sitesAnswer(listed: readonly SiteLine[]): { key: string; line: string; detail: ReactNode } {
  const lines = watchedLines(listed);
  const noun = siteNoun(lines.length);
  if (lines.length === 0) {
    return { key: "retired", line: `${formatInt(listed.length)} ${siteNoun(listed.length)} retired`, detail: undefined };
  }
  const offTrack = lines.filter((line) => line.health.key === "off-track");
  const atRisk = lines.filter((line) => line.health.key === "at-risk");
  const needs = [...offTrack, ...atRisk];
  if (needs.length > 0) {
    const word = atRisk.length === 0 ? "off track" : offTrack.length === 0 ? "at risk" : "need attention";
    // Each named site is its own way in: the answer's one action.
    return {
      key: "needs-you",
      line: `${formatInt(needs.length)} of ${formatInt(lines.length)} ${noun} ${word}`,
      detail: (
        <span className="inline-flex flex-wrap items-center gap-x-1">
          {needs.slice(0, 3).map((line, index) => (
            <span key={line.card.id} className="whitespace-nowrap">
              {index > 0 ? "· " : null}
              <Link to={sitePath(line.card)} className="font-medium text-foreground underline-offset-4 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center" data-sites-answer-site={line.card.id}>
                {line.card.displayName}
              </Link>
            </span>
          ))}
          {needs.length > 3 ? <span className="whitespace-nowrap">· {formatInt(needs.length - 3)} more</span> : null}
        </span>
      ),
    };
  }
  return { key: "on-track", line: `All ${formatInt(lines.length)} ${noun} on track`, detail: undefined };
}

/** How many sites the list leaves out because their Home and Sites list
 * switch is off, opening Arrange, where they are listed. */
function HiddenSites({ count, to }: { count: number; to: string }) {
  return (
    <Link
      to={to}
      replace
      data-assets-hidden={count}
      className="font-medium text-foreground underline-offset-4 outline-none hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {formatInt(count)} hidden
    </Link>
  );
}

function readKey<K extends string>(value: string | null, allowed: readonly K[]): K {
  return allowed.includes(value as K) ? (value as K) : (allowed[0] as K);
}

/** The orderings as one row of choices, each one press, the picked one filled.
 * Route layout over the page's own URL state, not a registry component. */
function OrderChips({ value, onPick }: { value: SitesOrder; onPick: (value: SitesOrder) => void }) {
  return (
    <div role="group" aria-label="Order" className="inline-flex flex-wrap items-center gap-1.5" data-assets-order>
      <span aria-hidden className="me-1 text-xs font-medium text-muted-foreground">Order</span>
      {ORDERS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(option.value)}
            className={cn(pillChoiceClass, pillChoiceStateClass(active))}
            data-order={option.value}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default AssetsRoute;
