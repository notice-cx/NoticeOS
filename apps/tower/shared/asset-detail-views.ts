import type { AssetDetailPayload, WatchSlice } from "./asset-detail";

/**
 * One read per tab. Each tab polls a view: the page's core (header, tab-bar
 * counts, config facts no store read is spent on) plus the sections that tab
 * draws, built at one `now` so everything on screen agrees.
 *
 * A view carries a section in full or not at all, never an empty stand-in,
 * because an empty list always means "looked, found none"; `viewCovers` tells
 * the two apart. `AssetDetailFor<V>` makes the compiler reject a tab that reads
 * outside its view.
 */

/** The asset page's tabs, in the same order as `ASSET_TABS`
 * (src/routes/asset-detail/AssetTabs.tsx). `test/asset-detail-payload.test.ts`
 * keeps the two lists equal. */
export const ASSET_DETAIL_VIEWS = [
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

export type AssetDetailView = (typeof ASSET_DETAIL_VIEWS)[number];

/** The anchor of an archived site's Restore card on its Settings tab: where
 * Add a site's "Already added" opens an archived site. */
export const RESTORE_HASH = "#restore";

/** The payload fields each section supplies. */
interface SectionFields {
  /** The 90-day provider trends (the heaviest read on the page). */
  performance: Pick<AssetDetailPayload, "performance">;
  /** The saved analysis and its source attempts. */
  executive: Pick<AssetDetailPayload, "executive" | "recommendationEvidence">;
  /** The 30 newest nightly reports, per metric. */
  metrics: Pick<AssetDetailPayload, "metrics">;
  /** The site's all-time totals, resolved against its counter readings. */
  counters: Pick<AssetDetailPayload, "counters">;
  /** Period totals and the 20 most recent ledger rows. */
  ledger: Pick<AssetDetailPayload, "ledger">;
  dailyRevenue: Pick<AssetDetailPayload, "dailyRevenue">;
  decisions: Pick<AssetDetailPayload, "decisions">;
  /** Everything read off one task-hub snapshot, kept together so the inbox,
   * the handoff markers and the review marker cannot disagree. */
  tasks: Pick<AssetDetailPayload, "handoffBeads" | "operator" | "panelReview" | "latestPanelDate">;
  annotations: Pick<AssetDetailPayload, "annotations">;
  /** The watch composer's calibration series. Only the open and closed lists
   * are core; this is the part that costs a 90-day observation read. */
  watchHistory: { watches: Pick<WatchSlice, "history"> };
  reclamation: Pick<AssetDetailPayload, "reclamation">;
  hygiene: Pick<AssetDetailPayload, "hygiene">;
  /** The site's recent failed nightly-report fetches. */
  fetchFailures: Pick<AssetDetailPayload, "fetchFailures">;
}

export type AssetDetailSection = keyof SectionFields;

/** Which sections each tab draws. `AssetDetailFor<V>` is derived from this. */
export const ASSET_VIEW_SECTIONS = {
  overview: ["performance", "executive", "metrics", "counters", "ledger", "dailyRevenue", "decisions", "tasks", "annotations"],
  growth: ["performance", "executive", "decisions", "tasks", "annotations"],
  financials: ["ledger", "dailyRevenue"],
  // `performance`: until a site tracks terms, its Search tab leads with its
  // search clicks and impressions.
  search: ["performance", "executive", "decisions", "tasks", "annotations"],
  alerts: [],
  tasks: [],
  activity: ["annotations", "watchHistory", "reclamation", "tasks"],
  sources: ["metrics", "hygiene", "fetchFailures"],
  settings: ["annotations"],
} as const satisfies Record<AssetDetailView, readonly AssetDetailSection[]>;

/** The top-level payload fields a section owns outright, for the runtime check. */
export const ASSET_SECTION_FIELDS: { [S in AssetDetailSection]: readonly (keyof AssetDetailPayload)[] } = {
  performance: ["performance"],
  executive: ["executive", "recommendationEvidence"],
  metrics: ["metrics"],
  counters: ["counters"],
  ledger: ["ledger"],
  dailyRevenue: ["dailyRevenue"],
  decisions: ["decisions"],
  tasks: ["handoffBeads", "operator", "panelReview", "latestPanelDate"],
  annotations: ["annotations"],
  watchHistory: [],
  reclamation: ["reclamation"],
  hygiene: ["hygiene"],
  fetchFailures: ["fetchFailures"],
};

/** Every section: what the whole page carries. */
export const ALL_ASSET_DETAIL_SECTIONS = Object.keys(ASSET_SECTION_FIELDS) as AssetDetailSection[];

type SectionKey = { [S in AssetDetailSection]: keyof SectionFields[S] }[AssetDetailSection];

/** What every view carries. */
export type AssetDetailCore = Omit<AssetDetailPayload, SectionKey> & {
  watches: Omit<WatchSlice, "history">;
};

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

/** The payload one tab is drawn from: the core plus exactly its sections. */
export type AssetDetailFor<V extends AssetDetailView> = AssetDetailCore &
  UnionToIntersection<SectionFields[(typeof ASSET_VIEW_SECTIONS)[V][number]]>;

/** What `GET /api/assets/:id` answers: the whole page (no `view`), or one tab's
 * view, which carries only its own sections. */
export type AssetDetailResponse = AssetDetailCore &
  Partial<Omit<AssetDetailPayload, keyof AssetDetailCore>> & {
    watches: Partial<Pick<WatchSlice, "history">>;
    /** The tab this read was cut for. Absent or null: the whole page. */
    view?: AssetDetailView | null;
  };

export function isAssetDetailView(value: string | null | undefined): value is AssetDetailView {
  return (ASSET_DETAIL_VIEWS as readonly string[]).includes(value ?? "");
}

/** Distributes over a union, so a check against "one of these tabs" never
 * claims the sections of all of them. */
type CoveredView<V> = V extends AssetDetailView ? AssetDetailFor<V> : never;

/** Whether a read can draw this tab: the whole page can draw any tab; a view
 * can draw every tab whose sections it carries, whichever tab it was cut for. */
export function viewCovers<V extends AssetDetailView>(
  payload: AssetDetailResponse,
  view: V,
): payload is AssetDetailResponse & CoveredView<V> {
  if (payload.view === undefined || payload.view === null || payload.view === view) return true;
  return ASSET_VIEW_SECTIONS[view].every((section: AssetDetailSection) =>
    section === "watchHistory"
      ? Array.isArray(payload.watches.history)
      : ASSET_SECTION_FIELDS[section].every((key) => key in payload),
  );
}
