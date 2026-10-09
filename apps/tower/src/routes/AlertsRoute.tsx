import { useEffect } from "react";
import type {
  AttentionItem,
  FlagKind,
  Severity,
  SnoozedItem,
  WallPayload,
} from "@shared/wall";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ALERT_HISTORY_MAX_LIMIT,
  type AlertHistoryPageRefusal,
  type AlertHistoryPayload,
  type AlertHistoryQuery,
  parseAlertHistoryQuery,
} from "@shared/alert-history";
import { translateAlert } from "@shared/alert-language";
import { siteAddress } from "@shared/first-run";
import { ageMs, formatAge } from "@shared/freshness";
import {
  ALERT_EVIDENCE_QUESTION,
  AlertList,
  AlertRow,
  Recurrence,
  alertPopoverEvidence,
} from "@/components/AlertRow";
import { AlertVerification } from "@/components/AlertVerification";
import { alertTaskHandoff, isGrouped, memberNames } from "@/lib/attention";
import { ChangeChip } from "@/components/ChangeChip";
import { Drill } from "@/components/Drill";
import { EmptyState } from "@/components/EmptyState";
import { EvidencePopover } from "@/components/EvidencePopover";
import { FlagActions } from "@/components/FlagActions";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { PageHeader } from "@/components/PageHeader";
import { SeverityDot } from "@/components/SeverityDot";
import { FinishLine, readingAge } from "@/components/surface/FinishLine";
import { PageAnswer, type AnswerFigure } from "@/components/surface/PageAnswer";
import { ReadFailed } from "@/components/ReadFailed";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SnoozeUntil } from "@/components/SnoozeUntil";
import { FilterBar } from "@/components/surface/FilterBar";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { FileTaskButton } from "@/components/TaskComposer";
import { TabPanel, Tabs, type TabSpec } from "@/components/Tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useAlertHistory } from "@/hooks/useAlertHistory";
import { useNow } from "@/hooks/useNow";
import { useSitePath } from "@/hooks/useSitePath";
import { useWall } from "@/hooks/useWall";
import { AlertHistoryPageError } from "@/lib/api";
import { formatInt } from "@/lib/format";
import { taskHandoffPrefill } from "@/lib/task-handoff";

const SEVERITIES: { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "Any severity" },
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings" },
];

/** History carries INFO rows the open list never can — a milestone is an event,
 * always info-severity (db/0001's own CHECK), and it settles like anything
 * else. Same three words as everywhere, one more of them. */
const HISTORY_SEVERITIES: { value: Severity | "all"; label: string }[] = [
  ...SEVERITIES,
  { value: "info", label: "Info" },
];

/** The kinds an OPEN row can be (bead `ro-ujb9.197`). No Milestones: a
 * milestone is always info-severity (db/0001's CHECK) and the Open list holds
 * warnings and errors only, so that option could only ever empty the list —
 * which reads as "there are no milestones", and that is false. */
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

// --- the two views (bead `ro-ju7f`) ----------------------------------------
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
 * The filters one tab hands the other (bead `ro-clz8`).
 *
 * "What is open for this asset" and "what closed for this asset" are one
 * question asked twice, so the narrowing survives the switch — otherwise the
 * second half of the question costs three clicks.
 *
 * A tab carries only what the DESTINATION can honour, because a filter a view
 * ignores is worse than no filter: its `<select>` would sit on a value that is
 * not one of its options. So `kind` never reaches History, which has no kind
 * filter; `severity: info` never reaches Open, whose list can never hold an info
 * row; and History's `offset` never leaves History, because page 4 of one list
 * is not page 4 of another.
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

/**
 * `/alerts` — the portfolio's alerts, open and settled, composed to doc 21
 * (beads `ro-ju7f`, `ro-78qo.7`).
 *
 * ONE QUESTION: *what is firing, and how bad.* The strip is the whole answer and
 * the list under it is the same conditions one line at a time.
 *
 * WHAT CHANGED, AND WHY. The page printed FOUR BUTTONS UNDER EVERY ROW — Mark
 * read, Snooze, Resolve, File task — so five alerts meant twenty verbs on
 * screen, each 28px tall and none of them the thing the operator came to read.
 * The queue's own severity was the quietest ink on a page made of controls. Doc
 * 21 puts the verbs where the decision is made: a row opens IN PLACE, and its
 * lifecycle, task handoff and available Tune actions are inside it. Closed,
 * a row is a mark, an asset, a signal, how often
 * it has re-fired, when it was first seen and when it was last confirmed.
 *
 * THE STRIP IS OVER BOTH TABS, and it is the PORTFOLIO's rather than the
 * filtered view's: "how bad is it tonight" does not change because a dropdown
 * did. The panel below states what is on screen whenever a filter narrows it.
 *
 * THE TAB IS THE URL. `/alerts` is Open and `/alerts/history` is History, so a
 * view is a link — the same contract the asset page's tabs keep. `Tabs` matches
 * the active tab on the PATH, which is what lets a tab link CARRY the filters
 * the operator already set (bead `ro-clz8`).
 *
 * FILTERS LIVE IN THE URL. `useSearchParams`, so a filtered view is a LINK — the
 * state can be bookmarked, pasted into a bead, and reached from an asset page.
 * Native `<select>`s in the desk's existing input chrome, because enum pickers
 * do not justify a new component (doc 14, the registry is law).
 */
export function AlertsRoute() {
  const { tab: tabParam } = useParams();
  const tab = tabFromParam(tabParam);
  const { data, isError, error, isFetching, refetch } = useWall();
  const now = useNow();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The strip's settled figures. One page, the biggest this archive will hand
  // over, ordered by when each row CLOSED — so a week's settlements are exact
  // whenever fewer than a hundred rows have closed since, and the KPI says so
  // when they have not.
  const settled = useAlertHistory(STRIP_HISTORY_QUERY);

  // A segment nobody built renders Open — but `Tabs` matches the active tab on
  // the PATH, so `/alerts/nonsense` would render Open under a bar with nothing
  // selected and a panel labelled by an unselected tab. Canonicalise instead:
  // the URL becomes the view it is already showing. `replace`, because a typo
  // is not a step in the operator's history.
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

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3.5 p-4 md:p-6">
      {/* No description. What this page is, is the word Alerts over a strip
          saying how bad tonight is (doc 21 principles 3 and 3a). */}
      <PageHeader title="Alerts" />

      {!data ? (
        isError ? (
          <ReadFailed title="Couldn't load alerts" subject="read:alerts" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">Loading…</div>
        )
      ) : (
        <>
          {/* ONE ANSWER FIRST (D45): how many are open and how bad, in a
              sentence, with the oldest and the week's settled count beside it.
              It sits above the tabs because it is true of both. */}
          <AlertsAnswer items={data.attention} settled={settled.data} settledFailed={settled.isError} nowMs={now} />

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
              <OpenView data={data} nowMs={now} />
            )}
          </TabPanel>
          {/* NO ABOUT (bead `ro-ujb9.96.6.7`). Its four paragraphs defined the
              verification words, listed what an opened row holds, explained the
              strip's scope and said why Snoozed ignores the filters. Each is now
              shown where it applies: the verification is a glyph on every row
              and its checks are rows in the Evidence panel, the opened row IS
              the list of verbs, a filtered panel says "3 of 8 open" against the
              strip's total, and the Snoozed panel simply always lists every
              parked row. */}
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

/** "2 open alerts, both warnings" — the page's one sentence (D45). */
export function alertsLine(items: readonly AttentionItem[]): string {
  const errors = items.filter((item) => item.severity === "error").length;
  const warnings = items.length - errors;
  if (items.length === 0) return "No open alerts";
  if (items.length === 1) return errors === 1 ? "1 open alert, an error" : "1 open alert, a warning";
  const all = items.length === 2 ? "both" : "all";
  if (errors === 0) return `${formatInt(items.length)} open alerts, ${all} warnings`;
  if (warnings === 0) return `${formatInt(items.length)} open alerts, ${all} errors`;
  return `${formatInt(items.length)} open alerts, ${formatInt(errors)} ${errors === 1 ? "error" : "errors"}`;
}

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
      // A cross-asset row (`ro-kukv.6`) belongs to EVERY asset it stands for:
      // filtering to one site must not hide the row that carries that site's
      // own Mark read / Resolve just because another asset leads it.
      (asset === "all" ||
        item.asset === asset ||
        (item.members?.some((member) => member.asset === asset) ?? false)) &&
      (severity === "all" || item.severity === severity) &&
      (kind === "all" || item.kind === kind),
  );
}

/**
 * Write one filter into the URL, clearing anything the change invalidates.
 *
 * `all` and the empty string both mean ABSENT, so the URL names only what the
 * operator actually chose and the unfiltered view is a bare path.
 *
 * `replace`: a filter is a view of one page, not a place — the back button
 * should leave Alerts, not walk backwards through every dropdown touched.
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
function OpenView({ data, nowMs }: { data: WallPayload; nowMs: number }) {
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
          fold, bead ro-ujb9.13); on a desk they are this row. */}
      <FilterBar
        active={[asset, severity, kind].filter((value) => value !== "all").length}
        className="flex flex-wrap items-center gap-2"
        marks={{ "data-alert-filters": "" }}
      >
        {/* A site filter with one site to pick is a question with one answer
            (bead ro-ujb9.130); a link that already narrows keeps its select. */}
        {data.assets.length > 1 || asset !== "all" ? (
          <>
            <label className="sr-only" htmlFor="alerts-asset">
              Site
            </label>
            <select
              id="alerts-asset"
              className={fieldClass}
              value={asset}
              onChange={(event) => setFilter("asset", event.target.value)}
            >
              <option value="all">Every site</option>
              {data.assets.map((card) => (
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
        <ListPanel
          title="Open"
          // The STRIP owns the total (doc 14, one fact once); this says what is
          // on screen only when a filter has made the two differ.
          count={
            filtering
              ? `${filtered.length} of ${data.attention.length} open`
              : undefined
          }
          // Every matching row, always. A queue that hid its tail behind "Show
          // 9 more" would be a triage page keeping work out of sight, which is
          // the one thing an alerts list may not do.
          limit={filtered.length}
        >
          {filtered.map((item) =>
            isGrouped(item) ? (
              <GroupedAlertRow key={item.id} item={item} nowMs={nowMs} />
            ) : (
              <OpenAlertRow key={item.id} item={item} nowMs={nowMs} />
            ),
          )}
        </ListPanel>
      ) : null}
      {/* A list the eye can finish (D45): every open alert is above. */}
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

/** WHICH ASSET, on a surface that holds several — the favicon that asset's own
 * page wears in its heading, so the eye finds a portfolio's rows by identity
 * before it reads a word. Not a link: the whole row opens, and its expansion
 * carries the way through. */
function AssetTag({ id, displayName }: { id: string; displayName: string }) {
  return (
    // ONE LINE OF ONE TYPE (design review, 2026-09-05). The name used to be
    // foreground-weight medium ahead of a body-weight headline, so every row's
    // title was two sizes and two baselines colliding at the left edge. It is a
    // muted prefix at the line's own size now, with the separator doing the work
    // the weight was doing — the favicon is the thing the eye finds an asset by,
    // and the headline is what it reads next.
    <>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <PropertyFavicon domain={id} displayName={displayName} className="size-4" />
        {displayName}
      </span>
      <span aria-hidden className="text-muted-foreground">
        {" · "}
      </span>
    </>
  );
}

/**
 * ONE OPEN ALERT, one line (doc 21, bead `ro-78qo.7`).
 *
 * Closed: the severity ring and its mark, which asset, what the rule says in the
 * operator's words, how often it has re-fired, and when it was first seen.
 * That is the triage read; actions appear only after the row opens.
 *
 * Open: the Evidence panel (the rule's numbers, the checks behind the caption,
 * its stored words), any change that landed just before, and Mark read, Snooze,
 * Resolve, task handoff and Tune when the rule supports an honest replay. These
 * are here rather than under every row because a disposition is a decision, and
 * a decision is made after reading the row, not before. Twenty buttons for five
 * alerts is what this page looked like when they were printed by default.
 *
 * The age is the recorded first-seen time, not tonight's re-reading. It does
 * not prove the condition stayed true between observations.
 */
function OpenAlertRow({ item, nowMs }: { item: AttentionItem; nowMs: number }) {
  const alert = translateAlert(item);
  const openSite = useSitePath();
  return (
    <ListRow
      tone={item.severity}
      // Doc 21's mark for a finding: the ring says how bad, the triangle says
      // what kind, so an alert never reads as an unfinished task.
      glyph="△"
      // NOT a flex row. `ListRow` truncates a closed row's title, which sets
      // `nowrap` on the line — and a flex child inside that cannot break, so a
      // long headline ran off the edge of a phone with no ellipsis to say it
      // had. Inline content lets the ellipsis do its job, and an open row drops
      // the truncation and wraps the whole line (bead `ro-78qo.7`).
      title={
        <>
          <AssetTag id={item.asset} displayName={item.assetDisplayName} />
          {alert.headline} <Recurrence item={item} nowMs={nowMs} />
        </>
      }
      // The hint or nothing. The kind is a filter and a fact of the expanded
      // row; printed as a caption it is one muted word under every line that
      // says less than the headline above it already did.
      caption={<>
        <AlertVerification verification={item.verification} firstDetectedAt={item.firstFiredAt} nowMs={nowMs} interactive={false} />
        {alert.hint ? ` · ${alert.hint}` : null}
      </>}
      value={formatAge(ageMs(nowMs, item.firstFiredAt))}
      valueLabel="first seen"
      // VERBS IN THE ROW (D45): Snooze and Resolve take an alert out of the
      // queue without opening it first; Mark read, Tune, a task and the site
      // are in the opened row, after the evidence.
      rowActions={<FlagActions flagId={item.id} assetId={item.asset} only={["snooze", "resolve"]} />}
      actions={
        <>
          {item.handoffBeads?.map((bead) => <HandoffBeadBadge key={bead.beadId} bead={bead} />)}
          <FlagActions
            flagId={item.id}
            assetId={item.asset}
            ruleId={item.ruleId}
            metric={item.metric}
            only={["acknowledge", "tune"]}
          />
          {/* Mark read and Resolve say what the operator did with the ALERT;
              this says what they are doing about the CONDITION. Two different
              questions, which is why filing does not touch the flag's own
              lifecycle: a task exists and the alert stays open until the
              condition clears. */}
          <FileTaskButton
            prefill={taskHandoffPrefill(alertTaskHandoff(item))}
            subject={alert.headline}
            variant="outline"
          />
          <Button asChild size="sm" variant="outline">
            <Link to={openSite(item.asset)}>Open {item.assetDisplayName}</Link>
          </Button>
        </>
      }
    >
      {/* One line of chips (bead `ro-ujb9.96.6.7`): the Evidence panel holds
          the rule's numbers, the checks behind the caption's verification, the
          stored message and the rule id — the caption already says Confirmed
          or Last known, so the opened row does not say it a second time. */}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <EvidencePopover
          evidence={alertPopoverEvidence(alert, item, nowMs)}
          question={ALERT_EVIDENCE_QUESTION}
          contextLabel={item.ruleId}
          nowMs={nowMs}
          triggerLabel="Evidence"
        />
        <ChangeChip
          changes={item.correlatedChanges}
          firedAt={item.firedAt}
          to={siteAddress(item.asset, "#timeline")}
          interactive
        />
      </span>
    </ListRow>
  );
}

/**
 * ONE ROW FOR ONE FACT, still actionable per asset (`ro-kukv.6`, decision D15).
 *
 * Four assets that have never reported are one condition, not four events, so
 * the row states it once and the four assets are behind its disclosure — which
 * is now the ListRow's own expansion rather than a `<details>` inside a table
 * cell. Each member keeps its own link, its own age and its own Mark read /
 * Resolve, so nothing an operator could do before is taken away.
 *
 * WHAT IS DELIBERATELY ABSENT. No recurrence chip: `occurrences` here counts
 * ASSETS, and the chip's whole meaning is "this condition re-fired N times".
 * And no File task — there is no single firing for a task to name, so work on a
 * portfolio-wide condition is one task the operator writes, not four the page
 * guesses at.
 *
 * The age is the oldest member's recorded first-seen time, not evidence that
 * every member's condition stayed true continuously.
 */
function GroupedAlertRow({ item, nowMs }: { item: AttentionItem; nowMs: number }) {
  const alert = translateAlert(item);
  const openSite = useSitePath();
  const members = item.members ?? [];
  return (
    <ListRow
      tone={item.severity}
      glyph="△"
      // No asset tag: a grouped row HAS no single asset, and printing the
      // representative's name would attribute the portfolio's fact to one of
      // its four members.
      title={<span title={memberNames(item)}>{alert.headline}</span>}
      caption={<>
        <AlertVerification verification={item.verification} firstDetectedAt={item.firstFiredAt} nowMs={nowMs} interactive={false} />
        {` · ${alert.hint ?? memberNames(item) ?? "Grouped assets"}`}
      </>}
      value={formatAge(ageMs(nowMs, item.firstFiredAt))}
      valueLabel="first seen"
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <EvidencePopover
          evidence={alertPopoverEvidence(alert, item, nowMs)}
          question={ALERT_EVIDENCE_QUESTION}
          contextLabel={item.ruleId}
          nowMs={nowMs}
          triggerLabel="Evidence"
        />
      </span>
      <span className="flex flex-col gap-1.5" data-attention-group={item.ruleId}>
        {members.map((member) => (
          <span
            key={member.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
            data-attention-group-member={member.asset}
          >
            <Drill interactive to={openSite(member.asset)} className="font-medium">
              {member.assetDisplayName}
            </Drill>
            <span className="tabular-nums text-muted-foreground">
              First seen {formatAge(ageMs(nowMs, member.firedAt))} ago
            </span>
            <AlertVerification verification={member.verification} firstDetectedAt={member.firedAt} nowMs={nowMs} />
            <FlagActions flagId={member.id} assetId={member.asset} />
          </span>
        ))}
      </span>
    </ListRow>
  );
}

/**
 * WHAT THE OPERATOR PUT OFF, and until when (bead `ro-c7qq`).
 *
 * A snooze that produced no visible row would be a mute with a friendlier name.
 * So every parked condition stays under the Open list with the date it comes
 * back and an **Unsnooze** that ends the wait now — in the row's expansion,
 * like every other verb on this page.
 *
 * IT BELONGS TO OPEN, not History. A snoozed alert is not settled — nobody
 * decided anything about the condition, they deferred it, and the store agrees:
 * `worker/flag-scope.ts` hands the same row back on its date. Filing it under
 * History would be the page claiming a decision the operator has not made.
 *
 * BELOW the list and never merged into it: a parked row is not asking for
 * anything yet, and one list holding both would put the count the operator
 * reads first out of reach. Absent entirely when nothing is parked — "Snoozed
 * (0)" is a heading about a thing that has not happened.
 *
 * It ignores the filters above on purpose. Those narrow what needs attention
 * NOW; this is the standing ledger of what was silenced, and a ledger a
 * dropdown can shorten is a ledger that can hide the row it was set to hide.
 *
 * WIDER THAN THE LIST ABOVE (bead `ro-w13s`). Open attention is error/warn;
 * this lists EVERY parked row, info and milestone included, because Snooze is
 * offered on every open row of the asset page's state hero and a ledger that
 * dropped those would hide precisely what the operator silenced.
 */
function SnoozedAlerts({ items, nowMs }: { items: SnoozedItem[]; nowMs: number }) {
  if (items.length === 0) return null;
  return (
    <div data-snoozed-alerts>
      <ListPanel
        title="Snoozed"
        count={`${items.length} parked`}
        limit={items.length}
      >
        {items.map((item) => (
          <ListRow
            key={item.id}
            // A parked row is not asking for anything, so it wears the muted
            // mark whatever its severity — the ledger's job is to be findable,
            // not loud. What it WAS is in the expansion with the way back.
            tone="info"
            glyph="◦"
            title={
              <>
                <AssetTag id={item.asset} displayName={item.assetDisplayName} />
                {translateAlert(item).headline}
              </>
            }
            caption={<>
              <AlertVerification verification={item.verification} firstDetectedAt={item.firstFiredAt} nowMs={nowMs} interactive={false} />
              {" · "}<SnoozeUntil until={item.snoozeUntil} nowMs={nowMs} />
            </>}
            value={formatAge(ageMs(nowMs, item.firstFiredAt))}
            valueLabel="first seen"
            actions={<FlagActions flagId={item.id} assetId={item.asset} snoozed />}
          >
            <span
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
              data-flag-severity={item.severity}
              data-visual-state="snoozed"
            >
              <EvidencePopover
                evidence={alertPopoverEvidence(translateAlert(item), item, nowMs)}
                question={ALERT_EVIDENCE_QUESTION}
                contextLabel={item.ruleId}
                nowMs={nowMs}
                triggerLabel="Evidence"
              />
            </span>
          </ListRow>
        ))}
      </ListPanel>
    </div>
  );
}

// --- History ----------------------------------------------------------------
/**
 * WHAT ALREADY CLOSED, across the portfolio (bead `ro-ju7f`).
 *
 * Every row is `AlertRow` in its settled mode — the same component an asset's
 * own Alerts tab renders over the same `FlagRecord`, plus the one thing a
 * portfolio surface owes and an asset page does not: WHICH ASSET, as its
 * favicon and a link into that asset's Alerts tab.
 *
 * IT IS `AlertRow`, AND `AlertRow` IS NOW A `ListRow` TOO (bead `ro-78qo.17`).
 * Doc 21 wants the settled row in the same shape as the open one; the fold
 * happened in the component rather than here, so this surface, the asset page's
 * Current signals and its Alert history all draw one alert one way. Rewriting
 * the row HERE would have left two settled-alert renderings, which is the very
 * thing that bead exists to end.
 *
 * It reads `/api/alerts/history`, not the wall payload: the wall payload is
 * what a television polls every 60 seconds, and a paged archive has no business
 * riding along with it.
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

  /**
   * The URL asked for a page this archive cannot read (bead `ro-oefa`).
   *
   * Not the same event as a store that failed, and it used to be neither: a
   * corrupted `?offset=` was silently dropped and the reader got page one,
   * which looks exactly like the page a working link lands on. `/api/financials`
   * had already decided this for a malformed `?period=`; this is the same
   * answer for the same class of input.
   */
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
        // Where in the archive the reader is: a fact, never folded. Every number
        // in it is the ANSWERED page's own, so while the next page loads it
        // still describes the rows on screen (bead `ro-ujb9.196`).
        aside={data && !refusedPage ? <HistoryRange offset={data.offset} rows={data.rows.length} total={data.total} /> : null}
      >
        {assets.length > 1 || query.asset !== null ? (
          <>
            <label className="sr-only" htmlFor="alert-history-asset">
              Site
            </label>
            <select
              id="alert-history-asset"
              className={fieldClass}
              value={query.asset ?? "all"}
              // A filter change puts the reader back on the first page: page 4 of
              // one asset's history is page 4 of a list that no longer exists.
              onChange={(event) => setFilter("asset", event.target.value, ["offset"])}
            >
              <option value="all">Every site</option>
              {assets.map((card) => (
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

        {/* The range badge (the bar's aside) states WHERE IN THE ARCHIVE the
            reader is, so it has nothing true to say about a page that does not
            exist — and with `keepPreviousData` the last good page's numbers
            would still be sitting in `data` (bead `ro-oefa`); every number in
            it is the answered page's own (bead `ro-ujb9.196`). */}
      </FilterBar>

      {refusedPage ? (
        <MalformedPage
          {...refusedPage}
          onFirstPage={() => setFilter("offset", "", ["limit"])}
        />
      ) : isError ? (
        <ReadFailed title="Couldn't load alert history" subject="read:alert-history" error={error} retrying={isFetching} onRetry={() => void refetch()} />
      ) : !data ? (
        <div className="grid min-h-[30vh] place-items-center text-muted-foreground">Loading…</div>
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
 * A `?offset=`/`?limit=` this archive cannot read (bead `ro-oefa`).
 *
 * The mirror of `/financials`'s `MissingPeriod`, down to the shape: a heading
 * that quotes back the value the link actually carried, one line saying how much
 * there is to page through, and the way out. No card — a designed state, not a
 * container (doc 14).
 *
 * The way out is a BUTTON rather than a link because this page's other move
 * between pages is a button (Newer / Older), and it clears both page params at
 * once so a URL that got `limit` wrong is not left carrying it.
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
 * WHICH SLICE OF WHAT — the archive's one count, stated once.
 *
 * `1–25 of 137` rather than a bare total, because the operator paging through
 * an archive needs to know where they are in it, and a total with no position
 * leaves the Older button meaning nothing.
 *
 * ALL THREE NUMBERS COME FROM ONE ANSWER (bead `ro-ujb9.196`). The offset used
 * to be the URL's while the count and total were the answer's, and while the
 * next page loaded — `keepPreviousData` holds the last page on screen — that
 * read "126–150 of 137", a range that cannot exist.
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
