// @vitest-environment node
// The agents' week: four counts and up to three plain lines.

import { describe, expect, it } from "vitest";
import type { AssetCard, CardWatches, WorkSummary } from "@shared/wall";
import { emptyWorkHistory, type WorkEvent, type WorkPayload, type WorkProject, type WorkWeeks } from "@shared/work";
import { agentsWeek } from "@/lib/agents-week";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const ZERO = { currency: "USD", revenue: 0, cost: 0, net: 0 };
const NO_TREND = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

function weeks(doneNow: number | null): WorkWeeks {
  const state = { now: 1, before: 1, added: 0, move: null };
  return {
    weekStart: "2026-10-19", daysIn: 1,
    done: { now: doneNow, notDone: 0, before: 0, lastWeek: 3, move: null },
    waiting: state, urgent: state, inProgress: state, blocked: state,
  };
}

function work(inProgress: number, week?: WorkWeeks): WorkSummary {
  return {
    open: 4, highPriority: 0, inProgress, blocked: 0, closedRecent: 2, priorities: null,
    capturedAt: "2026-10-19T11:00:00.000Z", ...(week ? { weeks: week } : {}),
  };
}

function card(id: string, over: Partial<AssetCard> = {}): AssetCard {
  return {
    id, displayName: id, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: ZERO, forecast: ZERO, netPeriod: "2026-10", netByMonthCurrency: "USD",
    pulseReceivedAt: null, firstReportAt: null, dataSources: [],
    activeUsers: NO_TREND, searchClicks: NO_TREND, netByMonth: [], netByMonthProvisionalFrom: null,
    work: null, panelReview: null, latestPanelDate: null,
    ...over,
  };
}

function watches(open: number, latest: Partial<NonNullable<CardWatches["latest"]>> | null): CardWatches {
  return {
    open,
    latest: latest === null ? null : { id: "w1", ref: "annotation:1", outcome: null, nextCheckDate: null, closedAt: null, ...latest },
  };
}

function project(asset: string, recentWork: WorkEvent[]): WorkProject {
  return {
    asset, prefix: "t", name: asset, ok: true, error: null,
    counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
    history: emptyWorkHistory(), priorities: null, epics: null,
    ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [], recentWork,
  };
}

function payload(projects: WorkProject[]): WorkPayload {
  return { generatedAt: "2026-10-19T12:00:00.000Z", capturedAt: "2026-10-19T11:00:00.000Z", pollCadenceHours: 1 / 60, owner: "config/beads.json", projects, historyDays: 30 };
}

function closed(title: string, at: string, evidence: string | null, over: Partial<WorkEvent> = {}): WorkEvent {
  return { kind: "closed", taskId: `t-${title}`, title, by: "agent", model: null, at, evidence, ...over };
}

describe("agentsWeek counts", () => {
  it("adds in-progress and this week's done across the assets with a task project", () => {
    const week = agentsWeek(
      [card("a.example.com", { work: work(2, weeks(3)) }), card("b.example.com", { work: work(1, weeks(4)) }), card("c.example.com")],
      null,
      NOW,
    );
    expect(week).toMatchObject({ building: 3, shipped: 7, proven: 0, watching: 0, latest: [] });
  });

  it("states nothing measured as null, never zero", () => {
    expect(agentsWeek([card("a.example.com"), card("b.example.com")], null, NOW)).toMatchObject({ building: null, shipped: null });
    // A project without a week makes the total unknown.
    expect(agentsWeek([card("a.example.com", { work: work(2, weeks(3)) }), card("b.example.com", { work: work(1) })], null, NOW))
      .toMatchObject({ building: 3, shipped: null });
    expect(agentsWeek([card("a.example.com", { work: work(2, weeks(null)) })], null, NOW).shipped).toBeNull();
  });

  it("counts proven assets and the bets still being watched", () => {
    const week = agentsWeek(
      [
        card("a.example.com", { watches: watches(1, { outcome: "ship_confirmed", closedAt: "2026-10-17T00:00:00.000Z" }) }),
        card("b.example.com", { watches: watches(2, { outcome: "kill_confirmed", closedAt: "2026-10-16T00:00:00.000Z" }) }),
        card("c.example.com", { watches: watches(0, null) }),
        card("d.example.com", { watches: null }),
        card("e.example.com"),
      ],
      null,
      NOW,
    );
    expect(week).toMatchObject({ proven: 1, watching: 3 });
  });
});

describe("agentsWeek lines", () => {
  it("lists up to three: closes with evidence and outcomes, newest first, then pending ones", () => {
    const cards = [
      card("a.example.com", { displayName: "Acorn", watches: watches(0, { outcome: "ship_confirmed", closedAt: "2026-10-18T09:00:00.000Z" }) }),
      card("b.example.com", { displayName: "Birch", watches: watches(1, { nextCheckDate: "2026-10-22" }) }),
    ];
    const work = payload([
      project("a.example.com", [
        closed("Faster sign-up page", "2026-10-19T08:00:00.000Z", "Sign-up loads in half the time · 3f2a1bc"),
        closed("No proof", "2026-10-19T09:00:00.000Z", null),
        closed("Dropped idea", "2026-10-19T10:00:00.000Z", "duplicate of another task", { resolution: "duplicate" }),
        { ...closed("Claimed", "2026-10-19T11:00:00.000Z", "x"), kind: "claimed" },
      ]),
      project("unknown.example.com", [closed("Fix the menu", "2026-10-17T08:00:00.000Z", "3f2a1bc · https://example.com/pr/1")]),
    ]);
    const week = agentsWeek(cards, work, NOW);
    // A finished task's line carries its id, which opens its page; a bet's has none.
    expect(week.latest).toEqual([
      { title: "Dropped idea", site: "Acorn", line: "duplicate of another task", task: "t-Dropped idea" },
      { title: "Faster sign-up page", site: "Acorn", line: "Sign-up loads in half the time", task: "t-Faster sign-up page" },
      { title: "Latest bet", site: "Acorn", line: "Worked" },
    ]);
    expect(agentsWeek(cards, null, NOW).latest).toEqual([
      { title: "Latest bet", site: "Acorn", line: "Worked" },
      { title: "Latest bet", site: "Birch", line: "We'll know in 3 days" },
    ]);
  });

  it("lists every asset's latest bet when the TV asks for every line", () => {
    const cards = ["a", "b", "c", "d"].map((id, index) =>
      card(`${id}.example.com`, { displayName: id.toUpperCase(), watches: watches(0, { outcome: "ship_confirmed", closedAt: `2026-10-1${index}T09:00:00.000Z` }) }),
    );
    expect(agentsWeek(cards, null, NOW).latest).toHaveLength(3);
    expect(agentsWeek(cards, null, NOW, Infinity).latest.map((line) => line.site)).toEqual(["D", "C", "B", "A"]);
  });

  it("puts each outcome in plain words", () => {
    const line = (latest: Partial<NonNullable<CardWatches["latest"]>>) =>
      agentsWeek([card("a.example.com", { watches: watches(0, latest) })], null, NOW).latest[0]!.line;
    const closedAt = "2026-10-18T00:00:00.000Z";
    expect(line({ outcome: "kill_confirmed", closedAt })).toBe("Did not help");
    expect(line({ outcome: "inconclusive", closedAt })).toBe("Changed nothing");
    expect(line({ outcome: "unmeasurable", closedAt })).toBe("Could not be measured");
    expect(line({ nextCheckDate: "2026-10-20" })).toBe("We'll know in 1 day");
    expect(line({ nextCheckDate: "2026-10-19" })).toBe("We'll know soon");
    expect(line({})).toBe("Still being watched");
  });
});
