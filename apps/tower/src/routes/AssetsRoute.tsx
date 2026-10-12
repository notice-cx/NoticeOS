import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ASSET_STATUS_LABEL, assetStatusLabel } from "@shared/asset-detail";
import { ageMs, formatAge } from "@shared/freshness";
import { siteNoun } from "@shared/site-noun";
import { sitePath } from "@shared/first-run";
import { AddSiteButton } from "@/components/AddSite";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
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
  { value: "health", label: "Needs you" },
  { value: "money", label: "Money" },
  { value: "users", label: "People" },
  { value: "name", label: "A–Z" },
];

/** The answer, the health split and the stage are facts about the whole
 * portfolio; the comparison under them is what the controls narrow and
 * order. Every control is shareable URL state. */
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

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    // A default never occupies the query string: one view, one link.
    if (value === "all" || (name === "sort" && value === "seed")) next.delete(name);
    else next.set(name, value);
    // `replace`: Back should leave Sites, not walk every control touched.
    setParams(next, { replace: true });
  }

  const assets = data?.assets ?? [];
  const lines = data ? siteLines(assets, data.portfolio, issues, connections, now) : [];
  const matches = lines.filter(
    (line) => (status === "all" || line.card.status === status) && (health === "all" || line.health.key === health),
  );
  const visible = orderSites(matches, sort);
  const narrowed = status !== "all" || health !== "all";

  /** Counts are over the whole portfolio, not over what the other control has
   * already narrowed: "how many sites are live" is a fact about the portfolio. */
  const statusCounts = new Map<string, number>();
  for (const card of assets) statusCounts.set(card.status, (statusCounts.get(card.status) ?? 0) + 1);
  // The five canonical stages always appear, in lifecycle order, even at zero.
  // An unknown status (from the store or only the URL) is appended rather than
  // dropped, as `assetStatusLabel` does, so the control never shows nothing.
  const statusOptions = [
    ...Object.keys(ASSET_STATUS_LABEL),
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
  const figures = data ? [monthFigure(data.portfolio, assets), visitorsAnswerFigure(assets)].filter((figure) => figure !== null) : [];

  const narrowing = [
    `${formatInt(visible.length)} of ${formatInt(assets.length)} ${siteNoun(assets.length)}`,
    ...(status !== "all" ? [`stage: ${assetStatusLabel(status).toLowerCase()}`] : []),
    ...(health !== "all" ? [`health: ${SITE_HEALTH[health].word.toLowerCase()}`] : []),
  ].join(" · ");

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 md:p-6">
      <PageHeader
        title="Sites"
        actions={
          // Opens Add a site over this page: adding a site is one question,
          // not a page of its own.
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

      {/* The machinery arrives with something to compare: over no sites the
          answer, split and controls would surround an empty state, and over
          one they would sort a single row. So no sites is the header's Add a
          site and one empty state, and one site is its row. */}
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
        <div data-surface-hero>
          <AssetsTable lines={lines} />
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
                </FilterControls>
              </div>
            </FilterFold>

            {narrowed ? (
              <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground" data-assets-summary>
                <span>{narrowing}</span>
                <Link
                  to={{ search: sort === "seed" ? "" : `?sort=${sort}` }}
                  replace
                  className="font-medium text-foreground underline-offset-4 outline-none hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear
                </Link>
              </p>
            ) : null}

            {visible.length === 0 ? (
              // Not "No sites yet": a control hides them, and the line above
              // names the controls and holds Clear.
              <section className="rounded-[10px] border border-border bg-card px-4 py-3">
                <EmptyState title="No sites match these filters" />
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
 * word, and which ones. */
function sitesAnswer(lines: readonly SiteLine[]): { key: string; line: string; detail: ReactNode } {
  const noun = siteNoun(lines.length);
  const offTrack = lines.filter((line) => line.health.key === "off-track");
  const atRisk = lines.filter((line) => line.health.key === "at-risk");
  const settingUp = lines.filter((line) => line.health.key === "setting-up");
  const needs = [...offTrack, ...atRisk];
  if (needs.length > 0) {
    const word = atRisk.length === 0 ? "off track" : offTrack.length === 0 ? "at risk" : "need you";
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
  const fine = lines.length - settingUp.length;
  if (settingUp.length === 0) return { key: "on-track", line: `All ${formatInt(lines.length)} ${noun} on track`, detail: undefined };
  return {
    key: "setting-up",
    line: fine === 0 ? `${formatInt(lines.length)} ${noun} setting up` : `${formatInt(fine)} of ${formatInt(lines.length)} ${noun} on track`,
    detail: fine === 0 ? undefined : `${formatInt(settingUp.length)} setting up`,
  };
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
