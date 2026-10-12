import { describe, expect, it } from "vitest";
import type { LiveTask } from "@shared/tasks";
import { evidenceParts, readAgentWork, streakOf, taskPoints, type AgentProjectRead } from "@/lib/agent-work";

// Thursday 2026-10-15, noon UTC.
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const H = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

function task(over: Partial<LiveTask> & { id: string }): LiveTask {
  return {
    title: over.id, status: "closed", priority: 2, issueType: "task", assignee: "claude", updatedAt: null, closedAt: null,
    parent: null, deferUntil: null, description: "", acceptance: "", labels: [], ready: false, dependencies: [], comments: 0,
    metadata: null, createdAt: null, startedAt: null, closeReason: null, awaitType: null, ...over,
  };
}
/** A close recorded with its closer and model, as NoticeOS writes it. */
function closed(id: string, by: string, model: string | null, claimedHoursAgo: number, closedHoursAgo: number, over: Partial<LiveTask> = {}): LiveTask {
  return task({ id, assignee: by, startedAt: at(claimedHoursAgo), closedAt: at(closedHoursAgo), closeReason: `${id} done · abc1234`,
    metadata: { noticeos_closed_by: by, noticeos_closed_at: at(closedHoursAgo), ...(model ? { noticeos_closed_model: model, noticeos_claimed_model: model } : {}) },
    ...over });
}
const read = (tasks: LiveTask[]): AgentProjectRead[] => [{ project: "example.com", name: "Example", tasks }];

describe("readAgentWork", () => {
  const tasks = [
    closed("ex-1", "claude", "Opus 5.5", 30, 20, { priority: 1 }),
    closed("ex-2", "claude", "Opus 5.5", 50, 44),
    closed("ex-3", "claude", "Sonnet 5.5", 12, 10),
    closed("ex-4", "codex", "Verifier 1", 5, 2),
    closed("ex-5", "Mara", null, 80, 70),
    // The seven days before: counted against this week, not in it.
    closed("ex-6", "claude", "Opus 5.5", 210, 200),
    // Eight weeks back only reach the velocity chart.
    closed("ex-7", "claude", "Opus 5.5", 24 * 40 + 5, 24 * 40),
    task({ id: "ex-8", status: "in_progress", assignee: "claude", startedAt: at(3), metadata: { noticeos_claimed_model: "Opus 5.5" } }),
    task({ id: "ex-9", status: "blocked", assignee: "codex" }),
    task({ id: "ex-10", status: "open", assignee: null }),
  ];
  const work = readAgentWork(read(tasks), NOW, true);

  it("credits each close to who closed it, agents first, busiest first", () => {
    expect(work.workers.map((worker) => [worker.id, worker.agent, worker.week])).toEqual([
      ["claude", true, 3], ["codex", true, 1], ["Mara", false, 1],
    ]);
    const claude = work.workers[0]!;
    expect(claude.models).toEqual(["Opus 5.5", "Sonnet 5.5"]);
    expect(claude.inHand.map((entry) => entry.id)).toEqual(["ex-8"]);
    expect(claude.lastWeek).toBe(1);
    expect(work.workers[1]!.blocked.map((entry) => entry.id)).toEqual(["ex-9"]);
    expect([work.week, work.lastWeek, work.inHand, work.blocked]).toEqual([5, 1, 1, 1]);
  });

  it("stacks eight calendar weeks, the current one still counting", () => {
    expect(work.velocity.weeks).toHaveLength(8);
    expect(work.velocity.weeks.at(-1)).toMatchObject({ start: "2026-10-12", current: true });
    expect(work.velocity.weeks.reduce((sum, week) => sum + week.total, 0)).toBe(7);
    expect(work.velocity.keys[0]).toBe("claude");
  });

  it("races agents per model, ranked by priority-weighted points; a person is not in it", () => {
    expect(work.race.players.map((player) => [player.name, player.model, player.closes.length, player.points])).toEqual([
      ["claude", "Opus 5.5", 2, 5], ["claude", "Sonnet 5.5", 1, 2], ["codex", "Verifier 1", 1, 2],
    ]);
    expect(work.trophies.map((trophy) => [trophy.key, trophy.holder, trophy.value])).toEqual([
      ["most", "claude · Opus 5.5", "2"], ["fastest", "claude · Sonnet 5.5", "2 h"], ["streak", "claude", "3"], ["urgent", "claude · Opus 5.5", "1"],
    ]);
  });

  it("gives Most tasks closed to the most closes, not the most points", () => {
    const urgentPair = [closed("ur-1", "claude", "Opus 5.5", 6, 5, { priority: 0 }), closed("ur-2", "claude", "Opus 5.5", 8, 7, { priority: 0 })];
    const manyLow = [1, 2, 3].map((n) => closed(`lo-${n}`, "claude", "Haiku 5.5", 10 + n, 9 + n, { priority: 3 }));
    const contest = readAgentWork(read([...urgentPair, ...manyLow]), NOW, true);
    expect(contest.race.players[0]).toMatchObject({ model: "Opus 5.5", points: 10 });
    expect(contest.trophies.find((trophy) => trophy.key === "most")).toMatchObject({ holder: "claude · Haiku 5.5", value: "3" });
  });

  it("lists the week's claims and closes newest first", () => {
    expect(work.events.slice(0, 3).map((event) => [event.kind, event.task.id])).toEqual([
      ["closed", "ex-4"], ["claimed", "ex-8"], ["claimed", "ex-4"],
    ]);
  });

  it("falls back to the holder when no closer was recorded, and leaves last week unknown without the history", () => {
    const unrecorded = readAgentWork(read([task({ id: "ex-1", assignee: "claude", startedAt: at(5), closedAt: at(1) })]), NOW, false);
    expect(unrecorded.workers.map((worker) => [worker.id, worker.agent, worker.week, worker.lastWeek])).toEqual([["claude", false, 1, null]]);
    expect(unrecorded.lastWeek).toBeNull();
    expect(unrecorded.race.players).toEqual([]);
  });
});

describe("the contest's rules", () => {
  it("weights urgent work and counts a streak through today", () => {
    expect([0, 1, 2, 3, 4].map(taskPoints)).toEqual([5, 3, 2, 1, 1]);
    expect(streakOf([0, 1, 1, 1, 0, 2, 1])).toBe(2);
    expect(streakOf([1, 1, 1, 1, 1, 1, 0])).toBe(6);
    expect(streakOf([0, 0, 0, 0, 0, 0, 0])).toBe(0);
  });
});

describe("evidenceParts", () => {
  it("splits a close reason into its sentence, commit and links", () => {
    expect(evidenceParts("Exports pass · 3f2a91c · lightbrief.example/briefs · https://example.com/run/1")).toEqual([
      { kind: "text", text: "Exports pass", href: null },
      { kind: "commit", text: "3f2a91c", href: null },
      { kind: "link", text: "lightbrief.example/briefs", href: null },
      { kind: "link", text: "example.com/run/1", href: "https://example.com/run/1" },
    ]);
    expect(evidenceParts("Fixed in abc1234 with tests")).toEqual([{ kind: "text", text: "Fixed in abc1234 with tests", href: null }]);
  });
});
