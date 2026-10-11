import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  EventTimeline,
  layoutEventTimeline,
  timelineScale,
  type EventTimelineProps,
} from "@/components/viz/EventTimeline";
import {
  EVENT_TIMELINE_NOW_MS,
  eventTimelineCompact,
  eventTimelineDay,
  eventTimelineQuiet,
  eventTimelineWeek,
} from "@/components/viz/EventTimeline.fixtures";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = EVENT_TIMELINE_NOW_MS;

function draw(props: EventTimelineProps) {
  return render(
    <MemoryRouter>
      <EventTimeline {...props} />
    </MemoryRouter>,
  );
}

describe("timelineScale", () => {
  const day = { from: iso(NOW - DAY), to: iso(NOW), timeZone: "UTC" };

  it("ticks a day on clock hours, every six at a desk width", () => {
    const scale = timelineScale({ ...day, width: 560 });
    expect(scale.unit).toBe("hour");
    expect(scale.step).toBe(6);
    expect(scale.ticks.map((tick) => tick.label)).toEqual(["6 PM", "Midnight", "6 AM", "Noon"]);
    expect(scale.ticks.filter((tick) => tick.major).map((tick) => tick.label)).toEqual(["Midnight"]);
    expect(scale.x(NOW - DAY)).toBe(0);
    expect(scale.x(NOW)).toBe(1);
    expect(scale.x(NOW - 12 * HOUR)).toBeCloseTo(0.5);
  });

  it("takes finer ticks when wider and coarser ones when narrow", () => {
    expect(timelineScale({ ...day, width: 1000 }).step).toBe(3);
    expect(timelineScale({ ...day, width: 200 }).ticks.map((tick) => tick.label)).toEqual(["Midnight", "Noon"]);
  });

  it("lands on the local hour in a half-hour zone", () => {
    const scale = timelineScale({ ...day, timeZone: "Asia/Kolkata", width: 560 });
    expect(scale.ticks.length).toBeGreaterThan(2);
    for (const tick of scale.ticks) expect(tick.ms % HOUR).toBe(30 * MINUTE);
  });

  it("ticks a week at local midnights, named by weekday", () => {
    const scale = timelineScale({ from: iso(NOW - 7 * DAY), to: iso(NOW), timeZone: "UTC", width: 560 });
    expect(scale.unit).toBe("day");
    expect(scale.ticks.map((tick) => tick.label)).toEqual(["Mon 5", "Tue 6", "Wed 7", "Thu 8", "Fri 9", "Sat 10", "Sun 11"]);
    for (const tick of scale.ticks) expect(tick.ms % DAY).toBe(0);
  });

  it("keeps a zone's midnight across a daylight-saving change", () => {
    const end = Date.parse("2026-11-05T12:00:00Z");
    const scale = timelineScale({ from: iso(end - 7 * DAY), to: iso(end), timeZone: "America/New_York", width: 560 });
    const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    expect(scale.ticks).toHaveLength(7);
    for (const tick of scale.ticks) expect(clock.format(new Date(tick.ms))).toBe("00:00");
  });

  it("ticks a quarter on Mondays, every other one", () => {
    const scale = timelineScale({ from: iso(NOW - 90 * DAY), to: iso(NOW), timeZone: "UTC", width: 560 });
    expect(scale.step).toBe(14);
    for (const tick of scale.ticks) expect(new Date(tick.ms).getUTCDay()).toBe(1);
    expect(scale.ticks[0]!.label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe("layoutEventTimeline", () => {
  const layout = layoutEventTimeline(eventTimelineDay, 560);
  const lane = (id: string) => layout.lanes.find((placed) => placed.lane.id === id)!;

  it("leads with rows that have an open error, then an open warning, then the rest as given", () => {
    expect(layout.lanes.map((placed) => placed.lane.id)).toEqual([
      "pt-standards.example",
      "system",
      "mosaic-finder.example",
      "plume-studio.example",
      "presidential-test.example",
      "area-code.example",
    ]);
    expect(layout.lanes.map((placed) => placed.state)).toEqual(["error", "error", "warn", "quiet", "quiet", "quiet"]);
  });

  it("leaves out a row with nothing in the window", () => {
    expect(layout.lanes.some((placed) => placed.lane.id === "fin-codes.example")).toBe(false);
  });

  it("stacks a row's overlapping problems, newest first, each with its age", () => {
    const pt = lane("pt-standards.example");
    expect(pt.spanRows).toBe(3);
    expect(pt.spans.map((p) => [p.span.id, p.row, p.state, p.age])).toEqual([
      ["pt-uptime", 0, "open", "37m"],
      ["pt-bing", 1, "open", "6h"],
      ["pt-home-404", 2, "long-standing", "since 67d"],
    ]);
  });

  it("clips a problem older than the window at the left edge", () => {
    const old = lane("pt-standards.example").spans.find((p) => p.span.id === "pt-home-404")!;
    expect(old.x1).toBe(0);
    expect(old.x2).toBe(1);
    expect(old.name).toBe("Summit · Home page returns 404 · since 67 days ago");
  });

  it("prints a fresh stub's label before it, where a bar too short to hold it ends at now", () => {
    const stub = lane("pt-standards.example").spans[0]!;
    expect(stub.x2).toBe(1);
    expect([stub.labelAt, stub.ageAt]).toEqual(["before", "before"]);
    expect(layoutEventTimeline(eventTimelineDay, 4000).lanes[0]!.spans[1]!.labelAt).toBe("inside");
  });

  it("leads with the newest open error alone", () => {
    const leads = layout.lanes.flatMap((placed) => placed.spans).filter((p) => p.lead).map((p) => p.span.id);
    expect(leads).toEqual(["pt-uptime"]);
  });

  it("groups marks a few pixels apart into one bubble, and parts them when there is room", () => {
    const groups = lane("area-code.example").groups;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.events.map((mark) => mark.event.id)).toEqual(["area-sitemap", "area-titles", "area-clicks"]);
    expect(groups[0]!.name).toBe("3 events on Acorn Atlas around 1:15 PM today");
    expect(layoutEventTimeline(eventTimelineDay, 20_000).lanes.find((placed) => placed.lane.id === "area-code.example")!.groups).toHaveLength(3);
  });

  it("names an unknown onset instead of inventing one", () => {
    const unknown = layoutEventTimeline({
      ...eventTimelineQuiet,
      spans: [{ id: "calendar", lane: "system", from: null, to: null, severity: "warn", label: "Calendar not updating" }],
    }, 560).lanes[0]!.spans[0]!;
    expect(unknown.state).toBe("unknown-start");
    expect(unknown.age).toBe("start unknown");
    expect(unknown.name).toBe("System · Calendar not updating · since an unknown time");
    expect(unknown.x1).toBe(0);
  });

  it("ends a closed problem where it closed and says how long it lasted", () => {
    const week = layoutEventTimeline(eventTimelineWeek, 560);
    const closed = week.lanes.flatMap((placed) => placed.spans).find((p) => p.span.id === "myplate-clicks")!;
    expect(closed.state).toBe("closed");
    expect(closed.x2).toBeCloseTo(4 / 7);
    expect(closed.name).toBe("Plume Studio · Search clicks low · resolved 3 days ago after 1 day");
    expect(week.lanes.find((placed) => placed.lane.id === "plume-studio.example")!.state).toBe("quiet");
  });

  it("still draws an item whose row nobody declared, under its id", () => {
    const stray = layoutEventTimeline({
      ...eventTimelineQuiet,
      events: [{ id: "x", lane: "new-site.example", at: iso(NOW - HOUR), kind: "note", label: "First report" }],
    }, 560);
    expect(stray.lanes.map((placed) => placed.lane.label)).toEqual(["new-site.example"]);
  });

  it("puts every item on one track when compact", () => {
    const compact = layoutEventTimeline(eventTimelineCompact, 560);
    expect(compact.lanes).toHaveLength(1);
    expect(compact.lanes[0]!.lane.label).toBe("Summit");
    expect(compact.lanes[0]!.spans).toHaveLength(3);
    expect(compact.lanes[0]!.groups.flatMap((group) => group.events)).toHaveLength(2);
  });
});

describe("EventTimeline", () => {
  it("is a named group whose rows follow the layout's order", () => {
    const { container } = draw(eventTimelineDay);
    expect(screen.getByRole("group", { name: "What happened in the last 24 hours" })).toHaveAttribute("data-unit", "hour");
    expect([...container.querySelectorAll("[data-lane]")].map((row) => row.getAttribute("data-lane"))).toEqual([
      "pt-standards.example",
      "system",
      "mosaic-finder.example",
      "plume-studio.example",
      "presidential-test.example",
      "area-code.example",
    ]);
    expect(container.querySelector('[data-lane="pt-standards.example"]')).toHaveAttribute("data-state", "error");
  });

  it("makes every mark with a destination a link named for what, where and how long", () => {
    draw(eventTimelineDay);
    expect(screen.getByRole("link", { name: "Summit · Uptime collection failing · since 37 minutes ago" }))
      .toHaveAttribute("href", "/assets/pt-standards.example/sources");
    expect(screen.getByRole("link", { name: "Mosaic Finder · API requests well below normal · since 6 hours ago" })).toHaveAttribute("href", "/alerts");
    expect(screen.getByRole("link", { name: "Mosaic Finder · Recipe search update · 5 hours ago" })).toHaveAttribute("href", "/assets/mosaic-finder.example/activity");
    expect(screen.getByRole("link", { name: "System" })).toHaveAttribute("href", "/health");
  });

  it("writes a long-standing problem's age on its bar, and a fresh one's beside it", () => {
    const { container } = draw(eventTimelineDay);
    const old = container.querySelector('[data-span="pt-home-404"]')!;
    expect(old).toHaveAttribute("data-state", "long-standing");
    expect(old.querySelector("[data-span-age]")).toHaveTextContent("since 67d");
    const fresh = container.querySelector('[data-span="pt-uptime"]')!;
    expect(fresh.querySelector("[data-span-label-before]")).toHaveTextContent("Uptime collection failing · 37m");
  });

  it("draws the axis, NOW and the last-looked marker", () => {
    const { container } = draw(eventTimelineDay);
    expect([...container.querySelectorAll("[data-tick]")].map((tick) => tick.textContent)).toEqual(["6 PM", "Midnight", "6 AM", "Noon"]);
    expect(container.querySelector("[data-now-label]")).toHaveTextContent("Now");
    expect(container.querySelector("[data-marker]")).toHaveTextContent("Since you last looked · 6 PM yesterday");
    expect(container.querySelectorAll("[data-now]")).toHaveLength(6);
  });

  it("gives the whole drawing as a list, every item once", () => {
    const { container } = draw(eventTimelineDay);
    const list = container.querySelector<HTMLElement>("[data-event-timeline-list]")!;
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toHaveLength(1 + 5 + 8);
    expect(items[0]).toBe("Since you last looked · 6 PM yesterday");
    expect(items[1]).toBe("Error: Summit · Uptime collection failing · since 37 minutes ago");
    expect(items).toContain("Warning: Mosaic Finder · API requests well below normal · since 6 hours ago");
    expect(items).toContain("Win: Plume Studio · Best day since March · 18 hours ago");
    expect(items).toContain("Warning: Acorn Atlas · Search clicks dipped · 1 hour ago");
    expect(items.some((item) => item?.includes("Ripple Index"))).toBe(false);
  });

  it("opens a mark's label on focus and closes it on Escape", () => {
    draw(eventTimelineDay);
    const win = screen.getByRole("button", { name: "Plume Studio · Best day since March · 18 hours ago" });
    fireEvent.focus(win);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Best day since March");
    expect(tip).toHaveTextContent("9 PM yesterday · 18h ago");
    expect(win).toHaveAttribute("aria-describedby", tip.id);
    fireEvent.keyDown(win, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens a count bubble into its members, with their links", () => {
    const { container } = draw(eventTimelineDay);
    const bubble = screen.getByRole("button", { name: "3 events on Acorn Atlas around 1:15 PM today" });
    expect(bubble).toHaveTextContent("3");
    expect(container.querySelector("[data-event-cluster]")).toHaveAttribute("data-event-cluster", "3");
    fireEvent.click(bubble);
    expect(bubble).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("group", { name: "3 events on Acorn Atlas around 1:15 PM today" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(within(panel).getByRole("link", { name: "Title tags updated" })).toHaveAttribute("href", "/assets/area-code.example/activity");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "3 events on Acorn Atlas around 1:15 PM today" })).toBeNull();
  });

  it("draws one track without a name column when compact", () => {
    const { container } = draw(eventTimelineCompact);
    expect(container.querySelector("[data-event-timeline]")).toHaveAttribute("data-compact", "true");
    expect(container.querySelectorAll("[data-lane]")).toHaveLength(1);
    expect(container.querySelector("[data-lane-label]")).toBeNull();
    expect(container.querySelectorAll("[data-span]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-event]")).toHaveLength(2);
  });

  it("says a quiet window in words and still draws now", () => {
    const { container } = draw(eventTimelineQuiet);
    expect(container.querySelector('[data-state="empty"]')).toHaveTextContent("Nothing recorded since 3 PM yesterday");
    expect(container.querySelector("[data-now-label]")).toHaveTextContent("Now");
    expect(container.querySelector("[data-lane]")).toBeNull();
  });

  it("ticks a week by day and ends closed problems where they closed", () => {
    const { container } = draw(eventTimelineWeek);
    expect(container.querySelector("[data-event-timeline]")).toHaveAttribute("data-unit", "day");
    expect(container.querySelector('[data-span="myplate-clicks"]')).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("link", { name: "Plume Studio · Search clicks low · resolved 3 days ago after 1 day" })).toBeInTheDocument();
  });
});
