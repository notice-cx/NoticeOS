import { describe, expect, it } from "vitest";
import type { BoardTask } from "@/lib/task-board-read";
import { rankBoard, taskAgeDays } from "@/lib/task-ranking";

// The ranking reads rows the board already drew; these are the smallest rows
// that exercise each list and reason.

const NOW = new Date("2026-10-21T12:00:00Z");

function row(over: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    title: over.id, status: "open", priority: 2, issueType: "task", assignee: null,
    updatedAt: "2026-10-20T12:00:00Z", closedAt: null, createdAt: "2026-10-14T12:00:00Z", parent: null, deferUntil: null,
    project: "example", labels: [], ready: true, awaitType: null, ...over,
  };
}

const CARD = { valuePerMonth: 1100, likelihood: 0.7, reviewMinutes: 10, daysToSignal: 14, measurability: "holdout" as const };

describe("the board is ranked by what each task is worth", () => {
  it("ranks the operator's decisions by score, then the board's own order for the rest", () => {
    const rich = row({ id: "ex-rich", labels: ["human"], card: CARD, decisionImpact: { priority: 1, proceeds: [{ id: "ex-a", title: "A" }, { id: "ex-b", title: "B" }] } });
    const thin = row({ id: "ex-thin", labels: ["human"], card: { ...CARD, valuePerMonth: 40 } });
    const bare = row({ id: "ex-bare", labels: ["human"], priority: 0, createdAt: "2026-10-01T12:00:00Z" });
    const ranked = rankBoard({ tasks: [bare, thin, rich], inbox: [bare, thin, rich], operatorRateUsdPerMin: 2, now: NOW });
    expect(ranked.decisions.map((entry) => entry.task.id)).toEqual(["ex-rich", "ex-thin", "ex-bare"]);
    expect(ranked.decisions.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    const first = ranked.decisions[0]!;
    expect(first.ask).toBe("answer");
    expect(first.score?.expectedPerMonth).toBeCloseTo(770);
    expect(first.why).toEqual([
      { kind: "releases", count: 2, titles: ["A", "B"] },
      { kind: "expected", perMonth: 770 },
      { kind: "waiting", days: 7 },
    ]);
    const last = ranked.decisions[2]!;
    expect(last.score).toBeNull();
    expect(last.why).toEqual([{ kind: "priority", band: "top" }, { kind: "waiting", days: 20 }, { kind: "no-card" }]);
    expect(ranked.carded).toBe(2);
    expect(ranked.policy).toBe("v1.0");
  });

  it("lists the agents' work with what is being worked first, then by score, and never a gate or an epic", () => {
    const working = row({ id: "ex-work", status: "in_progress", assignee: "claude" });
    const best = row({ id: "ex-best", card: { ...CARD, valuePerMonth: 900 } });
    const good = row({ id: "ex-good", card: { ...CARD, valuePerMonth: 300 } });
    const plain = row({ id: "ex-plain" });
    const gate = row({ id: "ex-gate", issueType: "gate", awaitType: "timer" });
    const epic = row({ id: "ex-epic", issueType: "epic" });
    const ranked = rankBoard({ tasks: [plain, good, gate, epic, best, working], inbox: [], operatorRateUsdPerMin: 2, now: NOW });
    expect(ranked.agents.map((entry) => entry.task.id)).toEqual(["ex-work", "ex-best", "ex-good", "ex-plain"]);
    expect(ranked.agents[0]!.state).toBe("in-progress");
    expect(ranked.agents[1]!.state).toBe("ready");
    expect(ranked.agents.every((entry) => entry.ask === null)).toBe(true);
  });

  it("holds back blocked, parked and not-worth-the-review work, each with its reason", () => {
    const blocked = row({ id: "ex-blocked", status: "blocked", ready: false, dependencies: [
      { id: "ex-open", type: "blocks", title: "Open blocker", status: "open" },
      { id: "ex-done", type: "blocks", title: "Closed blocker", status: "closed" },
      { id: "ex-rel", type: "related", title: "Related", status: "open" },
    ] });
    const waiting = row({ id: "ex-waiting", ready: false });
    const parked = row({ id: "ex-parked", status: "deferred", deferUntil: "2026-11-02T00:00:00Z" });
    const cheap = row({ id: "ex-cheap", card: { ...CARD, valuePerMonth: 10, reviewMinutes: 30 } });
    const ranked = rankBoard({ tasks: [blocked, waiting, parked, cheap], inbox: [], operatorRateUsdPerMin: 2, now: NOW });
    expect(ranked.agents).toEqual([]);
    expect(ranked.notNow.map((entry) => [entry.task.id, entry.reason.kind])).toEqual([
      ["ex-blocked", "blocked"], ["ex-waiting", "blocked"], ["ex-parked", "parked"], ["ex-cheap", "below-cost"],
    ]);
    expect(ranked.notNow[0]!.reason).toEqual({ kind: "blocked", by: [{ id: "ex-open", title: "Open blocker" }] });
    expect(ranked.notNow[2]!.reason).toEqual({ kind: "parked", until: "2026-11-02T00:00:00Z" });
    const cheapReason = ranked.notNow[3]!.reason;
    expect(cheapReason.kind === "below-cost" && cheapReason.expectedPerMonth).toBeCloseTo(7);
    expect(cheapReason.kind === "below-cost" && cheapReason.costUsd).toBe(60);
  });

  it("never lists a decision twice, and reads a card left in live metadata", () => {
    const asked = row({ id: "ex-asked", labels: ["human"] });
    const detail = { ...row({ id: "ex-detail" }), metadata: { noticeos_card: CARD } } as BoardTask;
    const ranked = rankBoard({ tasks: [asked, detail], inbox: [asked], operatorRateUsdPerMin: 2, now: NOW });
    expect(ranked.decisions.map((entry) => entry.task.id)).toEqual(["ex-asked"]);
    expect(ranked.agents.map((entry) => entry.task.id)).toEqual(["ex-detail"]);
    expect(ranked.agents[0]!.card).toEqual(CARD);
  });

  it("measures age from the filing date, else the last move, else not at all", () => {
    expect(taskAgeDays({ createdAt: "2026-10-14T12:00:00Z", updatedAt: "2026-10-20T12:00:00Z" }, NOW)).toBe(7);
    expect(taskAgeDays({ createdAt: null, updatedAt: "2026-10-20T12:00:00Z" }, NOW)).toBe(1);
    expect(taskAgeDays({ createdAt: null, updatedAt: null }, NOW)).toBeNull();
    expect(taskAgeDays({ createdAt: "soon", updatedAt: null }, NOW)).toBeNull();
  });
});
