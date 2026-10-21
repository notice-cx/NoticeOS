import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ProjectJourneys, journeyScale, layoutJourney, placeJourneyLabels, type JourneyRow } from "@/components/viz/ProjectJourneys";
import { PROJECT_JOURNEYS_NOW_MS as NOW, PROJECT_JOURNEYS_WEEK_START, projectJourneyRows } from "@/components/viz/ProjectJourneys.fixtures";

// Every project on one time axis around today: today ruled through every
// row, a question as a run from the day it was asked, parked work at its
// wake-up, and no two labels drawn over each other.

const DAY = 86_400_000;

function draw(rows: readonly JourneyRow[] = projectJourneyRows) {
  return render(
    <MemoryRouter>
      <ProjectJourneys rows={rows} nowMs={NOW} weekStart={PROJECT_JOURNEYS_WEEK_START} />
    </MemoryRouter>,
  );
}

const row = (overrides: Partial<JourneyRow>): JourneyRow => ({
  id: "r", title: "A project", state: { label: "Ready", tone: "foreground" },
  done: [], inProgress: [], waiting: null, blocked: 0, parked: [], killDate: null, ...overrides,
});

describe("ProjectJourneys", () => {
  it("rules today through every row, under today's date, with a tick on each Monday", () => {
    const { container } = draw();
    expect(container.querySelector("[data-journeys-today]")).toHaveStyle({ left: "calc(var(--journey-label) + (100% - var(--journey-label)) * 0.5)" });
    expect(container.querySelector("[data-journeys-today-label]")).toHaveTextContent("Today · Oct 21");
    const ticks = [...container.querySelectorAll("[data-journeys-tick]")].map((node) => node.textContent);
    // This week's Monday sits under today's label and gives way to it.
    expect(ticks).toEqual(["Sep 28", "Oct 5", "Oct 12", "Oct 26", "Nov 2", "Nov 9", "Nov 16"]);
    expect(container.querySelectorAll("[data-journey-track]")).toHaveLength(3);
  });

  it("draws a question as a run from the day it was asked, labelled with its wait", () => {
    const { container } = draw();
    const track = container.querySelector<HTMLElement>('[data-journey-track="mw-e1"]')!;
    const span = track.querySelector<HTMLElement>('[data-journey-mark="waiting"]')!;
    // Asked nine days ago on an eight-week axis centred on today.
    expect(parseFloat(span.style.left)).toBeCloseTo(50 - (9 / 56) * 100, 5);
    expect(parseFloat(span.style.width)).toBeCloseTo((9 / 56) * 100, 5);
    expect(track.querySelector('[data-journey-asked="approve"]')).not.toBeNull();
    expect(within(track).getByText("Approve the new schema · waiting 9d")).toHaveAttribute("data-side", "below");
    expect(track.querySelectorAll('[data-journey-mark="blocked"]')).toHaveLength(2);
    expect(within(track).getByText("2 blocked")).toBeInTheDocument();
  });

  it("puts a parked task at its wake-up and a kill date ahead, with the planned track to the last", () => {
    const { container } = draw();
    const track = container.querySelector<HTMLElement>('[data-journey-track="nw-e2"]')!;
    const parked = track.querySelector<HTMLElement>('[data-journey-mark="parked"]')!;
    expect(parked).toHaveClass("viz-hatch");
    expect(parseFloat(parked.style.left)).toBeCloseTo(50 + (12 / 56) * 100, 0);
    expect(within(track).getByText("parked until Nov 2")).toBeInTheDocument();
    expect(within(track).getByText("Kill date Nov 14")).toBeInTheDocument();
    const planned = track.querySelector<HTMLElement>("[data-journey-planned]")!;
    expect(parseFloat(planned.style.width)).toBeCloseTo((24 / 56) * 100, 0);
  });

  it("names each row's state and says the row in words", () => {
    draw();
    expect(screen.getByText("Needs you · 9d")).toHaveClass("text-warn");
    expect(screen.getByText(/Recipe schema overhaul, Meadow: Needs you · 9d\. 4 done in these weeks\. Approve the new schema waiting on you 9 days\. 2 blocked/)).toHaveClass("sr-only");
  });

  it("lists every mark in the legend", () => {
    const { container } = draw();
    expect([...container.querySelectorAll("[data-journeys-legend] li")].map((node) => node.textContent))
      .toEqual(["Done", "In progress", "Waiting on you, from the day it was asked", "Blocked", "Planned", "Parked"]);
  });
});

describe("placeJourneyLabels", () => {
  it("moves a colliding label over the track, and leaves out one with both sides taken", () => {
    const placed = placeJourneyLabels([
      { key: "a", text: "parked until Nov 2", px: 400 },
      { key: "b", text: "Kill date Nov 3", px: 430 },
      { key: "c", text: "parked until Nov 4", px: 460 },
      { key: "d", text: "Kill date Dec 30", px: 700 },
    ], 720);
    expect(placed.map((label) => [label.key, label.side])).toEqual([["a", "below"], ["b", "above"], ["c", null], ["d", "below"]]);
    // Near the axis's end a label runs back from its mark rather than past the box.
    expect(placed.find((label) => label.key === "d")?.align).toBe("end");
  });

  it("never draws two labels on one side over each other in a crowded row", () => {
    const scale = journeyScale(NOW, PROJECT_JOURNEYS_WEEK_START);
    const crowded = row({
      waiting: { title: "Choose the hero image", from: new Date(NOW - 2 * DAY).toISOString(), verb: "choose" },
      blocked: 3,
      parked: [{ title: "One", until: new Date(NOW + 2 * DAY).toISOString() }, { title: "Two", until: new Date(NOW + 3 * DAY).toISOString() }],
      killDate: new Date(NOW + 4 * DAY).toISOString().slice(0, 10),
    });
    const { labels } = layoutJourney(crowded, scale, NOW, 720);
    for (const side of ["below", "above"] as const) {
      const drawn = labels.filter((label) => label.side === side).map((label) => {
        const width = label.text.length * 6.2;
        const start = label.align === "start" ? label.px : label.px - width;
        return [start, start + width] as const;
      }).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < drawn.length; i += 1) expect(drawn[i]![0]).toBeGreaterThanOrEqual(drawn[i - 1]![1]);
    }
    expect(labels.filter((label) => label.side !== null).length).toBeGreaterThanOrEqual(2);
  });
});
