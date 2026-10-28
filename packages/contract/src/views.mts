/**
 * Purpose views set emphasis while retaining every navigation entry, asset
 * tab and technical evidence. One registry read by the Tower, by the
 * config pipeline (the workspace default is a config document) and by the
 * tests. A view changes what is drawn first and never what is collected,
 * how outcomes are measured, or what another person sees.
 */

export const VIEW_IDS = ["overview", "growth", "revenue", "delivery", "reliability"] as const;
export const LEGACY_VIEW_IDS = ["business", "product", "everything"] as const;
export type LegacyViewId = (typeof LEGACY_VIEW_IDS)[number];
export type StoredViewId = ViewId | LegacyViewId;
export type ViewId = (typeof VIEW_IDS)[number];

/** What a fresh installation shows before anyone answers the question, and
 * what an existing installation uses until a purpose is chosen. */
export const DEFAULT_VIEW: ViewId = "overview";

/** The sidebar entries, by path, in the sidebar's order. */
export const VIEW_NAV_PATHS = [
  "/",
  "/workflows",
  "/assets",
  "/alerts",
  "/tasks",
  "/agents",
  "/financials",
  "/health",
  "/integrations",
  "/settings",
] as const;
export type ViewNavPath = (typeof VIEW_NAV_PATHS)[number];

/** Home's modules. The first seven, in this order, are what the Overview
 * view draws; the rest are drawn only by the views that name them. */
export const HOME_MODULES = [
  "money",
  "yesterday",
  "agents",
  "decide",
  "problems",
  "sites",
  "timeline",
  "health",
  "factory",
  "channels",
  "gaps",
] as const;
export type HomeModuleId = (typeof HOME_MODULES)[number];

/** The site page's tabs, in the Overview view's order. */
export const SITE_TABS = [
  "overview",
  "growth",
  "journeys",
  "financials",
  "search",
  "codebase",
  "health",
  "alerts",
  "tasks",
  "activity",
  "sources",
  "settings",
] as const;
export type SiteTabId = (typeof SITE_TABS)[number];

/** The word level a surface may use (docs/14 Lexicon): a business surface
 * uses money, people and verdict words only; an operational one may add
 * alert, run and shipped; a technical one may name providers and jobs. */
export type WordLevel = "business" | "operational" | "technical";

/** What a person says matters most. Each pick moves one Home module to the
 * front of the view's list; it adds nothing the view does not already draw. */
export const FOCUS_IDS = ["money", "visitors", "site-health", "agents", "costs"] as const;
export type FocusId = (typeof FOCUS_IDS)[number];

export interface FocusSpec {
  id: FocusId;
  label: string;
  /** One line under the label on the onboarding step. */
  detail: string;
  /** The Home module the pick moves to the front. */
  module: HomeModuleId;
}

export const FOCUS_LIBRARY: readonly FocusSpec[] = [
  { id: "money", label: "Money", detail: "this month, and where it comes from", module: "money" },
  { id: "visitors", label: "Visitors", detail: "how many, and how they found you", module: "sites" },
  { id: "site-health", label: "Asset health", detail: "up, fast, error-free, well built", module: "health" },
  { id: "agents", label: "The agents' work", detail: "what they built, and whether it worked", module: "factory" },
  { id: "costs", label: "Costs", detail: "what running it all costs", module: "money" },
];

export interface ViewSpec {
  id: ViewId;
  /** The choice as the person says it. */
  label: string;
  /** One line under the label on the onboarding step and in Settings. */
  detail: string;
  nav: readonly ViewNavPath[];
  home: readonly HomeModuleId[];
  siteTabs: readonly SiteTabId[];
  wordLevel: WordLevel;
}

const PURPOSE_VIEWS: readonly Pick<ViewSpec, "id" | "label" | "detail" | "home">[] = [
  { id: "overview", label: "Overview", detail: "Review performance, work and decisions.",
    home: ["money", "yesterday", "agents", "decide", "problems", "sites", "timeline"] },
  { id: "growth", label: "Growth", detail: "Find opportunities to reach and keep visitors.",
    home: ["channels", "yesterday", "gaps", "problems", "decide", "sites"] },
  { id: "revenue", label: "Revenue", detail: "Review earnings, costs and financial opportunities.",
    home: ["money", "problems", "decide", "sites", "timeline"] },
  { id: "delivery", label: "Delivery", detail: "Review work, progress and results.",
    home: ["factory", "decide", "agents", "problems", "timeline"] },
  { id: "reliability", label: "Reliability", detail: "Review health, failures and recovery.",
    home: ["health", "problems", "decide", "timeline"] },
];

export const VIEW_LIBRARY: readonly ViewSpec[] = PURPOSE_VIEWS.map((spec) => ({
  ...spec, nav: [...VIEW_NAV_PATHS], siteTabs: [...SITE_TABS], wordLevel: "technical",
}));

/** Legacy identities have no equivalent purpose; all begin at Overview. */
export function normalizeViewId(value: unknown): ViewId {
  return isViewId(value) ? value : DEFAULT_VIEW;
}

export function isStoredViewId(value: unknown): value is StoredViewId {
  return isViewId(value) || (typeof value === "string" && (LEGACY_VIEW_IDS as readonly string[]).includes(value));
}

export function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

export function isFocusId(value: unknown): value is FocusId {
  return typeof value === "string" && (FOCUS_IDS as readonly string[]).includes(value);
}

export function viewSpec(id: ViewId): ViewSpec {
  const spec = VIEW_LIBRARY.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`Unknown view: ${id}`);
  return spec;
}

/** A person's answer: the view and what matters most, in the order picked. */
export interface ViewChoice {
  view: ViewId;
  focus: readonly FocusId[];
  /** Read-only migration signal; never serialized into a new preference. */
  needsPurposeChoice?: true;
}

export const DEFAULT_VIEW_CHOICE: ViewChoice = Object.freeze({ view: DEFAULT_VIEW, focus: [] });

/**
 * A stored choice, read back: `{ "view": "revenue", "focus": ["money"] }`.
 * Anything else reads as nothing stored, never as a guess; an unknown focus
 * is dropped, an unknown view refuses the whole choice.
 */
export function parseViewChoice(value: unknown): ViewChoice | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isStoredViewId(record.view)) return null;
  const focus: FocusId[] = [];
  if (Array.isArray(record.focus)) {
    for (const one of record.focus) if (isFocusId(one) && !focus.includes(one)) focus.push(one);
  } else if (record.focus !== undefined) {
    return null;
  }
  return { view: normalizeViewId(record.view), focus,
    ...(record.view === "business" || record.view === "product" || record.needsPurposeChoice === true ? { needsPurposeChoice: true as const } : {}) };
}

/** The stored form of a choice, one line, keys in a fixed order. */
export function serializeViewChoice(choice: ViewChoice): string {
  return JSON.stringify({ view: choice.view, focus: [...choice.focus] });
}

/**
 * Home's modules for a choice: the view's list, with the modules the picks
 * name moved to the front in the order picked. A pick naming a module the
 * view does not draw changes nothing.
 */
export function homeModulesFor(choice: ViewChoice): HomeModuleId[] {
  const base = viewSpec(choice.view).home;
  const promoted: HomeModuleId[] = [];
  for (const focus of choice.focus) {
    const module = FOCUS_LIBRARY.find((spec) => spec.id === focus)?.module;
    if (module !== undefined && base.includes(module) && !promoted.includes(module)) promoted.push(module);
  }
  return [...promoted, ...base.filter((module) => !promoted.includes(module))];
}

/** Where a hosted person's own choice is read and saved (GET and PUT, one
 * `ViewChoice` body). Standalone keeps the choice in the browser instead. */
export const VIEW_PREFERENCE_PATH = "/api/me/preferences/view";

/** The pointer in `config/tower.json` holding the workspace's default view. */
export const WORKSPACE_VIEW_POINTER = "/view";

/** The workspace's default view as the document holds it: `{ "default": <id> }`. */
export interface WorkspaceViewConfig {
  default: StoredViewId;
}

/** A present `/view`, read whole: well formed, or refused with the reason. */
export function parseWorkspaceView(value: unknown): WorkspaceViewConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config/tower.json view, when present, must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "default") throw new Error(`config/tower.json view.${key} is not a setting`);
  }
  if (!isStoredViewId(record.default)) {
    throw new Error(`config/tower.json view.default must be one of ${VIEW_IDS.join(", ")}`);
  }
  return { default: record.default };
}

/** Why a `/view` write is refused, in one line, or null when it is accepted. */
export function workspaceViewRefusal(value: unknown): string | null {
  try {
    parseWorkspaceView(value);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
