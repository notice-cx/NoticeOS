import {
  Bell,
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

/**
 * The Integrations page. Named for the same reason as `ASSETS_ROUTE`: the
 * sidebar draws this entry with the expiry dot.
 */
export const INTEGRATIONS_ROUTE = "/integrations";

export const TASKS_ROUTE = "/tasks";

/**
 * The desk's navigation, in the operator's order: where they land, what they
 * own, what is shouting, what is queued, what it earned, whether the inputs are
 * trustworthy, what they are plugged into, and finally the knobs.
 *
 * Health answers "is everything working" from collector evidence; Integrations
 * answers "what am I connected with" from the credential store. `/properties`
 * and `/work` stay as aliases. NavLink matches by prefix, so an asset page
 * lights Sites and a task page lights Tasks.
 *
 * It lives in its own module rather than in `AppShell.tsx` so the command
 * palette can read it without importing the shell that mounts the palette.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home", icon: House, end: true, keywords: ["overview", "desk", "start"] },
  { to: "/workflows", label: "Workflows", icon: GitBranch, keywords: ["schedules", "jobs", "automation", "runs", "agents"] },
  {
    to: ASSETS_ROUTE,
    label: "Sites",
    icon: Globe,
    keywords: ["assets", "portfolio", "domains"],
  },
  { to: "/alerts", label: "Alerts", icon: Bell, keywords: ["flags", "attention", "warnings"] },
  { to: TASKS_ROUTE, label: "Tasks", icon: ListTodo, keywords: ["work", "queue", "beads", "todo"] },
  {
    to: "/financials",
    // The route, the payload and the asset tab's id keep `financials`.
    label: "Money",
    icon: Wallet,
    keywords: ["revenue", "cost", "ledger", "financials", "p&l"],
  },
  {
    to: "/health",
    label: "System health",
    icon: HeartPulse,
    // Not "integrations": that word belongs to its own page.
    keywords: ["sources", "connections", "unblock"],
  },
  {
    to: INTEGRATIONS_ROUTE,
    label: "Integrations",
    icon: Plug,
    keywords: ["integrations", "connected accounts", "connect", "credentials", "api key", "providers", "secrets"],
  },
  { to: "/settings", label: "Settings", icon: Settings, keywords: ["config", "knobs", "preferences"] },
];

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

/** Every page the palette can jump to, in the sidebar's order. */
export const PAGE_ITEMS: NavItem[] = [...NAV_ITEMS, TV_ITEM, TV_EDIT_ITEM];

/** Every core page remains reachable even when its service is unavailable. */
export function shownPages(items: readonly NavItem[]): NavItem[] {
  return [...items];
}
