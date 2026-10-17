// Invented figures for the visual kit's gallery, shaped like a six-site
// portfolio on a bad afternoon. Sites live on the reserved `.example` domain.
import type { SeriesPoint } from "@shared/wall";
import type { WorkWeeks } from "@shared/work";
import type { Incident } from "@/components/viz/IncidentList";
import type { PortfolioRow } from "@/components/viz/PortfolioRows";
import type { QueueItem } from "@/components/viz/DecisionQueue";
import type { WorkFlowRow } from "@/components/viz/WorkFlow";
import type { HomeMoney } from "@/lib/home-money";

export const DEMO_NOW = Date.parse("2026-10-11T21:30:00.000Z");
export const DEMO_MARKER = "2026-10-11T01:00:00.000Z";

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(DEMO_NOW - msAgo).toISOString();

/** `n` daily points ending yesterday, shaped by a weekly wave around `scale`. */
export function demoDays(n: number, scale: number, seed: number, endOffsetDays = 1, trend = 0): SeriesPoint[] {
  return Array.from({ length: n }, (_, k) => {
    const date = new Date(DEMO_NOW - (n - 1 - k + endOffsetDays) * DAY);
    const weekday = date.getUTCDay();
    const wave = Math.sin((k + seed) / 2.3) * 0.08 + Math.cos((k * seed) / 5) * 0.04;
    const weekend = weekday === 0 || weekday === 6 ? 0.8 : 1;
    const drift = 1 + trend * (k / Math.max(1, n - 1) - 0.5);
    return { t: date.toISOString().slice(0, 10), v: Math.max(0, Math.round(scale * weekend * drift * (1 + wave) * 100) / 100) };
  });
}

export const REVENUE_14 = demoDays(14, 12.4, 3).map((point, index, all) => (index === all.length - 1 ? { ...point, v: 11.76 } : point));
export const PEOPLE_14 = demoDays(14, 3950, 5).map((point) => ({ ...point, v: Math.round(point.v) })).map((point, index, all) => (index === all.length - 1 ? { ...point, v: 3891 } : point));
export const REVENUE_30 = demoDays(30, 12.1, 7);

export const SITES = [
  { id: "plume-studio.example", name: "Plume Studio" },
  { id: "mosaic-finder.example", name: "Mosaic Finder" },
  { id: "lantern-works.example", name: "Lantern Works" },
  { id: "acorn-atlas.example", name: "Acorn Atlas" },
  { id: "ripple-index.example", name: "Ripple Index" },
  { id: "summit.example", name: "Summit" },
] as const;

const src = (states: PortfolioRow["sources"][number]["state"][]): PortfolioRow["sources"] =>
  ["Nightly report", "Search Console", "Bing", "GA4", "Clarity", "PostHog", "DataForSEO", "Uptime"].map((label, index) => ({ label, state: states[index] ?? "not-using" }));

export const PORTFOLIO: PortfolioRow[] = [
  { id: "plume-studio.example", name: "Plume Studio", to: "#", health: { word: "On track", tone: "quiet" }, people: demoDays(30, 3285, 2, 1, 0.25).map((p) => ({ ...p, v: Math.round(p.v) })), peopleLatest: 3285, revenue: 11.76, revenueChange: -6.2, share: 0.97, sources: src(["working", "working", "working", "working", "not-connected", "working", "working", "working"]) },
  { id: "mosaic-finder.example", name: "Mosaic Finder", to: "#", health: { word: "At risk", tone: "warn" }, people: demoDays(30, 214, 4, 1, -0.45).map((p) => ({ ...p, v: Math.round(p.v) })), peopleLatest: 214, revenue: 0.31, revenueChange: null, share: 0.03, sources: src(["working", "overdue", "working", "working", "not-connected", "not-connected", "working", "working"]) },
  { id: "lantern-works.example", name: "Lantern Works", to: "#", health: { word: "On track", tone: "quiet" }, people: demoDays(30, 130, 6, 1, 0.05).map((p) => ({ ...p, v: Math.round(p.v) })), peopleLatest: 130, revenue: null, share: null, sources: src(["working", "working", "working", "working", "not-connected", "not-connected", "not-using", "working"]) },
  { id: "acorn-atlas.example", name: "Acorn Atlas", to: "#", health: { word: "On track", tone: "quiet" }, people: demoDays(30, 254, 8, 1, 0.6).map((p) => ({ ...p, v: Math.round(p.v) })), peopleLatest: 254, revenue: null, share: null, sources: src(["working", "working", "working", "working", "not-using", "not-using", "not-using", "working"]) },
  { id: "ripple-index.example", name: "Ripple Index", to: "#", health: { word: "Monitor only", tone: "quiet" }, people: demoDays(30, 8, 9, 1, -0.2).map((p) => ({ ...p, v: Math.round(p.v) })), peopleLatest: 8, revenue: null, share: null, sources: src(["not-using", "working", "not-using", "working", "not-using", "not-using", "not-using", "working"]) },
  { id: "summit.example", name: "Summit", to: "#", health: { word: "Off track", tone: "error" }, people: [], peopleLatest: null, revenue: null, share: null, sources: src(["working", "working", "failing", "collecting", "not-connected", "not-connected", "not-using", "failing"]) },
];

export const INCIDENTS: Incident[] = [
  { key: "uptime-pts", severity: "error", title: "Uptime collection failing", site: "Summit", since: iso(37 * 60_000), to: "#" },
  { key: "backups", severity: "error", title: "Backups failed", site: "System", since: iso(6 * 3_600_000), to: "#" },
  { key: "bing-pts", severity: "error", title: "Bing collection failing", site: "Summit", since: iso(6 * 3_600_000 + 5 * 60_000), to: "#" },
  { key: "api-nom", severity: "warn", title: "API requests well below normal", site: "Mosaic Finder", since: iso(6 * 3_600_000 + 20 * 60_000), to: "#" },
  { key: "home-pts", severity: "error", title: "Home page check failed — HTTP 404", site: "Summit", since: iso(67 * DAY), to: "#" },
];

const ageDays = (days: number) => days;
export const QUEUE: QueueItem[] = [
  { id: "ro-5n5", kind: "approval", title: "Add the Ahrefs key and approve its data-source migration", project: "System", ageDays: ageDays(67), to: "#" },
  { id: "mp-g1", kind: "approval", title: "Approve: publish the new plan builder to everyone", project: "Plume Studio", ageDays: ageDays(16), to: "#" },
  { id: "ro-30du", kind: "approval", title: "Approve one export of the Plume Studio database after the Wrangler repair", project: "System", ageDays: ageDays(10), to: "#" },
  { id: "nom-q1", kind: "question", title: "Which onboarding email should go out first?", project: "Mosaic Finder", ageDays: ageDays(4), to: "#" },
  { id: "pts-q2", kind: "question", title: "Keep the old certification pages or redirect them?", project: "Summit", ageDays: ageDays(2), to: "#" },
  ...Array.from({ length: 30 }, (_, index) => ({
    id: `bulk-${index}`,
    kind: (index % 3 === 0 ? "question" : "approval") as QueueItem["kind"],
    title: `Waiting item ${index + 1}`,
    project: SITES[index % SITES.length]!.name,
    ageDays: [1, 3, 9, 12, 21, 33, 45, 61, 75, 88][index % 10]!,
  })),
];

export const WORK: WorkFlowRow[] = [
  { id: "plume", name: "Plume Studio", done: 58, doneLastWeek: 71, inProgress: 4, ready: 167, blocked: 9, urgent: 14 },
  { id: "mosaic", name: "Mosaic Finder", done: 19, doneLastWeek: 15, inProgress: 2, ready: 61, blocked: 3, urgent: 5 },
  { id: "lantern", name: "Lantern Works", done: 4, doneLastWeek: 6, inProgress: 1, ready: 12, blocked: 0, urgent: 2 },
  { id: "acorn", name: "Acorn Atlas", done: 2, doneLastWeek: 2, inProgress: 1, ready: 9, blocked: 0, urgent: 0 },
  { id: "ripple", name: "Ripple Index", done: 1, doneLastWeek: 0, inProgress: 0, ready: 6, blocked: 0, urgent: 1 },
  { id: "summit", name: "Summit", done: 5, doneLastWeek: 3, inProgress: 2, ready: 13, blocked: 1, urgent: 4 },
];

/** The six projects' week, three days in: done ahead of last week by today,
 * the inbox and blocked grown, in progress level. */
export const WORK_WEEKS: WorkWeeks = {
  weekStart: "2026-10-12",
  daysIn: 3,
  done: { now: 89, notDone: 6, before: 64, lastWeek: 97, move: { by: 25, direction: "up", verdict: "good" } },
  waiting: { now: 4, before: 2, added: 3, move: { by: 2, direction: "up", verdict: "bad" } },
  urgent: { now: 26, before: 29, added: 2, move: { by: -3, direction: "down", verdict: "good" } },
  inProgress: { now: 10, before: 10, added: 4, move: { by: 0, direction: "flat", verdict: "neutral" } },
  blocked: { now: 13, before: 9, added: 6, move: { by: 4, direction: "up", verdict: "bad" } },
};

export const MONEY: HomeMoney = {
  period: "2026-10",
  soFar: 364,
  estimated: true,
  projected: 1020,
  previousPeriod: "2026-09",
  previousTotal: 1127,
  changePercent: -9.5,
  daysLeft: 20,
  waiting: null,
  days: REVENUE_30.slice(-10).map((point) => ({ t: point.t, v: point.v * 2.9 })),
  usualDay: 35.1,
  bySite: [
    { id: "plume-studio.example", name: "Plume Studio", amount: 352 },
    { id: "mosaic-finder.example", name: "Mosaic Finder", amount: 12 },
  ],
};
