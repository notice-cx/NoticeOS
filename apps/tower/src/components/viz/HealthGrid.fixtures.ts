import type { HealthCell, HealthColumn, HealthRow, HealthState } from "./HealthGrid";

// Demo data for the gallery and the tests: invented sites at a fixed clock,
// shaped like a real Home on a bad afternoon.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const HEALTH_NOW_MS = Date.parse("2026-10-11T14:00:00.000Z");

const ago = (ms: number) => new Date(HEALTH_NOW_MS - ms).toISOString();

export const HEALTH_COLUMNS: HealthColumn[] = [
  { id: "nightly-report", label: "Nightly report", short: "Report" },
  { id: "gsc", label: "Search Console", short: "Search" },
  { id: "bing-webmaster", label: "Bing", short: "Bing" },
  { id: "ga4", label: "GA4", short: "GA4" },
  { id: "clarity", label: "Clarity", short: "Clarity" },
  { id: "posthog", label: "PostHog", short: "PostHog" },
  { id: "dataforseo", label: "DataForSEO", short: "Ranks" },
  { id: "uptime", label: "Uptime", short: "Uptime" },
];

/** The System's own parts, a row of their own under the sites. */
export const HEALTH_SYSTEM_COLUMNS: HealthColumn[] = [
  { id: "runner", label: "Runner", short: "Runner" },
  { id: "scheduled-jobs", label: "Scheduled jobs", short: "Jobs" },
  { id: "backups", label: "Backups", short: "Backups" },
  { id: "nightly-report", label: "Nightly report", short: "Report" },
];

type CellSpec = HealthState | Omit<HealthCell, "column">;

/** A working cell has worked for a month unless told otherwise; absences
 * carry no start. */
function cellsFor(columns: readonly HealthColumn[], specs: Record<string, CellSpec>, href: string): HealthCell[] {
  return columns.map((column) => {
    const spec = specs[column.id] ?? "working";
    const cell = typeof spec === "string" ? { state: spec } : spec;
    const since = cell.state === "working" ? ago(31 * DAY) : cell.state === "collecting" ? ago(2 * HOUR) : null;
    return { column: column.id, since, href, ...cell };
  });
}

function site(id: string, name: string, specs: Record<string, CellSpec>): HealthRow {
  return { id, name, kind: "site", href: `/assets/${id}`, cells: cellsFor(HEALTH_COLUMNS, specs, `/assets/${id}/sources`) };
}

function system(specs: Record<string, CellSpec>): HealthRow {
  return {
    id: "system",
    name: "System",
    kind: "system",
    href: "/health",
    columns: HEALTH_SYSTEM_COLUMNS,
    cells: cellsFor(HEALTH_SYSTEM_COLUMNS, specs, "/health"),
  };
}

const MONITOR_ONLY: Record<string, CellSpec> = {
  gsc: "not-using",
  "bing-webmaster": "not-using",
  ga4: "not-using",
  clarity: "not-using",
  posthog: "not-using",
  dataforseo: "not-using",
};

/** Six sites and the System: two fresh failures on one site, a failed backup,
 * one late report, a few sources never connected and one monitor-only site. */
export const HEALTH_ROWS: HealthRow[] = [
  site("plume-studio.example.com", "Plume Studio", { posthog: "collecting" }),
  site("mosaic-finder.example.com", "Mosaic Finder", {
    gsc: { state: "overdue", since: ago(29 * HOUR), detail: "Yesterday's report has not arrived" },
    clarity: "not-connected",
    posthog: "not-connected",
  }),
  site("lantern-works.example.com", "Lantern Works", { posthog: "not-connected" }),
  site("acorn-atlas.example.com", "Acorn Atlas", { clarity: "not-connected", posthog: "not-connected" }),
  site("ripple-index.example.com", "Ripple Index", MONITOR_ONLY),
  site("summit.example.com", "Summit", {
    "bing-webmaster": { state: "failing", since: ago(6 * HOUR), detail: "Bing refused the saved key" },
    posthog: "not-connected",
    uptime: { state: "failing", since: ago(37 * MINUTE), detail: "Checks stopped arriving; the home page itself answers" },
  }),
  system({ backups: { state: "failing", since: ago(6 * HOUR), detail: "Last night's backup did not finish" } }),
];

/** The same portfolio on a good day. */
export const HEALTH_ROWS_HEALTHY: HealthRow[] = [
  site("plume-studio.example.com", "Plume Studio", {}),
  site("mosaic-finder.example.com", "Mosaic Finder", { clarity: "not-connected", posthog: "not-connected" }),
  site("lantern-works.example.com", "Lantern Works", { posthog: "collecting" }),
  site("acorn-atlas.example.com", "Acorn Atlas", { clarity: "not-connected", posthog: "not-connected" }),
  site("ripple-index.example.com", "Ripple Index", MONITOR_ONLY),
  site("summit.example.com", "Summit", { posthog: "not-connected" }),
  system({}),
];

/** For a half-width panel or a phone: three sites, one failure a week stale,
 * one source the OS cannot read right now. */
export const HEALTH_ROWS_NARROW: HealthRow[] = [
  site("acorn-atlas.example.com", "Acorn Atlas", {
    "bing-webmaster": { state: "failing", since: ago(67 * DAY), detail: "Bing has not listed this asset since it moved" },
    ga4: { state: "unknown", detail: "The last check could not be read" },
    clarity: "not-connected",
  }),
  site("lantern-works.example.com", "Lantern Works", { posthog: "not-connected" }),
  site("summit.example.com", "Summit", {
    uptime: { state: "failing", since: ago(37 * MINUTE), detail: "Checks stopped arriving; the home page itself answers" },
  }),
];
