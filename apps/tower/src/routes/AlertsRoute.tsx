import { isRetired } from "@shared/asset-setup";
import { useEffect } from "react";
import type {
  AttentionItem,
  FlagKind,
  Severity,
  WallPayload,
} from "@shared/wall";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ALERT_HISTORY_MAX_LIMIT,
  type AlertHistoryPageRefusal,
  type AlertHistoryPayload,
  type AlertHistoryQuery,
  parseAlertHistoryQuery,
} from "@shared/alert-history";
import { ageMs, formatAge } from "@shared/freshness";
import { AlertList, AlertRow } from "@/components/AlertRow";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { alertsLine } from "@/lib/alerts-line";
import { SeverityDot } from "@/components/SeverityDot";
import { FinishLine, readingAge } from "@/components/surface/FinishLine";
import { PageAnswer, type AnswerFigure } from "@/components/surface/PageAnswer";
import { ReadFailed } from "@/components/ReadFailed";
import { PageSkeleton } from "@/components/Skeleton";
import { FilterBar } from "@/components/surface/FilterBar";
import { TabPanel, Tabs, type TabSpec } from "@/components/Tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useAlertHistory } from "@/hooks/useAlertHistory";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { AlertHistoryPageError } from "@/lib/api";
import { formatInt } from "@/lib/format";
import { AlertDaily } from "@/routes/alerts/AlertDaily";
import { AlertBoard } from "@/routes/alerts/AlertBoard";
import { AlertWeek } from "@/routes/alerts/AlertWeek";
import { SnoozedAlerts } from "@/routes/alerts/SnoozedAlerts";

const SEVERITIES: { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "Any severity" },
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings" },
];

/** History carries info rows the open list never can: a milestone is an event,
 * always info-severity, and it settles like anything else. */
const HISTORY_SEVERITIES: { value: Severity | "all"; label: string }[] = [
  ...SEVERITIES,
  { value: "info", label: "Info" },
];

/** The kinds an open row can be. No Milestones: a milestone is always
 * info-severity and the Open list holds warnings and errors only, so that
 * option could only ever empty the list, which would read as "there are no
 * milestones". */
const KINDS: { value: FlagKind | "all"; label: string }[] = [
  { value: "all", label: "Any kind" },
  { value: "anomaly", label: "Anomalies" },
  { value: "opportunity", label: "Opportunities" },
];

/** The URL's `?kind=` when this view offers it, otherwise "all". A saved link
 * that still says `kind=milestone` shows the whole list under "Any kind"
 * rather than a select sitting on an option it does not have. */
function offeredKind(params: URLSearchParams): FlagKind | "all" {
  const kind = params.get("kind");
  return KINDS.find((option) => option.value === kind)?.value ?? "all";
}

// --- the two views -----------------------------------------------------------
/** `open` is the index tab: `/alerts` IS Open, exactly as `/assets/:id` is an
 * asset's Overview. */
const ALERT_TABS = ["open", "history"] as const;
type AlertTab = (typeof ALERT_TABS)[number];

const TAB_LABEL: Record<AlertTab, string> = {
  open: "Open",
  history: "History",
};

const TAB_IDS = "alerts-tab";
const TAB_PANEL_ID = "alerts-tab-panel";

function tabPath(tab: AlertTab): string {
  return tab === "open" ? "/alerts" : `/alerts/${tab}`;
}

/** A URL segment the router handed us → a view. Anything unrecognized reads as
 * Open: a mistyped tab is still the page the operator asked for. */
function tabFromParam(param: string | undefined): AlertTab {
  return (ALERT_TABS as readonly string[]).includes(param ?? "")
    ? (param as AlertTab)
    : "open";
}

/**
 * The filters one tab hands the other: "what is open for this asset" and "what
 * closed for this asset" are one question asked twice. A tab carries only what
 * the destination can honour, because a filter a view ignores would leave its
 * `<select>` on a value that is not one of its options: `kind` never reaches
 * History, `severity: info` never reaches Open, and History's `offset` never
 * leaves History.
 */
function carriedFilters(params: URLSearchParams, to: AlertTab): string {
  const carried = new URLSearchParams();
  const asset = params.get("asset");
  if (asset) carried.set("asset", asset);
  const severity = params.get("severity");
  const offered = to === "history" ? HISTORY_SEVERITIES : SEVERITIES;
  if (severity && offered.some((option) => option.value === severity)) {
    carried.set("severity", severity);
  }
  return carried.toString();
}

/** Every filter Open honours, its kind included, for a link that lands on Open. */
function openFilters(params: URLSearchParams): string {
  const query = new URLSearchParams(carriedFilters(params, "open"));
  const kind = offeredKind(params);
  if (kind !== "all") query.set("kind", kind);
  return query.toString();
}

/** The row a link names: `#alert-9001` opens that row and brings it into view. */
function focusedAlert(hash: string): number | null {
  const match = /^#alert-(\d+)$/.exec(hash);
  return match ? Number(match[1]) : null;
}

/**
 * /alerts: the portfolio's alerts, open and settled. The answer and the week
 * drawn under it are the portfolio's, not the filtered view's. The tab and
 * the filters live in the URL; `Tabs` matches the active tab on the path, so
 * a tab link can carry the filters already set.
 */
export function AlertsRoute() {
  const { tab: tabParam } = useParams();
  const tab = tabFromParam(tabParam);
  const { data, isError, error, isFetching, refetch } = useWall();
  const now = useNow();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [params] = useSearchParams();
  // The answer's settled figures and the week's closed bars: one page, the
  // biggest this archive will hand over, ordered by when each row closed, so a
  // week's settlements are exact whenever fewer than a hundred rows have closed
  // since, and the figure says so when they have not.
  const settled = useAlertHistory(STRIP_HISTORY_QUERY);

  // `Tabs` matches on the path, so `/alerts/nonsense` would render Open with no
  // tab selected: canonicalise the URL to the view it shows, with `replace`.
  const canonical = tabParam !== undefined && tabParam !== tab;
  const search = params.toString();
  useEffect(() => {
    if (!canonical) return;
    navigate(`${tabPath(tab)}${search ? `?${search}` : ""}`, { replace: true });
  }, [canonical, navigate, search, tab]);

  const tabs: TabSpec[] = ALERT_TABS.map((key) => {
    const carried = carriedFilters(params, key);
    return {
      key,
      to: `${tabPath(key)}${carried ? `?${carried}` : ""}`,
      label: TAB_LABEL[key],
      end: key === "open",
      title:
        key === "open"
          ? "Warnings and errors nobody has closed yet"
          : "Alerts that were resolved or acknowledged",
    };
  });

  // A bar opens its row on Open, keeping the narrowing on screen when the
  // row survives it and dropping it when it would hide the row.
  const shown = new Set(data ? filterOpen(data.attention, params).map((item) => item.id) : []);
  const openQuery = openFilters(params);
  const openHref = (item: AttentionItem) => {
    const query = shown.has(item.id) ? openQuery : "";
    return `${tabPath("open")}${query ? `?${query}` : ""}#alert-${item.id}`;
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      {/* No description: the word Alerts over a sentence saying how bad tonight is. */}
      <PageHeader title="Alerts" />

      {!data ? (
        isError ? (
          <ReadFailed title="Couldn't load alerts" subject="read:alerts" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <PageSkeleton subject="read:alerts" shape="list" />
        )
      ) : (
        <>
          {/* One answer first, then the same answer drawn: how many are open
              and how bad, then the week on one axis. Both sit above the tabs
              because they are true of both. */}
          <AlertsAnswer items={data.attention} settled={settled.data} settledFailed={settled.isError} nowMs={now} />
          <AlertWeek open={data.attention} settled={settled.data?.rows ?? []} assets={data.assets} nowMs={now} openHref={openHref} />

          <AlertDaily />

          <Tabs
            label="Alert views"
            tabs={tabs}
            idBase={TAB_IDS}
            panelId={TAB_PANEL_ID}
          />

          <TabPanel id={TAB_PANEL_ID} idBase={TAB_IDS} activeKey={tab}>
            {tab === "history" ? (
              <HistoryView assets={data.assets} nowMs={now} />
            ) : (
              <OpenView data={data} nowMs={now} focusId={focusedAlert(hash)} />
            )}
          </TabPanel>
          {/* No About panel: each fact is shown where it applies. */}
        </>
      )}
    </div>
  );
}

/**
 * The strip's read of the archive: one page, the largest it will give.
 *
 * A constant rather than a value built per render, so react-query keys on one
 * identity and the strip does not re-fetch when the operator types in a filter
 * the strip deliberately ignores.
 */
const STRIP_HISTORY_QUERY: AlertHistoryQuery = {
  asset: null,
  severity: null,
  offset: 0,
  limit: ALERT_HISTORY_MAX_LIMIT,
  malformed: null,
};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// --- the answer --------------------------------------------------------------

/** How many alerts closed in the last seven days, and whether that count is
 * exact: the archive is read one page at a time, so a page that does not reach
 * back past the week's start makes the count a floor. */
export function settledThisWeek(payload: AlertHistoryPayload | undefined, nowMs: number): { count: number; exact: boolean } | null {
  if (!payload) return null;
  const closed = payload.rows.map(closedAtMs).filter((at): at is number => at !== null);
  const oldest = closed.length === 0 ? null : Math.min(...closed);
  const weekStart = nowMs - WEEK_MS;
  return {
    count: closed.filter((at) => at >= weekStart).length,
    exact: !payload.hasMore || (oldest !== null && oldest <= weekStart),
  };
}

function AlertsAnswer({ items, settled, settledFailed, nowMs }: { items: AttentionItem[]; settled: AlertHistoryPayload | undefined; settledFailed: boolean; nowMs: number }) {
  const errors = items.some((item) => item.severity === "error");
  const ages = items.map((item) => ageMs(nowMs, item.firstFiredAt)).filter((age): age is number => age !== null);
  const week = settledFailed ? null : settledThisWeek(settled, nowMs);
  const figures: AnswerFigure[] = [];
  if (ages.length > 0) figures.push({ label: "Oldest", value: formatAge(Math.max(...ages)), mark: "alerts-oldest" });
  if (week) figures.push({ label: "Settled this week", value: `${formatInt(week.count)}${week.exact ? "" : "+"}`, mark: "alerts-settled" });
  return (
    <PageAnswer
      answer={alertsLine(items)}
      mark={items.length === 0 ? null : <SeverityDot severity={errors ? "error" : "warn"} />}
      figures={figures}
      marks={{ "data-surface-hero": "", "data-alerts-answer": items.length === 0 ? "clear" : errors ? "error" : "warn" }}
    />
  );
}

function closedAtMs(row: AlertHistoryPayload["rows"][number]): number | null {
  const closed = row.flag.resolvedAt ?? row.flag.dispositionAt;
  if (closed === null) return null;
  const at = Date.parse(closed);
  return Number.isNaN(at) ? null : at;
}

function filterOpen(
  items: AttentionItem[],
  params: URLSearchParams,
): AttentionItem[] {
  const asset = params.get("asset") ?? "all";
  const severity = params.get("severity") ?? "all";
  const kind = offeredKind(params);
  return items.filter(
    (item) =>
      // A cross-asset row belongs to every asset it stands for: filtering to
      // one site must not hide the row that carries that site's own Mark read
      // / Resolve just because another asset leads it.
      (asset === "all" ||
        item.asset === asset ||
        (item.members?.some((member) => member.asset === asset) ?? false)) &&
      (severity === "all" || item.severity === severity) &&
      (kind === "all" || item.kind === kind),
  );
}

/**
 * Write one filter into the URL, clearing anything the change invalidates.
 * `all` and the empty string both mean absent, so the unfiltered view is a
 * bare path. `replace`: Back should leave Alerts, not walk every dropdown.
 */
function useFilterWriter(): (name: string, value: string, resets?: string[]) => void {
  const [params, setParams] = useSearchParams();
  return (name, value, resets = []) => {
    const next = new URLSearchParams(params);
    if (value === "all" || value === "") next.delete(name);
    else next.set(name, value);
    for (const key of resets) next.delete(key);
    setParams(next, { replace: true });
  };
}

// --- Open -------------------------------------------------------------------
function OpenView({ data, nowMs, focusId }: { data: WallPayload; nowMs: number; focusId: number | null }) {
  const [params] = useSearchParams();
  const setFilter = useFilterWriter();

  const asset = params.get("asset") ?? "all";
  const severity = params.get("severity") ?? "all";
  const kind = offeredKind(params);

  const filtered = filterOpen(data.attention, params);
  const filtering = asset !== "all" || severity !== "all" || kind !== "all";

  return (
    <>
      {/* On a phone the selects wait behind one Filters press (the shared
          fold); on a desk they are this row. */}
      <FilterBar
        active={[asset, severity, kind].filter((value) => value !== "all").length}
        className="flex flex-wrap items-center gap-2"
        marks={{ "data-alert-filters": "" }}
      >
        {/* A site filter with one site to pick is a question with one answer;
            a link that already narrows keeps its select. */}
        {data.assets.length > 1 || asset !== "all" ? (
          <>
            <label className="sr-only" htmlFor="alerts-asset">
              Asset
            </label>
            <select
              id="alerts-asset"
              className={fieldClass}
              value={asset}
              onChange={(event) => setFilter("asset", event.target.value)}
            >
              <option value="all">Every asset</option>
              {data.assets.filter((card) => !isRetired(card.status)).map((card) => (
                <option key={card.id} value={card.id}>
                  {card.displayName}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <label className="sr-only" htmlFor="alerts-severity">
          Severity
        </label>
        <select
          id="alerts-severity"
          className={fieldClass}
          value={severity}
          onChange={(event) => setFilter("severity", event.target.value)}
        >
          {SEVERITIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="alerts-kind">
          Kind
        </label>
        <select
          id="alerts-kind"
          className={fieldClass}
          value={kind}
          onChange={(event) => setFilter("kind", event.target.value)}
        >
          {KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FilterBar>

      {filtered.length > 0 ? (
        <AlertBoard items={filtered} total={data.attention.length} filtering={filtering} nowMs={nowMs} focusId={focusId} />
      ) : null}
      {/* A list the eye can finish: every open alert is above. */}
      {filtered.length > 0 && !filtering ? (
        <FinishLine line="That's every open alert." age={readingAge(data.generatedAt, nowMs)} />
      ) : null}
      {filtered.length > 0 ? null : filtering ? (
        // A filtered blank is not an all-clear: saying "All clear" here
        // would report the portfolio healthy because of a dropdown.
        <EmptyState
          title="No open alerts match these filters"
          hint="Widen a filter above to see the rest."
        />
      ) : (
        <FinishLine quiet line="All clear." age={readingAge(data.generatedAt, nowMs)} />
      )}

      <SnoozedAlerts items={data.snoozed} nowMs={nowMs} />
    </>
  );
}

// --- History ----------------------------------------------------------------
/**
 * What already closed, across the portfolio. Every row is `AlertRow` in its
 * settled mode, the same component an asset's own Alerts tab renders, plus the
 * one thing a portfolio surface owes: which asset, as its favicon and a link
 * into that asset's Alerts tab. It reads `/api/alerts/history`, not the wall
 * payload, because a paged archive has no business riding along with what a
 * television polls every 60 seconds.
 */
function HistoryView({
  assets,
  nowMs,
}: {
  assets: WallPayload["assets"];
  nowMs: number;
}) {
  const [params] = useSearchParams();
  const setFilter = useFilterWriter();
  const query = parseAlertHistoryQuery(params);
  const { data, isError, error, isFetching, refetch } = useAlertHistory(query);
  const filtering = query.asset !== null || query.severity !== null;

  /** The URL asked for a page this archive cannot read: not the same event as
   * a store that failed. */
  const refusedPage =
    query.malformed !== null && error instanceof AlertHistoryPageError
      ? { refusal: query.malformed, total: error.total, limit: error.limit }
      : null;

  return (
    <>
      <FilterBar
        active={[query.asset, query.severity].filter((value) => value !== null).length}
        className="flex flex-wrap items-center gap-2"
        marks={{ "data-alert-history-filters": "" }}
        // Where in the archive the reader is. Every number in it is the
        // answered page's own, so while the next page loads it still describes
        // the rows on screen.
        aside={data && !refusedPage ? <HistoryRange offset={data.offset} rows={data.rows.length} total={data.total} /> : null}
      >
        {assets.length > 1 || query.asset !== null ? (
          <>
            <label className="sr-only" htmlFor="alert-history-asset">
              Asset
            </label>
            <select
              id="alert-history-asset"
              className={fieldClass}
              value={query.asset ?? "all"}
              // A filter change puts the reader back on the first page: page 4 of
              // one asset's history is page 4 of a list that no longer exists.
              onChange={(event) => setFilter("asset", event.target.value, ["offset"])}
            >
              <option value="all">Every asset</option>
              {assets.filter((card) => !isRetired(card.status)).map((card) => (
                <option key={card.id} value={card.id}>
                  {card.displayName}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <label className="sr-only" htmlFor="alert-history-severity">
          Severity
        </label>
        <select
          id="alert-history-severity"
          className={fieldClass}
          value={query.severity ?? "all"}
          onChange={(event) => setFilter("severity", event.target.value, ["offset"])}
        >
          {HISTORY_SEVERITIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {/* The range badge states where in the archive the reader is, so it
            has nothing true to say about a page that does not exist, and with
            `keepPreviousData` the last good page's numbers would still be
            sitting in `data`. */}
      </FilterBar>

      {refusedPage ? (
        <MalformedPage
          {...refusedPage}
          onFirstPage={() => setFilter("offset", "", ["limit"])}
        />
      ) : isError ? (
        <ReadFailed title="Couldn't load alert history" subject="read:alert-history" error={error} retrying={isFetching} onRetry={() => void refetch()} />
      ) : !data ? (
        <PageSkeleton subject="read:alert-history" shape="list" className="min-h-[30vh]" />
      ) : data.rows.length === 0 ? (
        filtering ? (
          <EmptyState
            title="No settled alerts match these filters"
            hint="Widen a filter above to see the rest."
          />
        ) : (
          <EmptyState
            title="No settled alerts yet"
            hint="An alert appears here once it has been resolved or acknowledged."
          />
        )
      ) : (
        <>
          {/* The archive is one group, so one panel, like the board on Open. */}
          <div className="rounded-xl bg-card p-2 ring-1 ring-border/70">
            <AlertList label="Settled alerts">
              {data.rows.map((row) => (
                <AlertRow
                  key={row.flag.id}
                  flag={row.flag}
                  asset={row.asset}
                  assetId={row.asset.id}
                  nowMs={nowMs}
                  history
                />
              ))}
            </AlertList>
          </div>
          <Pager
            query={query}
            hasMore={data.hasMore}
            onPage={(offset) => setFilter("offset", offset === 0 ? "" : String(offset))}
          />
        </>
      )}
    </>
  );
}

/**
 * A `?offset=`/`?limit=` this archive cannot read: the mirror of
 * `/financials`'s `MissingPeriod`. The way out is a button rather than a link
 * because this page's other move between pages is a button, and it clears
 * both page params at once so a URL that got `limit` wrong is not left
 * carrying it.
 */
function MalformedPage({
  refusal,
  total,
  limit,
  onFirstPage,
}: {
  refusal: AlertHistoryPageRefusal;
  total: number;
  limit: number;
  onFirstPage: () => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-history-page-malformed={refusal.param}>
      {/* The heading quotes what the link carried; the hint is the archive's
          size in figures, which is all a reader needs to see why the value is
          not a page — then the one way out. */}
      <EmptyState
        title={`“${refusal.value}” is not a page of this archive`}
        hint={total > 0 ? `${total} settled · ${limit} per page` : "Nothing settled yet"}
      />
      <div>
        <Button variant="outline" size="sm" onClick={onFirstPage}>
          First page
        </Button>
      </div>
    </div>
  );
}

/**
 * Which slice of what: the archive's one count, stated once. `1–25 of 137`
 * rather than a bare total, because a total with no position leaves the Older
 * button meaning nothing. All three numbers come from one answer: with
 * `keepPreviousData` holding the last page on screen, an offset taken from the
 * URL would read "126–150 of 137" while the next page loads.
 */
function HistoryRange({
  offset,
  rows,
  total,
}: {
  /** The offset of the page these rows ARE, from its payload. */
  offset: number;
  rows: number;
  total: number;
}) {
  if (total === 0) return <Badge variant="outline">0 settled</Badge>;
  const first = offset + 1;
  const last = offset + rows;
  return (
    <Badge variant="outline" className="tabular-nums" data-history-range>
      {first}–{last} of {total} settled
    </Badge>
  );
}

/** Newer / Older, and nothing else. The range badge above owns every number, so
 * these carry direction only — a page count here would be the same fact a third
 * time. */
function Pager({
  query,
  hasMore,
  onPage,
}: {
  query: AlertHistoryQuery;
  hasMore: boolean;
  onPage: (offset: number) => void;
}) {
  const canGoBack = query.offset > 0;
  if (!canGoBack && !hasMore) return null;
  return (
    <div className="flex items-center justify-end gap-2" data-history-pager>
      <Button
        variant="outline"
        size="sm"
        disabled={!canGoBack}
        onClick={() => onPage(Math.max(0, query.offset - query.limit))}
      >
        Newer
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasMore}
        onClick={() => onPage(query.offset + query.limit)}
      >
        Older
      </Button>
    </div>
  );
}

export default AlertsRoute;
