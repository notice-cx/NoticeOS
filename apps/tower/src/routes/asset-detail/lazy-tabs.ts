import { lazyPart } from "@/lib/lazy-route";
import type { AssetTab } from "@/routes/asset-detail/AssetTabs";

/**
 * EACH ASSET TAB IS ITS OWN FILE (bead `ro-ujb9.84`).
 *
 * After the route split (`ro-82x`) the asset page was the heaviest first load in
 * the Tower, because its one file carried all nine tabs — the Growth charts, the
 * Search boards, the Settings editors, the Activity composer — to draw whichever
 * one the address named. Each tab now arrives when it is opened; the page's own
 * file keeps what every tab shares (the header, the tab bar, the payload read,
 * the deep-link handling).
 *
 * Every tab goes through `lazyPart`, Overview included: a deep link into Growth
 * or Settings should not download the Overview it is not showing, and the page
 * starts fetching the tab it is about to show while the asset's report is still
 * on its way (`AssetDetailRoute`), so the default tab costs no extra wait.
 *
 * A static import of a tab module from `AssetDetailRoute.tsx` puts that tab back
 * into every asset page's first download; `test/lazy-parts.test.tsx` refuses one.
 */
const overview = lazyPart(() =>
  import("@/routes/asset-detail/OverviewTab").then((module) => module.OverviewTab),
);
const growth = lazyPart(() =>
  import("@/routes/asset-detail/GrowthTab").then((module) => module.GrowthTab),
);
const financials = lazyPart(() =>
  import("@/routes/asset-detail/FinancialsTab").then((module) => module.FinancialsTab),
);
const search = lazyPart(() =>
  import("@/routes/asset-detail/SearchTab").then((module) => module.SearchTab),
);
const alerts = lazyPart(() =>
  import("@/routes/asset-detail/AlertsTab").then((module) => module.AlertsTab),
);
const tasks = lazyPart(() =>
  import("@/routes/asset-detail/TasksTab").then((module) => module.TasksTab),
);
const activity = lazyPart(() =>
  import("@/routes/asset-detail/ActivityTab").then((module) => module.ActivityTab),
);
const sources = lazyPart(() =>
  import("@/routes/asset-detail/SourcesTab").then((module) => module.SourcesTab),
);
const settings = lazyPart(() =>
  import("@/routes/asset-detail/SettingsTab").then((module) => module.AssetSettingsPanel),
);

export const OverviewTab = overview.Component;
export const GrowthTab = growth.Component;
export const FinancialsTab = financials.Component;
export const SearchTab = search.Component;
export const AlertsTab = alerts.Component;
export const TasksTab = tasks.Component;
export const ActivityTab = activity.Component;
export const SourcesTab = sources.Component;
export const AssetSettingsPanel = settings.Component;

const PRELOAD: Record<AssetTab, () => Promise<boolean>> = {
  overview: overview.preload,
  growth: growth.preload,
  financials: financials.preload,
  search: search.preload,
  alerts: alerts.preload,
  tasks: tasks.preload,
  activity: activity.preload,
  sources: sources.preload,
  settings: settings.preload,
};

/**
 * Fetch one tab's code before it is drawn — when a pointer rests on its tab or
 * the keyboard focuses it, and for the tab a page is about to show. True once
 * the code is here, false if it could not be fetched; never rejects — drawing
 * the tab is what decides what a failure means (`lazyPart`).
 */
export function preloadAssetTab(tab: AssetTab): Promise<boolean> {
  return PRELOAD[tab]();
}
