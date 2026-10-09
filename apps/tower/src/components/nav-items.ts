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
 * The assets index. Named rather than spelled twice because the sidebar renders
 * the portfolio's own rows underneath this one entry (bead `ro-pbzu.9`) and has
 * to find it by identity — a nav item matched by a string literal in a second
 * file detaches silently the day the path changes.
 */
export const ASSETS_ROUTE = "/assets";

/**
 * The Integrations page. Named for the same reason `ASSETS_ROUTE` is: the
 * sidebar draws this one entry differently — it carries the expiry dot (bead
 * `ro-vu8d.8`) — and an entry matched by a string literal in a second file
 * detaches silently the day the path changes.
 */
export const INTEGRATIONS_ROUTE = "/integrations";

/**
 * Tasks is a core destination in the sidebar and palette (D32).
 */
export const TASKS_ROUTE = "/tasks";

/**
 * The desk's navigation, in the operator's order: where they land, what they
 * own, what is shouting, what is queued, what it earned, whether the inputs are
 * trustworthy, what they are plugged into, and finally the knobs.
 *
 * Health and Integrations are adjacent and separate on purpose (bead
 * `ro-vu8d.2`): Health answers *is everything working*, from collector
 * evidence; Integrations answers *what am I connected with, and can I connect
 * something*, from the credential store. They shared one address until 2026-09,
 * which meant the page an operator opened to make a connection could only
 * observe one. Label and URL now say the same noun —
 * Sites at `/assets` (D31), Tasks at `/tasks` (D19) — with `/properties` and
 * `/work` kept as aliases. An asset page lights Sites because an asset page IS
 * an asset: NavLink matches the prefix, and a task page lights Tasks the same
 * way.
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
    // Money, not Financials (D44, doc 17 § Altitude): the founder's word.
    // The route, the payload and the asset tab's id keep `financials`.
    label: "Money",
    icon: Wallet,
    keywords: ["revenue", "cost", "ledger", "financials", "p&l"],
  },
  {
    to: "/health",
    label: "System health",
    icon: HeartPulse,
    // "integrations" is deliberately gone from here: it is a page now, and one
    // word may not point at two of them (doc 17 rule 1).
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
 * Where the television's layout is arranged (bead `ro-lzmq.2`). It is a desk
 * page but deliberately NOT a sidebar entry of its own: the sidebar holds the
 * places the operator lives, and a TV layout is rearranged rarely and always on
 * purpose. It is reached from the Edit beside the sidebar's TV dashboard entry
 * (bead `ro-ujb9.96.7.12` — Edit, move, Save, PostHog's dashboard pattern),
 * from the Settings page's TV dashboard section, from the palette below, and
 * from nowhere on the television itself — flow D's oldest rule.
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
