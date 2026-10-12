import { Tabs, type TabSpec } from "@/components/Tabs";

/** The Settings tabs, in reading order: what every installation sets first,
 * then how alerts judge, how data arrives, the TV, who owns what, where tasks
 * live, and the host. `general` is the index tab: `/settings` is General. */
export const SETTINGS_TABS = [
  "general",
  "alert-rules",
  "data-collection",
  "tv-dashboard",
  "ownership",
  "task-projects",
  "installation",
  "members",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABEL: Record<SettingsTab, string> = {
  general: "General",
  "alert-rules": "Alert rules",
  "data-collection": "Data collection",
  "tv-dashboard": "TV dashboard",
  ownership: "Ownership",
  "task-projects": "Task projects",
  installation: "Installation",
  members: "Members",
};

export const SETTINGS_TAB_IDS = "settings-tab";

export const SETTINGS_TAB_PANEL_ID = "settings-tab-panel";

/** The URL of one tab. General is the bare `/settings`. */
export function settingsPath(tab: SettingsTab): string {
  return tab === "general" ? "/settings" : `/settings/${tab}`;
}

/** A URL segment → the tab it names, among the tabs this installation shows.
 * Anything else reads as General: a mistyped tab is still Settings. */
export function settingsTabFromParam(
  param: string | undefined,
  shown: readonly SettingsTab[],
): SettingsTab {
  return (shown as readonly string[]).includes(param ?? "") ? (param as SettingsTab) : "general";
}

/**
 * The page's addresses from before it had tabs, when each section was a hash
 * on `/settings`. Filed tasks, bookmarks and older builds still carry them, so
 * each one keeps landing on the tab that holds its section now.
 */
const SECTION_TAB: Readonly<Record<string, SettingsTab>> = {
  general: "general",
  "alert-rules": "alert-rules",
  "data-collection": "data-collection",
  // Schedules are rows of Data collection.
  "scheduled-jobs": "data-collection",
  "tv-dashboard": "tv-dashboard",
  entities: "ownership",
  "task-hub": "task-projects",
  installation: "installation",
  members: "members",
};

/** Rows with an anchor of their own: the hash is kept, so the row scrolls into
 * view once its tab is open. */
const ROW_TAB: Readonly<Record<string, SettingsTab>> = { clock: "general", budget: "general" };

/**
 * Where an address with a hash belongs, or null when it is already there. An
 * old section hash moves to its tab, a row's hash to the tab that draws the
 * row, and the data-source catalog, which ships with the product rather than
 * being a setting, to Integrations.
 */
export function settingsHashDestination(hash: string, tab: SettingsTab): string | null {
  const id = hash.slice(1);
  if (id === "data-sources") return "/integrations";
  const section = SECTION_TAB[id];
  if (section !== undefined) return settingsPath(section);
  const row = ROW_TAB[id];
  return row !== undefined && row !== tab ? `${settingsPath(row)}${hash}` : null;
}

/** The tab bar: the desk's one way of sectioning a page, the same component a
 * site's page uses. */
export function SettingsTabs({ shown }: { shown: readonly SettingsTab[] }) {
  const tabs: TabSpec[] = shown.map((key) => ({
    key,
    to: settingsPath(key),
    label: TAB_LABEL[key],
    end: key === "general",
  }));
  return (
    <Tabs
      label="Settings sections"
      tabs={tabs}
      idBase={SETTINGS_TAB_IDS}
      panelId={SETTINGS_TAB_PANEL_ID}
    />
  );
}
