import {
  Activity,
  Archive,
  ArrowDownToLine,
  ChartColumn,
  CircleDollarSign,
  Cog,
  Database,
  GraduationCap,
  Hammer,
  LayoutDashboard,
  ListOrdered,
  Radar,
  Scale,
  Search,
} from "lucide-react";
import type { FlowEdge, FlowNode } from "./FlowGraph";

// Demo graphs for the gallery and the tests: invented figures, read against
// one fixed clock so every age is the same on every run.

export interface FlowFixture {
  ariaLabel: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const FLOW_NOW_MS = Date.parse("2026-10-08T15:00:00Z");

const ago = (minutes: number) => new Date(FLOW_NOW_MS - minutes * 60_000).toISOString();

/** The loop the OS runs, each stage with its live count, Learn feeding Sense. */
export const FLOW_LOOP: FlowFixture = {
  ariaLabel: "The operating loop: sense, attribute, decide, act, learn",
  nodes: [
    { id: "sense", label: "Sense", icon: Radar, value: "31 of 38", caption: "sources live · 3 failing", state: "warn", href: "/integrations" },
    { id: "attribute", label: "Attribute", icon: Scale, value: "5", caption: "measured · 2 unmeasured", state: "ok" },
    { id: "decide", label: "Decide", icon: ListOrdered, value: "147", caption: "waiting · oldest 67d", state: "warn", href: "/tasks" },
    { id: "act", label: "Act", icon: Hammer, value: "12", caption: "in progress", state: "active" },
    { id: "learn", label: "Learn", icon: GraduationCap, value: "3", caption: "measuring · next reading Thu", state: "ok" },
  ],
  edges: [
    { from: "sense", to: "attribute" },
    { from: "attribute", to: "decide" },
    { from: "decide", to: "act" },
    { from: "act", to: "learn" },
    { from: "learn", to: "sense", loop: true, label: "next round" },
  ],
};

/** The system's topology: two sources and the backup failing, each lit where it sits. */
export const FLOW_SYSTEM: FlowFixture = {
  ariaLabel: "How data moves through the system, from sources to backups",
  nodes: [
    { id: "search-console", label: "Search Console", icon: Search, caption: "read 41m ago", state: "ok" },
    { id: "bing", label: "Bing", icon: Search, caption: "sign-in rejected", state: "error", since: ago(6 * 60), href: "/integrations?provider=bing" },
    { id: "ga4", label: "GA4", icon: ChartColumn, caption: "read 12m ago", state: "ok" },
    { id: "uptime", label: "Uptime", icon: Activity, caption: "checks timing out", state: "error", since: ago(37) },
    { id: "mediavine", label: "Mediavine", icon: CircleDollarSign, caption: "read 3h ago", state: "ok" },
    { id: "collectors", label: "Collectors", icon: ArrowDownToLine, value: "3 of 5", caption: "sources reading", state: "warn", since: ago(6 * 60) },
    { id: "store", label: "Store", icon: Database, caption: "last write 2m ago", state: "ok" },
    { id: "tower", label: "Tower", icon: LayoutDashboard, caption: "4 sites up to date", state: "ok" },
    { id: "runner", label: "Job runner", icon: Cog, caption: "last job 4m ago", state: "active" },
    { id: "backups", label: "Backups", icon: Archive, caption: "last good copy 1d ago", state: "error", stateLabel: "Failed", since: ago(6 * 60) },
  ],
  edges: [
    { from: "search-console", to: "collectors" },
    { from: "bing", to: "collectors", state: "broken" },
    { from: "ga4", to: "collectors" },
    { from: "uptime", to: "collectors" },
    { from: "mediavine", to: "collectors" },
    { from: "collectors", to: "store" },
    { from: "store", to: "tower" },
    { from: "store", to: "runner" },
    { from: "runner", to: "backups", state: "broken" },
  ],
};

/** A project's tasks: one blocked task holds up the launch and everything after it. */
export const FLOW_DEPENDENCIES: FlowFixture = {
  ariaLabel: "Tasks in this project and what blocks them",
  nodes: [
    { id: "headline", label: "Write the new headline", caption: "closed 2d ago", state: "ok", stateLabel: "Done" },
    { id: "variant", label: "Build variant B", caption: "agent working", state: "active", stateLabel: "In progress" },
    { id: "access", label: "Grant analytics access", caption: "waiting on you", state: "error", stateLabel: "Blocked", since: ago(2 * 24 * 60), column: 1 },
    { id: "launch", label: "Launch the test", caption: "1 of 2 ready", state: "warn", stateLabel: "Waiting" },
    { id: "read", label: "Read the result", caption: "14 days after launch", state: "idle", stateLabel: "Not started" },
  ],
  edges: [
    { from: "headline", to: "variant" },
    { from: "variant", to: "launch", state: "idle" },
    { from: "access", to: "launch" },
    { from: "launch", to: "read", state: "idle" },
  ],
};

/** One part not connected yet: hatched, dashed, named. */
export const FLOW_ABSENT: FlowFixture = {
  ariaLabel: "Revenue reaching the desk",
  nodes: [
    { id: "ads", label: "Ad revenue", icon: CircleDollarSign, state: "absent" },
    { id: "store", label: "Store", icon: Database, caption: "last write 2m ago", state: "ok" },
    { id: "tower", label: "Tower", icon: LayoutDashboard, caption: "revenue not shown", state: "idle" },
  ],
  edges: [
    { from: "ads", to: "store" },
    { from: "store", to: "tower", state: "idle" },
  ],
};
