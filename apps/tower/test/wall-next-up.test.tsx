// Next up on the TV: the decisions waiting on the operator with the top one
// by name, the work held now and the week's done, drawn from a crafted
// payload. A count the snapshot did not measure is a word, never a zero.

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, OperatorPosture, WallNextUp, WallPayload } from "@shared/wall";
import type { WorkItem, WorkWeeks } from "@shared/work";
import { DEFAULT_WALL_LAYOUT, WALL_WIDGET_LIBRARY, type WallLayout } from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";
import { NextUp, decisionLine, decisionsFigure, workingLine } from "@/components/wall/NextUp";
import { wallLibraryOptions } from "@/lib/wall-editor";
import type { SnapshotProject } from "../worker/beads-snapshot";
import { wallNextUpOf } from "../worker/wall-payload";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-10-21T12:00:00.000Z") }));
vi.mock("@/hooks/useWallFeed", () => ({ useWallFeed: () => ({ data: undefined, isError: false }) }));

const FRESH = "2026-10-21T11:59:30.000Z";
const EMPTY_SERIES = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

const WEEKS: WorkWeeks = {
  weekStart: "2026-10-19",
  daysIn: 3,
  done: { now: 7, notDone: 1, before: 4, lastWeek: 9, move: { by: 3, direction: "up", verdict: "good" } },
  waiting: { now: 4, before: 2, added: 3, move: { by: 2, direction: "up", verdict: "bad" } },
  urgent: { now: 1, before: 1, added: 0, move: { by: 0, direction: "flat", verdict: "neutral" } },
  inProgress: { now: 3, before: 2, added: 2, move: { by: 1, direction: "up", verdict: "neutral" } },
  blocked: { now: 0, before: 1, added: 0, move: { by: -1, direction: "down", verdict: "good" } },
};

function card(id: string, displayName: string, over: Partial<AssetCard> = {}): AssetCard {
  return {
    netByMonthCurrency: "USD",
    id,
    displayName,
    status: "live",
    senseOnly: false,
    worstSeverity: null,
    openError: 0,
    openWarn: 0,
    booked: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-10",
    pulseReceivedAt: FRESH,
    firstReportAt: null,
    dataSources: [{ id: "uptime", label: "Uptime", state: "live" }],
    activeUsers: EMPTY_SERIES,
    work: {
      open: 3, highPriority: 1, inProgress: 2, blocked: 0, closedRecent: 7, priorities: null, capturedAt: FRESH, weeks: WEEKS,
    },
    panelReview: null,
    searchClicks: EMPTY_SERIES,
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    latestPanelDate: null,
    ...over,
  };
}

const MEADOW = card("meadow.example", "Meadow Board");
const ORCHARD = card("orchard.example", "Orchard Notes");

const OPERATOR: OperatorPosture = { waiting: 4, urgent: 1, measuredProjects: 2, urgentMeasuredProjects: 2, projectCount: 2, capturedAt: FRESH };

const NEXT: WallNextUp = {
  decisions: [
    { id: "md-1", title: "Pick which recipe page keeps the canonical address", asset: "meadow.example", ask: "choose", ageDays: 12, releases: 3 },
    { id: "or-2", title: "Approve the new pricing copy", asset: "orchard.example", ask: "approve", ageDays: 9, releases: null },
    { id: "md-3", title: "Answer the sitemap question", asset: "meadow.example", ask: "answer", ageDays: null, releases: null },
    { id: "or-4", title: "Answer the redirect question", asset: "orchard.example", ask: "answer", ageDays: 2, releases: null },
  ],
  oldestAgeDays: 12,
  working: [
    { id: "or-9", title: "Restore the checkout button", asset: "orchard.example", who: "claude", sinceHours: 2, urgent: true },
    { id: "md-8", title: "Resize the recipe images", asset: "meadow.example", who: "codex", sinceHours: 5, urgent: false },
    { id: "md-7", title: "Rewrite the about page", asset: "meadow.example", who: null, sinceHours: null, urgent: false },
  ],
  capturedAt: FRESH,
};

function draw(props: Partial<Parameters<typeof NextUp>[0]> = {}) {
  return render(
    <MemoryRouter>
      <div className="wall-root">
        <NextUp next={NEXT} operator={OPERATOR} assets={[MEADOW, ORCHARD]} workAssets={[MEADOW]} nowMs={NOW} {...props} />
      </div>
    </MemoryRouter>,
  );
}

describe("NextUp", () => {
  it("draws the count in warn, the top decision by name, the next ones as marks with their ages", () => {
    draw();
    const section = screen.getByRole("region", { name: "Next up" });
    expect(within(section).getByText("Needs you")).toBeInTheDocument();
    const count = section.querySelector("[data-next-count]")!;
    expect(count.textContent).toBe("4");
    expect(count.className).toContain("text-warn");
    expect(count.className).toContain("text-wall-display");
    expect(section.querySelector("[data-next-count-words]")!.textContent).toBe("decisions · oldest 12 days");

    const top = section.querySelector('[data-next-top="md-1"]')!;
    expect(top.getAttribute("data-next-ask")).toBe("choose");
    expect(top.querySelector("[data-next-top-title]")!.textContent).toBe(
      "Needs your choice: Pick which recipe page keeps the canonical address",
    );
    expect(top.querySelector("[data-next-top-title]")!.className).toContain("text-wall-strip");
    expect(top.querySelector("[data-next-top-line]")!.textContent).toBe("Meadow Board · 12 days · holds 3 tasks");

    const then = section.querySelector("[data-next-then]")!;
    expect(then.textContent).toContain("then these");
    const items = [...then.querySelectorAll("[data-next-then-item]")];
    expect(items.map((node) => node.getAttribute("data-next-then-item"))).toEqual(["or-2", "md-3", "or-4"]);
    expect(items[0]!.textContent).toContain("9d");
    expect(items[0]!.querySelector('[data-property-favicon="orchard.example"]')).not.toBeNull();
    // An age the snapshot did not record is left out, never drawn as 0d.
    expect(items[1]!.textContent).not.toMatch(/\dd$/);
  });

  it("lists the agents' work: urgent with the bolt in the urgent colour, the rest with a green dot", () => {
    draw();
    const agents = document.querySelector("[data-next-agents]")!;
    expect(within(agents as HTMLElement).getByText("The agents · now")).toBeInTheDocument();
    const rows = [...agents.querySelectorAll("[data-next-working]")];
    expect(rows.map((row) => row.getAttribute("data-next-working"))).toEqual(["or-9", "md-8", "md-7"]);
    const bolt = within(rows[0] as HTMLElement).getByRole("img", { name: "Urgent" });
    expect(bolt.getAttribute("class")).toContain("text-urgent");
    expect(rows[1]!.querySelector("[data-next-dot]")!.className).toContain("bg-healthy");
    expect(rows[0]!.textContent).toContain("Orchard Notes · claude · 2h in");
    expect(rows[1]!.textContent).toContain("Meadow Board · codex · 5h in");
    expect(rows[2]!.textContent).toContain("Rewrite the about page");
    expect(rows[2]!.textContent).toMatch(/Meadow Board$/);

    const done = agents.querySelector("[data-next-done]")!;
    expect(done.getAttribute("data-next-done")).toBe("7");
    expect(done.textContent).toContain("7 done this week");
    expect(done.textContent).toContain("vs last week by today");
  });

  it("opens each task it names: the top decision, each one after it and each agent row, and draws no button", () => {
    draw();
    const section = screen.getByRole("region", { name: "Next up" });
    const top = section.querySelector<HTMLElement>("[data-next-top-title]")!;
    expect(within(top).getByRole("link", { name: "Pick which recipe page keeps the canonical address" })).toHaveAttribute("href", "/tasks/md-1");
    const then = [...section.querySelectorAll<HTMLElement>("[data-next-then-item]")];
    expect(then.map((item) => within(item).getByRole("link").getAttribute("href"))).toEqual(["/tasks/or-2", "/tasks/md-3", "/tasks/or-4"]);
    // A mark's link is named by the decision's title and site.
    expect(within(then[0]!).getByRole("link")).toHaveAccessibleName(/^Approve the new pricing copy, Orchard Notes/);
    const rows = [...section.querySelectorAll<HTMLElement>("[data-next-working]")];
    expect(rows.map((row) => within(row).getByRole("link").getAttribute("href"))).toEqual(["/tasks/or-9", "/tasks/md-8", "/tasks/md-7"]);
    expect(section.querySelectorAll("a")).toHaveLength(7);
    expect(section.querySelector("button")).toBeNull();
  });

  it("words an unmeasured count as the Wall does, never as zero", () => {
    draw({ operator: null, next: null, workAssets: [card("bare.example", "Bare", { work: null })] });
    const section = screen.getByRole("region", { name: "Next up" });
    expect(section.querySelector("[data-next-count]")).toBeNull();
    expect(section.querySelector("[data-next-count-unread]")!.textContent).toBe("Tasks unknown");
    expect(section.querySelector("[data-next-agents-unread]")!.textContent).toBe("Tasks unknown");
    expect(section.querySelector("[data-next-done]")!.textContent).toBe("Done this week unknown");
    expect(section.textContent).not.toMatch(/\b0\b/);
    for (const word of [/snapshot/i, /\bstale\b/i, /\bjobs?\b/i, /provisional/i]) expect(section.textContent).not.toMatch(word);
  });

  it("draws a lower bound when a project went uncounted, and an old zero as out of date", () => {
    expect(decisionsFigure({ ...OPERATOR, waiting: 3, measuredProjects: 1 }, NOW)).toEqual({ kind: "count", count: 3, text: "at least 3", partial: true });
    expect(decisionsFigure({ ...OPERATOR, waiting: 0, measuredProjects: 1 }, NOW)).toEqual({ kind: "word", text: "Tasks unknown" });
    const old = { ...OPERATOR, waiting: 0, capturedAt: "2026-10-21T09:00:00.000Z" };
    expect(decisionsFigure(old, NOW)).toEqual({ kind: "word", text: "Tasks out of date" });
    // A count above zero stays a count however old the reading.
    expect(decisionsFigure({ ...old, waiting: 2 }, NOW)).toMatchObject({ kind: "count", text: "2" });
    expect(decisionsFigure({ ...OPERATOR, waiting: 0, capturedAt: null }, NOW)).toEqual({ kind: "word", text: "Tasks unknown" });

    draw({ operator: { ...OPERATOR, waiting: 3, measuredProjects: 1 } });
    expect(document.querySelector("[data-next-count]")!.textContent).toBe("at least 3");
    expect(document.querySelector("[data-next-count-words]")!.textContent).toBe("decisions · oldest 12 days");
  });

  it("says what the top decision holds when the snapshot records the links, and nothing when it records none", () => {
    const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({ id, title: `Task ${id}`, status: "open", priority: 2, issueType: "task",
      assignee: null, updatedAt: null, closedAt: null, parent: null, deferUntil: null, createdAt: "2026-10-12T12:00:00.000Z", ...over });
    const meadow = (over: Partial<SnapshotProject>): SnapshotProject => ({ asset: "meadow.example", prefix: "md", ok: true, error: null,
      counts: { open: 3, highPriority: 0, ready: 0, inProgress: 0, blocked: 2, closedRecent: 0, deferred: 0, waiting: 1 }, priorities: null, epics: null,
      ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [], waitingUrgent: 0, panelReview: undefined, handoffs: undefined, ...over });
    const waits = { dependencies: [{ id: "md-gate", type: "blocks" }] };
    const linked = wallNextUpOf({ capturedAt: FRESH, projects: [meadow({
      waiting: [item("md-gate", { issueType: "gate", dependencies: [] })], blocked: [item("md-a", waits), item("md-b", waits)] })] }, new Date(NOW))!;
    expect(linked.decisions[0]!.releases).toBe(2);
    const { unmount } = draw({ next: linked });
    expect(document.querySelector("[data-next-top-line]")!.textContent).toBe("Meadow Board · 9 days · holds 2 tasks");
    unmount();
    const older = wallNextUpOf({ capturedAt: FRESH, projects: [meadow({ waiting: [item("md-gate", { issueType: "gate" })] })] }, new Date(NOW))!;
    expect(older.decisions[0]!.releases).toBeNull();
    draw({ next: older });
    expect(document.querySelector("[data-next-top-line]")!.textContent).toBe("Meadow Board · 9 days");
  });

  it("omits each clause the data lacks", () => {
    const bare = { id: "md-1", title: "T", asset: "meadow.example", ask: "answer" as const, ageDays: null, releases: null };
    expect(decisionLine(bare, "Meadow Board")).toBe("Meadow Board");
    expect(decisionLine({ ...bare, ageDays: 0, releases: 1 }, "Meadow Board")).toBe("Meadow Board · under a day · holds 1 task");
    expect(decisionLine({ ...bare, ageDays: 1, releases: 0 }, "Meadow Board")).toBe("Meadow Board · 1 day");
    expect(workingLine({ id: "x", title: "T", asset: "a", who: null, sinceHours: 0, urgent: false }, "Asset")).toBe("Asset · 0h in");
  });

  it("says nothing waits when the inbox is counted, fresh and empty", () => {
    draw({ operator: { ...OPERATOR, waiting: 0, urgent: 0 }, next: { ...NEXT, decisions: [], oldestAgeDays: null } });
    const count = document.querySelector("[data-next-count]")!;
    expect(count.textContent).toBe("0");
    expect(count.className).not.toContain("text-warn");
    expect(document.querySelector("[data-next-count-words]")!.textContent).toBe("decisions");
    expect(document.querySelector("[data-next-calm]")!.textContent).toBe("Nothing waits on you");
  });

  it("leaves out the decisions and work of an asset whose TV switch is off", () => {
    draw({ hidden: new Set(["meadow.example"]) });
    expect(document.querySelector('[data-next-top="or-2"]')).not.toBeNull();
    expect([...document.querySelectorAll("[data-next-then-item]")].map((node) => node.getAttribute("data-next-then-item"))).toEqual(["or-4"]);
    expect([...document.querySelectorAll("[data-next-working]")].map((node) => node.getAttribute("data-next-working"))).toEqual(["or-9"]);
  });

  it("says nothing is in progress when the snapshot holds no work", () => {
    draw({ next: { ...NEXT, working: [] } });
    expect(document.querySelector("[data-next-agents-none]")!.textContent).toBe("Nothing in progress");
  });
});

describe("Next up in the widget catalogue", () => {
  it("is in the library as Next up, one of a kind, offered by the editor's Add drawer", () => {
    const spec = WALL_WIDGET_LIBRARY.next;
    expect(spec.label).toBe("Next up");
    expect(spec.unique).toBe(true);
    expect(spec.hidesWhenEmpty).toBe(false);
    expect(spec.settings).toEqual([]);
    expect(wallLibraryOptions(DEFAULT_WALL_LAYOUT).find((option) => option.spec.type === "next")?.disabledReason).toBeNull();
  });

  it("is drawn by the Wall's canvas from the payload", () => {
    const layout: WallLayout = { version: 1, rows: [{ id: "one", height: "fill", widgets: [{ id: "next", type: "next", width: 1 }] }] };
    const payload = {
      generatedAt: FRESH,
      portfolio: {},
      system: { assetId: "root-os", hasPulse: true, spendTodayUsd: 0, dailyCapUsd: 1, ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 }, scheduledLanes: [] },
      dashboard: {},
      assets: [MEADOW, ORCHARD],
      attention: [],
      snoozed: [],
      operator: OPERATOR,
      next: NEXT,
      ledgerRecordedAt: null,
    } as unknown as WallPayload;
    render(<MemoryRouter><WallCanvas layout={layout} data={payload} nowMs={NOW} /></MemoryRouter>);
    const slot = document.querySelector('[data-wall-slot="next"]') as HTMLElement;
    expect(within(slot).getByRole("region", { name: "Next up" })).toBeInTheDocument();
    expect(slot.querySelector("[data-next-count]")!.textContent).toBe("4");
  });
});
