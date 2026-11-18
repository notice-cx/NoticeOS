import {
  ArrowDownUp,
  Bell,
  Bot,
  Globe,
  GitBranch,
  HeartPulse,
  House,
  LayoutDashboard,
  ListTodo,
  Plug,
  Settings,
  Tv,
  Wallet,
  UsersRound,
  Activity,
} from "lucide-react";
import type { ComponentType } from "react";

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Home only: without it, `/` matches every path and nothing else can be
   * the current page. */
  end?: boolean;
  /** Words the operator might type in the command palette that are not in the
   * label. Read by `CommandPalette` and by nothing else — the sidebar shows the
   * label and only the label, because a nav item with a synonym under it is a
   * nav item that failed to pick a word. */
  keywords?: string[];
}

/**
 * The assets index. Named because the sidebar renders the portfolio's rows
 * under this entry and finds it by identity; a string literal in a second file
 * would detach silently when the path changes.
 */
export const ASSETS_ROUTE = "/assets";
export const PORTFOLIO_MONEY_ROUTE = "/financials";

/**
 * The Integrations page. Named for the same reason as `ASSETS_ROUTE`: the
 * sidebar draws this entry with the expiry dot.
 */
export const INTEGRATIONS_ROUTE = "/integrations";

export const TASKS_ROUTE = "/tasks";

/** Who did the work; Tasks links here from its who's-working line. */
export const AGENTS_ROUTE = "/agents";

/**
 * The sidebar and command palette share these destinations. Keeping them here
 * lets the palette load independently of the shell that mounts it.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home", icon: House, end: true, keywords: ["overview", "desk", "start"] },
  {
    to: ASSETS_ROUTE,
    label: "Portfolio",
    icon: Globe,
    keywords: ["assets", "sites", "properties", "domains", "growth", "traffic", "journeys"],
  },
  { to: "/alerts", label: "Alerts", icon: Bell, keywords: ["flags", "attention", "warnings"] },
  { to: TASKS_ROUTE, label: "Tasks", icon: ListTodo, keywords: ["work", "queue", "ntasks", "todo"] },
  { to: "/workflows", label: "Workflows", icon: GitBranch, keywords: ["runbooks", "analysis", "automation", "runs", "delivery"] },
  { to: AGENTS_ROUTE, label: "Agents", icon: Bot, keywords: ["agents", "models", "velocity", "leaderboard", "who closed"] },
  {
    to: "/health",
    label: "System health",
    icon: HeartPulse,
    // Not "integrations": that word belongs to its own page.
    keywords: ["sources", "connections", "unblock", "reliability"],
  },
  {
    to: INTEGRATIONS_ROUTE,
    label: "Integrations",
    icon: Plug,
    keywords: ["integrations", "connected accounts", "connect", "credentials", "api key", "providers", "secrets"],
  },
];

export const SETTINGS_ITEM: NavItem = {
  to: "/settings", label: "Settings", icon: Settings, keywords: ["workspace settings", "configuration", "preferences", "notifications"],
};

const PORTFOLIO_MONEY_ITEM: NavItem = {
  to: PORTFOLIO_MONEY_ROUTE, label: "Money", icon: Wallet, keywords: ["portfolio", "revenue", "cost", "ledger", "financials", "p&l"],
};

/**
 * The television renders outside the desk shell. Its entry sits in the
 * sidebar's footer and in the palette's page list.
 */
export const TV_ITEM: NavItem = {
  to: "/wall",
  label: "TV dashboard",
  icon: Tv,
  keywords: ["wall", "television", "kiosk"],
};

/**
 * Where the television's layout is arranged. Not a sidebar entry of its own:
 * it is reached from the Edit beside the sidebar's TV dashboard entry, from
 * Settings and from the palette, and never from the television itself.
 */
export const TV_EDIT_ITEM: NavItem = {
  to: "/wall/edit",
  label: "Edit the TV layout",
  icon: LayoutDashboard,
  keywords: ["wall", "widgets", "arrange", "rows", "layout", "rearrange"],
};

/**
 * The Sites page with Arrange open: the sites' order by drag, and each site's
 * switches for where it shows. Reached from the Sites page, Settings, a
 * site's Settings tab, the TV editor and the palette.
 */
export const SITES_ARRANGE_PARAM = "arrange";

export const SITES_ARRANGE_ITEM: NavItem = {
  to: `${ASSETS_ROUTE}?${SITES_ARRANGE_PARAM}=1`,
  label: "Arrange the assets",
  icon: ArrowDownUp,
  keywords: ["order", "reorder", "drag", "hide", "show", "sites", "tv"],
};

export const MEMBERS_ITEM: NavItem = {
  to: "/settings/members", label: "Members", icon: UsersRound, keywords: ["invite", "people", "team", "roles", "permissions"],
};
const OPERATIONS_ITEM: NavItem = {
  to: "/health/operations", label: "Background operations", icon: Activity, keywords: ["jobs", "schedules", "collection", "sync history"],
};

/** Every page the palette can jump to, in the sidebar's order. */
export const PAGE_ITEMS: NavItem[] = [...NAV_ITEMS, PORTFOLIO_MONEY_ITEM, SETTINGS_ITEM, OPERATIONS_ITEM, TV_ITEM, TV_EDIT_ITEM, SITES_ARRANGE_ITEM];
