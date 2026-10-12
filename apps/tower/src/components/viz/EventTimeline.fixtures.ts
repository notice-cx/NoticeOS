import type { EventTimelineProps, TimelineEvent, TimelineLane, TimelineSpan } from "./EventTimeline";

// Demo data for the gallery and the tests: a fixed now, on the UTC clock, so
// "6 PM yesterday" lands on the same tick on every machine.

export const EVENT_TIMELINE_NOW_MS = Date.parse("2026-10-11T15:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(EVENT_TIMELINE_NOW_MS - ms).toISOString();
const ZONE = "UTC";

export const eventTimelineLanes: TimelineLane[] = [
  { id: "plume-studio.example", label: "Plume Studio", href: "/assets/plume-studio.example" },
  { id: "mosaic-finder.example", label: "Mosaic Finder", href: "/assets/mosaic-finder.example" },
  { id: "presidential-test.example", label: "Lantern Works", href: "/assets/presidential-test.example" },
  { id: "area-code.example", label: "Acorn Atlas", href: "/assets/area-code.example" },
  { id: "fin-codes.example", label: "Ripple Index", href: "/assets/fin-codes.example" },
  { id: "pt-standards.example", label: "Summit", href: "/assets/pt-standards.example" },
  { id: "system", label: "System", href: "/health" },
];

const openProblems: TimelineSpan[] = [
  {
    id: "pt-uptime", lane: "pt-standards.example", from: ago(37 * MINUTE), to: null, severity: "error",
    label: "Uptime collection failing", href: "/assets/pt-standards.example/sources",
  },
  {
    id: "pt-bing", lane: "pt-standards.example", from: ago(6 * HOUR + 4 * MINUTE), to: null, severity: "error",
    label: "Bing collection failing", href: "/assets/pt-standards.example/sources",
  },
  {
    id: "system-backups", lane: "system", from: ago(6 * HOUR + 12 * MINUTE), to: null, severity: "error",
    label: "Backups failed", href: "/health",
  },
  {
    id: "nom-api", lane: "mosaic-finder.example", from: ago(6 * HOUR + 20 * MINUTE), to: null, severity: "warn",
    label: "API requests well below normal", href: "/alerts",
  },
  {
    id: "pt-home-404", lane: "pt-standards.example", from: ago(67 * DAY), to: null, severity: "error",
    label: "Home page returns 404", href: "/alerts",
  },
];

/** The last 24 hours, since 6 PM yesterday marked: what Home leads with. */
export const eventTimelineDay: EventTimelineProps = {
  ariaLabel: "What happened in the last 24 hours",
  lanes: eventTimelineLanes,
  window: { from: ago(DAY), to: ago(0) },
  nowMs: EVENT_TIMELINE_NOW_MS,
  timeZone: ZONE,
  marker: { at: "2026-10-10T18:00:00.000Z", label: "Since you last looked · 6 PM yesterday" },
  spans: [
    ...openProblems,
    // Closed long before this window, so Ripple Index has nothing to draw and its row is left out.
    { id: "fin-report", lane: "fin-codes.example", from: ago(20 * DAY), to: ago(19 * DAY), severity: "warn", label: "Nightly report late" },
  ],
  events: [
    { id: "myplate-resolved", lane: "plume-studio.example", at: "2026-10-11T02:00:00.000Z", kind: "resolved", label: "Traffic alert resolved", href: "/alerts/history" },
    { id: "nom-shipped", lane: "mosaic-finder.example", at: "2026-10-11T10:00:00.000Z", kind: "shipped", label: "Recipe search update", href: "/assets/mosaic-finder.example/activity" },
    { id: "myplate-win", lane: "plume-studio.example", at: "2026-10-10T21:00:00.000Z", kind: "win", label: "Best day since March" },
    { id: "myplate-money", lane: "plume-studio.example", at: "2026-10-11T06:10:00.000Z", kind: "money", label: "Yesterday's ad revenue reported" },
    { id: "pt-people", lane: "presidential-test.example", at: "2026-10-11T08:00:00.000Z", kind: "people", label: "Visitors back to usual levels" },
    // Three marks within ten minutes: one count bubble at any desk width.
    { id: "area-sitemap", lane: "area-code.example", at: "2026-10-11T13:10:00.000Z", kind: "note", label: "Sitemap resubmitted" },
    { id: "area-titles", lane: "area-code.example", at: "2026-10-11T13:14:00.000Z", kind: "shipped", label: "Title tags updated", href: "/assets/area-code.example/activity" },
    { id: "area-clicks", lane: "area-code.example", at: "2026-10-11T13:20:00.000Z", kind: "problem", severity: "warn", label: "Search clicks dipped" },
  ],
};

/** The last 7 days: ticks become days, and closed problems show where they ended. */
export const eventTimelineWeek: EventTimelineProps = {
  ariaLabel: "What happened in the last 7 days",
  lanes: eventTimelineLanes,
  window: { from: ago(7 * DAY), to: ago(0) },
  nowMs: EVENT_TIMELINE_NOW_MS,
  timeZone: ZONE,
  spans: [
    ...openProblems,
    { id: "myplate-clicks", lane: "plume-studio.example", from: ago(4 * DAY), to: ago(3 * DAY), severity: "warn", label: "Search clicks low", href: "/alerts/history" },
    { id: "area-sitemap-failing", lane: "area-code.example", from: ago(5 * DAY + 6 * HOUR), to: ago(5 * DAY), severity: "error", label: "Sitemap failing" },
  ],
  events: [
    { id: "nom-shipped", lane: "mosaic-finder.example", at: ago(2 * DAY), kind: "shipped", label: "Recipe search update", href: "/assets/mosaic-finder.example/activity" },
    { id: "myplate-win", lane: "plume-studio.example", at: ago(18 * HOUR), kind: "win", label: "Best day since March" },
    { id: "myplate-resolved", lane: "plume-studio.example", at: ago(3 * DAY), kind: "resolved", label: "Search clicks back to normal" },
    { id: "fin-money", lane: "fin-codes.example", at: ago(DAY + 3 * HOUR), kind: "money", label: "Affiliate payout reported" },
    { id: "pt-people", lane: "presidential-test.example", at: ago(5 * DAY), kind: "people", label: "Visitors up after the newsletter" },
  ],
};

/** One site's own row, for its page header: no name column. */
export const eventTimelineCompact: EventTimelineProps = {
  ariaLabel: "Summit in the last 24 hours",
  compact: true,
  lanes: eventTimelineLanes.filter((lane) => lane.id === "pt-standards.example"),
  window: { from: ago(DAY), to: ago(0) },
  nowMs: EVENT_TIMELINE_NOW_MS,
  timeZone: ZONE,
  marker: { at: "2026-10-10T18:00:00.000Z", label: "Since you last looked · 6 PM yesterday" },
  spans: openProblems.filter((span) => span.lane === "pt-standards.example"),
  events: [
    { id: "pt-sitemap-back", lane: "pt-standards.example", at: "2026-10-11T04:00:00.000Z", kind: "resolved", label: "Sitemap fetch recovered" },
    { id: "pt-titles", lane: "pt-standards.example", at: "2026-10-10T20:00:00.000Z", kind: "shipped", label: "Title tags updated" },
  ] satisfies TimelineEvent[],
};

/** A quiet day: the axis and NOW still draw, and the row says so in words. */
export const eventTimelineQuiet: EventTimelineProps = {
  ariaLabel: "What happened in the last 24 hours",
  lanes: eventTimelineLanes,
  window: { from: ago(DAY), to: ago(0) },
  nowMs: EVENT_TIMELINE_NOW_MS,
  timeZone: ZONE,
  marker: { at: "2026-10-10T18:00:00.000Z", label: "Since you last looked · 6 PM yesterday" },
};
