import { UserRoundCheck } from "lucide-react";
import { useLocation } from "react-router-dom";
import { type AssetDetailCore, RESTORE_HASH } from "@shared/asset-detail-views";
import { sourceReadings, sourcesSummary } from "@shared/connection-status";
import { SeverityDot } from "@/components/SeverityDot";
import { Tabs, type TabSpec } from "@/components/Tabs";
import { useConnections } from "@/hooks/useConnections";
import { useWork } from "@/hooks/useWork";
import { DEFAULT_RANGE, rangeFromParam } from "./useRange";

// --- the tabs --------------------------------------------------------------
/** The asset tabs, in the operator's reading order: what state is this asset
 * in, which way the numbers went, which term and page, what is wrong, what is
 * being done, what has happened, where the numbers come from, how it is set
 * up. `overview` is the index tab: it has no segment of its own, so
 * `/assets/:id` is the Overview. */
export const ASSET_TABS = [
  "overview",
  "growth",
  "financials",
  "search",
  "alerts",
  "tasks",
  "activity",
  "sources",
  "settings",
] as const;

export type AssetTab = (typeof ASSET_TABS)[number];

const TAB_LABEL: Record<AssetTab, string> = {
  overview: "Overview",
  growth: "Growth",
  financials: "Money",
  search: "Search",
  alerts: "Alerts",
  tasks: "Tasks",
  activity: "Activity",
  sources: "Data sources",
  settings: "Settings",
};

export const TAB_IDS = "asset-tab";

export const TAB_PANEL_ID = "asset-tab-panel";

/** The URL of one tab on one asset. Overview is the bare asset URL. */
export function tabPath(assetId: string, tab: AssetTab, search = ""): string {
  const base = `/assets/${encodeURIComponent(assetId)}`;
  const path = tab === "overview" ? base : `${base}/${tab}`;
  const days = rangeFromParam(new URLSearchParams(search).get("range"));
  // Only the shared time window travels. Task filters and form state belong
  // to the tab that owns them, not to the next destination.
  return days === DEFAULT_RANGE ? path : `${path}?range=${days}`;
}

export function useAssetTabPath() {
  const { search } = useLocation();
  return (assetId: string, tab: AssetTab) => tabPath(assetId, tab, search);
}

/** A URL segment the router handed us → a tab. Anything unrecognized reads as
 * Overview: a mistyped tab is still an asset the operator asked for. */
export function tabFromParam(param: string | undefined): AssetTab {
  return (ASSET_TABS as readonly string[]).includes(param ?? "")
    ? (param as AssetTab)
    : "overview";
}

/**
 * Where a deep link lands: the hash→tab map. A section only exists while its
 * tab is mounted, so a hash selects the tab first (a `replace` navigation, so
 * Back still leaves the page) and the scroll happens once that panel has
 * rendered. A hash that is not in here is left alone.
 */
export const HASH_TAB: Record<string, AssetTab> = {
  "#setup": "overview",
  "#insights": "overview",
  "#growth-evidence": "growth",
  "#performance": "growth",
  "#search-performance": "growth",
  "#panel-scoreboard": "growth",
  "#product-use": "growth",
  // Anchors linked from a task page's "where this came from" and from saved
  // bookmarks keep resolving whichever tab their section is on now; a hash
  // that stopped working would be a broken link on every task ever filed from
  // a decision row.
  "#search-evidence": "search",
  "#serp-panel": "search",
  "#query-visibility": "search",
  "#page-decisions": "search",
  "#search-context": "search",
  // The panel's register editors are on Settings, so the hash follows them.
  "#tracked-panels": "settings",
  // The nightly report's address and its No report switch, where the setup
  // checklist's optional "Nightly report" step lands.
  "#data-collection": "settings",
  "#alerts": "alerts",
  "#alert-history": "alerts",
  "#tasks": "tasks",
  "#timeline": "activity",
  "#pnl": "financials",
  "#ledger": "financials",
  "#details": "sources",
  "#integrations": "sources",
  "#configuration": "settings",
  // An archived site's Restore card: where Add a site's "Already added" lands
  // when the site holding the domain is archived.
  [RESTORE_HASH]: "settings",
};

/** Saved anchors whose evidence now has a different section name. */
export const HASH_ANCHOR: Readonly<Record<string, string>> = {
  "#details": "integrations",
};

// --- the tab bar -----------------------------------------------------------
/**
 * The asset page's tabs, each carrying its own state: Alerts how many are
 * open and how bad the worst one is, Tasks how many are open here and whether
 * any is waiting on the operator, Activity how many outcome checks are still
 * running, Sources how much of the evidence is working. A tab with nothing to
 * say carries nothing. The Tasks count comes from the task-hub snapshot
 * (`useWork`), not from the asset payload: tasks are coordination state and
 * never enter the pulse envelope. An asset with no spoke in
 * `config/beads.json` carries no count at all, because unknown is not zero.
 */
export function AssetTabs({
  data,
  assetId,
  nowMs,
  onPrefetch,
}: {
  data: AssetDetailCore;
  assetId: string;
  nowMs: number;
  /** Fetch a tab's code before it is opened: the page hands this in, since
   * the tab code is the page's to load, not the bar's. */
  onPrefetch?: (tab: AssetTab) => void;
}) {
  const pathFor = useAssetTabPath();
  const { data: work } = useWork();
  const { credentials, items } = useConnections();
  const openAlerts = data.flags.open.length;
  const openWatches = data.watches.open.length;
  const worst = data.asset.worstOpenSeverity;
  // `?? []` rather than a bare index: a snapshot that has never been filed, or
  // one written by a poller a generation behind, must leave the tab quiet rather
  // than crash the page around it.
  const spoke = (work?.projects ?? []).find((project) => project.asset === data.asset.id) ?? null;
  const openTasks = spoke?.ok ? spoke.counts.open : null;
  const waitingOnYou = spoke?.ok ? (spoke.counts.waiting ?? 0) : 0;

  const tabs: TabSpec[] = ASSET_TABS.map((key) => {
    const base: TabSpec = {
      key,
      to: pathFor(assetId, key),
      label: TAB_LABEL[key],
      end: key === "overview",
      onIntent: onPrefetch ? () => onPrefetch(key) : undefined,
    };
    if (key === "alerts" && openAlerts > 0) {
      return {
        ...base,
        count: openAlerts,
        glyph: <SeverityDot severity={worst} size="sm" />,
        title: `${openAlerts} open alert${openAlerts === 1 ? "" : "s"} on this site`,
      };
    }
    if (key === "tasks" && openTasks !== null && (openTasks > 0 || waitingOnYou > 0)) {
      return {
        ...base,
        count: openTasks,
        // The inbox glyph the board and Home already use for the same fact, in
        // the same warn register: the operator being the blocker is a call for
        // attention, not a failure. Shown only when something IS waiting, so a
        // queue nobody is blocked on stays a plain number.
        glyph:
          waitingOnYou > 0 ? (
            <UserRoundCheck className="size-3.5 shrink-0 text-warn" aria-hidden />
          ) : undefined,
        title:
          waitingOnYou > 0
            ? `${openTasks} open task${openTasks === 1 ? "" : "s"} — ${waitingOnYou} waiting on you`
            : `${openTasks} open task${openTasks === 1 ? "" : "s"} in this site's project`,
      };
    }
    if (key === "activity" && openWatches > 0) {
      return {
        ...base,
        count: openWatches,
        title: `${openWatches} ${openWatches === 1 ? "bet" : "bets"} being watched`,
      };
    }
    if (key === "sources") {
      // The pip is the worst source status the tab's own rows show: a failing
      // source red, an overdue one amber.
      const summary = sourcesSummary(sourceReadings(data.asset.id, data.integrations.sources, { credentials, items }, nowMs));
      return {
        ...base,
        glyph: summary.attention ? <SeverityDot severity={summary.attention} size="sm" /> : undefined,
        title: summary.tally || undefined,
      };
    }
    return base;
  });

  return (
    <Tabs
      label="Site sections"
      tabs={tabs}
      idBase={TAB_IDS}
      panelId={TAB_PANEL_ID}
    />
  );
}
