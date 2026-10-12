import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { SourceKind } from "@shared/connection-status";
import {
  HealthGrid,
  cellSentence,
  healthProblems,
  healthStateOf,
  healthTally,
  healthTallyWords,
  problemSentence,
  type HealthRow,
} from "@/components/viz/HealthGrid";
import {
  HEALTH_COLUMNS,
  HEALTH_NOW_MS,
  HEALTH_ROWS,
  HEALTH_ROWS_HEALTHY,
  HEALTH_ROWS_NARROW,
  HEALTH_SYSTEM_COLUMNS,
} from "@/components/viz/HealthGrid.fixtures";

function draw(rows: readonly HealthRow[] = HEALTH_ROWS) {
  const view = render(
    <MemoryRouter>
      <HealthGrid rows={rows} columns={HEALTH_COLUMNS} nowMs={HEALTH_NOW_MS} />
    </MemoryRouter>,
  );
  const grid = view.container.querySelector<HTMLElement>("[data-health-grid]")!;
  const cell = (key: string) => grid.querySelector<HTMLElement>(`[data-health-cell="${key}"]`)!;
  const target = (key: string) => cell(key).querySelector<HTMLElement>("[data-health-target]")!;
  return { ...view, grid, cell, target };
}

describe("healthStateOf", () => {
  it("folds every source status into the grid's seven states", () => {
    const cases: [SourceKind, string][] = [
      ["working", "working"],
      ["collecting", "collecting"],
      ["key-accepted", "collecting"],
      ["not-checked", "collecting"],
      ["overdue", "overdue"],
      ["failing", "failing"],
      ["not-connected", "not-connected"],
      ["not-using", "not-using"],
      ["not-applicable", "not-using"],
      ["unknown", "unknown"],
    ];
    for (const [kind, state] of cases) expect(healthStateOf(kind)).toBe(state);
  });
});

describe("healthTally", () => {
  it("counts every cell once and leaves the deliberately unused out of play", () => {
    expect(healthTally(HEALTH_ROWS)).toEqual({
      working: 35,
      collecting: 1,
      failing: 3,
      overdue: 1,
      unknown: 0,
      notConnected: 6,
      notUsing: 6,
      inPlay: 46,
    });
  });

  it("says the counts in one order and drops the zeros", () => {
    expect(healthTallyWords(healthTally(HEALTH_ROWS))).toBe("35 working · 1 collecting · 3 failing · 1 overdue · 6 not connected");
    expect(healthTallyWords(healthTally(HEALTH_ROWS_NARROW))).toBe("19 working · 2 failing · 1 unknown · 2 not connected");
  });
});

describe("healthProblems", () => {
  it("puts the freshest failure first and lateness last", () => {
    const problems = healthProblems(HEALTH_ROWS, HEALTH_COLUMNS, HEALTH_NOW_MS);
    expect(problems.map((p) => `${p.row.name}:${p.column.id}:${p.cell.state}`)).toEqual([
      "Summit:uptime:failing",
      "Summit:bing-webmaster:failing",
      "System:backups:failing",
      "Mosaic Finder:gsc:overdue",
    ]);
    expect(problemSentence(problems[0]!)).toBe("Uptime on Summit, failing 37m");
    expect(problemSentence(problems[3]!)).toBe("Search Console on Mosaic Finder, overdue 1d");
  });

  it("ranks a week-old failure behind a fresh one, and names an unrecorded start", () => {
    const [fresh, stale] = healthProblems(HEALTH_ROWS_NARROW, HEALTH_COLUMNS, HEALTH_NOW_MS);
    expect(fresh!.column.id).toBe("uptime");
    expect(problemSentence(stale!)).toBe("Bing on Acorn Atlas, failing 67d");
    const unrecorded: HealthRow = { id: "x", name: "Example", cells: [{ column: "uptime", state: "failing" }] };
    const [problem] = healthProblems([unrecorded], HEALTH_COLUMNS, HEALTH_NOW_MS);
    expect(problemSentence(problem!)).toBe("Uptime on Example is failing");
  });

  it("reads a System row in its own columns", () => {
    const backups = healthProblems(HEALTH_ROWS, HEALTH_COLUMNS, HEALTH_NOW_MS).find((p) => p.row.id === "system")!;
    expect(backups.column).toBe(HEALTH_SYSTEM_COLUMNS[2]);
  });
});

describe("cellSentence", () => {
  it("names the subject, the source, the state with its age, and the reason", () => {
    const column = HEALTH_COLUMNS.find((c) => c.id === "bing-webmaster")!;
    const row = HEALTH_ROWS.find((r) => r.name === "Summit")!;
    const cell = row.cells.find((c) => c.column === "bing-webmaster")!;
    expect(cellSentence(row, column, cell, HEALTH_NOW_MS)).toBe("Summit · Bing · Failing since 6h ago · Bing refused the saved key");
  });

  it("names an absence instead of leaving it blank", () => {
    const column = HEALTH_COLUMNS[0]!;
    expect(cellSentence({ name: "Mosaic Finder" }, column, { column: column.id, state: "overdue" }, HEALTH_NOW_MS)).toBe(
      "Mosaic Finder · Nightly report · Overdue, since unknown",
    );
    expect(cellSentence({ name: "Mosaic Finder" }, column, { column: column.id, state: "not-connected" }, HEALTH_NOW_MS)).toBe(
      "Mosaic Finder · Nightly report · Not connected",
    );
  });
});

describe("HealthGrid", () => {
  it("names the worst failure at the head and states the tally as its bar", () => {
    const { grid } = draw();
    const headline = grid.querySelector("[data-health-headline]")!;
    expect(headline.getAttribute("data-health-headline")).toBe("failing");
    expect(headline.textContent).toContain("Uptime on Summit, failing 37m");
    expect(headline.textContent).toContain("and 3 more");
    expect(within(grid).getByRole("link", { name: "Uptime on Summit, failing 37m" }).getAttribute("href")).toBe(
      "/assets/summit.example.com/sources",
    );
    expect(within(grid).getByRole("img", { name: "35 working · 1 collecting · 3 failing · 1 overdue · 6 not connected" })).toBeTruthy();
    expect([...grid.querySelectorAll("[data-tally]")].map((item) => item.getAttribute("data-tally"))).toEqual([
      "working",
      "collecting",
      "failing",
      "overdue",
      "not-connected",
    ]);
  });

  it("says plainly when nothing is wrong", () => {
    const { grid } = draw(HEALTH_ROWS_HEALTHY);
    expect(grid.querySelector("[data-health-headline]")!.getAttribute("data-health-headline")).toBe("clear");
    expect(grid.textContent).toContain("Nothing failing or overdue");
  });

  it("keeps the given row order and draws every cell in its column", () => {
    const { grid, cell } = draw();
    expect([...grid.querySelectorAll("[data-health-row]")].map((row) => row.getAttribute("data-health-row"))).toEqual(
      HEALTH_ROWS.map((row) => row.id),
    );
    expect(grid.querySelectorAll("[data-health-cell]")).toHaveLength(6 * 8 + 4);
    expect(cell("summit.example.com:uptime").getAttribute("data-state")).toBe("failing");
    expect(cell("mosaic-finder.example.com:gsc").getAttribute("data-state")).toBe("overdue");
    expect(cell("ripple-index.example.com:ga4").getAttribute("data-state")).toBe("not-using");
    expect(cell("system:backups").getAttribute("data-state")).toBe("failing");
  });

  it("is a grid with labelled headers, and each cell link says its whole story", () => {
    const { grid, target } = draw();
    const table = within(grid).getByRole("grid", { name: "Data sources" });
    expect(within(table).getAllByRole("columnheader", { name: "Search Console" })).toHaveLength(1);
    expect(within(table).getByRole("columnheader", { name: "Backups" })).toBeTruthy();
    expect(within(table).getAllByRole("rowheader")).toHaveLength(HEALTH_ROWS.length);
    const uptime = target("summit.example.com:uptime");
    expect(uptime.tagName).toBe("A");
    expect(uptime.getAttribute("href")).toBe("/assets/summit.example.com/sources");
    expect(uptime.getAttribute("aria-label")).toBe(
      "Summit · Uptime · Failing since 37m ago · Checks stopped arriving; the home page itself answers",
    );
  });

  it("counts each row's working sources out of those in play", () => {
    const { grid } = draw();
    const rowText = (id: string) => grid.querySelector(`[data-health-row="${id}"] [data-health-live]`)!.textContent;
    expect(rowText("summit.example.com")).toBe("5 of 8 working");
    expect(rowText("ripple-index.example.com")).toBe("2 of 2 working");
    expect(rowText("system")).toBe("3 of 4 working");
  });

  it("names a row's problems for the narrow strip, freshest first", () => {
    const { grid } = draw();
    const problems = grid.querySelector('[data-health-row="summit.example.com"] [data-health-row-problems]')!;
    expect(problems.textContent).toBe("Uptime 37mBing 6h");
    expect(grid.querySelector('[data-health-row="plume-studio.example.com"] [data-health-row-problems]')).toBeNull();
  });

  it("marks a week-old failure quiet and a fresh one not", () => {
    const { cell } = draw(HEALTH_ROWS_NARROW);
    expect(cell("acorn-atlas.example.com:bing-webmaster").hasAttribute("data-quiet")).toBe(true);
    expect(cell("summit.example.com:uptime").hasAttribute("data-quiet")).toBe(false);
    expect(cell("acorn-atlas.example.com:ga4").getAttribute("data-state")).toBe("unknown");
  });

  it("draws a column the row has no reading for as unknown", () => {
    const { cell } = draw([{ id: "solo", name: "Solo", cells: [{ column: "uptime", state: "working" }] }]);
    expect(cell("solo:gsc").getAttribute("data-state")).toBe("unknown");
    expect(cell("solo:gsc").querySelector("[data-health-target]")!.getAttribute("aria-label")).toBe("Solo · Search Console · Unknown");
  });

  it("lights the row and column of the hovered cell and shows its story", () => {
    const { grid, target } = draw();
    fireEvent.pointerEnter(target("mosaic-finder.example.com:gsc"));
    expect(grid.querySelector('[data-health-row="mosaic-finder.example.com"]')!.hasAttribute("data-active")).toBe(true);
    expect(grid.querySelector("[data-health-crosshair]")).not.toBeNull();
    expect(within(grid).getAllByRole("columnheader").filter((h) => h.hasAttribute("data-active")).map((h) => h.title)).toEqual([
      "Search Console",
    ]);
    expect(grid.querySelector("[data-health-tooltip]")!.textContent).toBe(
      "Mosaic Finder · Search ConsoleOverdue since 1d agoYesterday's report has not arrived",
    );
    fireEvent.pointerLeave(target("mosaic-finder.example.com:gsc"));
    expect(grid.querySelector("[data-health-tooltip]")).toBeNull();
    expect(grid.querySelector("[data-health-crosshair]")).toBeNull();
  });

  it("is one tab stop, starting on the named problem, walked with the arrow keys", () => {
    const { grid, target } = draw();
    const stops = [...grid.querySelectorAll<HTMLElement>('[role="grid"] [tabindex="0"]')];
    expect(stops).toEqual([target("summit.example.com:uptime")]);

    const start = target("summit.example.com:bing-webmaster");
    act(() => start.focus());
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(document.activeElement).toBe(target("summit.example.com:ga4"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(target("system:nightly-report"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(target("system:backups"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(target("system:nightly-report"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement!.getAttribute("href")).toBe("/health");
    expect([...grid.querySelectorAll('[role="grid"] [tabindex="0"]')]).toEqual([document.activeElement]);

    const nightly = target("system:nightly-report");
    act(() => nightly.focus());
    expect(grid.querySelector("[data-health-tooltip]")).not.toBeNull();
    fireEvent.keyDown(nightly, { key: "Escape" });
    expect(grid.querySelector("[data-health-tooltip]")).toBeNull();
  });

  it("wraps a long name between its words rather than cutting it", () => {
    render(
      <MemoryRouter>
        <HealthGrid rows={HEALTH_ROWS} columns={HEALTH_COLUMNS} nowMs={HEALTH_NOW_MS} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Lantern Works" });
    expect(link.getAttribute("title")).toBe("Lantern Works");
    expect(link.className).not.toContain("truncate");
    expect(link.className).not.toContain("line-clamp");
  });

  it("names an empty grid instead of drawing nothing", () => {
    const { grid } = draw([]);
    expect(grid.querySelector("[data-health-empty]")!.textContent).toBe("No sites yet");
    expect(grid.querySelector('[role="grid"]')).toBeNull();
  });
});
