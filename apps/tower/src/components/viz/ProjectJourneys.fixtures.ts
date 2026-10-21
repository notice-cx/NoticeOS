// Invented projects for the gallery and the component's tests: one waiting on
// the operator with a task held, one moving with parked work and a kill date,
// one finished. Nothing here names a real site.
import type { JourneyRow } from "./ProjectJourneys";

export const PROJECT_JOURNEYS_NOW_MS = Date.parse("2026-10-21T12:00:00.000Z");
export const PROJECT_JOURNEYS_WEEK_START = "2026-10-19";

const DAY = 86_400_000;
const ago = (days: number) => new Date(PROJECT_JOURNEYS_NOW_MS - days * DAY).toISOString();
const ahead = (days: number) => new Date(PROJECT_JOURNEYS_NOW_MS + days * DAY).toISOString().slice(0, 10);

export const projectJourneyRows: JourneyRow[] = [
  {
    id: "mw-e1",
    title: "Recipe schema overhaul",
    site: "Meadow",
    state: { label: "Needs you · 9d", tone: "warn" },
    done: [ago(24), ago(17), ago(11), ago(3)],
    inProgress: [],
    waiting: { title: "Approve the new schema", from: ago(9), verb: "approve" },
    blocked: 2,
    parked: [],
    killDate: null,
  },
  {
    id: "nw-e2",
    title: "Faster checkout pages",
    site: "Northwind",
    state: { label: "In progress · Ada", tone: "healthy" },
    done: [ago(20), ago(6)],
    inProgress: [{ title: "Cache the cart", from: ago(4) }],
    waiting: null,
    blocked: 0,
    parked: [{ title: "Try a one-page form", until: ahead(12) }],
    killDate: ahead(24),
  },
  {
    id: "pl-e3",
    title: "Footer copy",
    site: "Plume",
    state: { label: "Done", tone: "muted" },
    done: [ago(26), ago(19), ago(15)],
    inProgress: [],
    waiting: null,
    blocked: 0,
    parked: [],
    killDate: null,
  },
];
