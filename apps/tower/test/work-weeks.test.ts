// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  emptyWorkHistory,
  sumWorkWeeks,
  weekMove,
  workWeeks,
  type WorkCountsHistory,
} from "@shared/work";
import type { SeriesPoint } from "@shared/wall";

const DAY = 86_400_000;

/** One point a day, oldest first, ending on `last`. */
function days(last: string, values: readonly number[]): SeriesPoint[] {
  const end = Date.parse(`${last}T00:00:00.000Z`);
  return values.map((v, i) => ({ t: new Date(end - (values.length - 1 - i) * DAY).toISOString().slice(0, 10), v }));
}

/** 21 days ending on Wednesday 2026-10-14: closes 1..21 a day, so each week's
 * sum is checkable by hand. */
function history21(): WorkCountsHistory {
  const closed = Array.from({ length: 21 }, (_, i) => i + 1);
  return {
    ...emptyWorkHistory(),
    closed: days("2026-10-14", closed),
    // Seven days before today (10-07) is index 13; today is index 20.
    blocked: days("2026-10-14", [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 2, 3, 3, 5, 4, 6, 6, 5]),
    inProgress: days("2026-10-14", Array.from({ length: 21 }, () => 4).map((v, i) => (i === 20 ? 6 : v))),
    waiting: days("2026-10-14", Array.from({ length: 21 }, (_, i) => (i >= 13 ? 3 + (20 - i) : 7))),
    urgent: days("2026-10-14", Array.from({ length: 21 }, () => 2)),
  };
}

describe("workWeeks", () => {
  it("counts this calendar week's closes against last week's, Monday to today, in the installation's zone", () => {
    // 08:00 on Wednesday in Los Angeles: the week began on Monday 10-12.
    const weeks = workWeeks(history21(), new Date("2026-10-14T15:00:00.000Z"), "America/Los_Angeles");
    expect([weeks.weekStart, weeks.daysIn]).toEqual(["2026-10-12", 3]);
    // Mon..Wed are days 19, 20, 21; last Mon..Wed 12, 13, 14; last Mon..Sun 12..18.
    expect(weeks.done).toEqual({
      now: 19 + 20 + 21,
      partial: false,
      before: 12 + 13 + 14,
      lastWeek: 12 + 13 + 14 + 15 + 16 + 17 + 18,
      move: { by: 60 - 39, direction: "up", verdict: "good" },
    });
  });

  it("starts the week on the installation's Monday, not UTC's", () => {
    const history = { ...emptyWorkHistory(), closed: days("2026-10-19", Array.from({ length: 21 }, (_, i) => i + 1)) };
    // 20:00 Sunday in Los Angeles is 03:00 Monday UTC: still last week there,
    // with the history's new UTC day counted in the week it began in.
    const sunday = new Date("2026-10-19T03:00:00.000Z");
    const pacific = workWeeks(history, sunday, "America/Los_Angeles");
    expect([pacific.weekStart, pacific.daysIn]).toEqual(["2026-10-12", 7]);
    // Mon 10-12 .. Sun 10-18 are 14..20, and the UTC Monday 10-19 so far 21.
    expect(pacific.done.now).toBe(14 + 15 + 16 + 17 + 18 + 19 + 20 + 21);
    expect(pacific.done.before).toBe(7 + 8 + 9 + 10 + 11 + 12 + 13);
    const utc = workWeeks(history, sunday, "UTC");
    expect([utc.weekStart, utc.daysIn, utc.done.now, utc.done.before]).toEqual(["2026-10-19", 1, 21, 14]);
  });

  it("has nothing to compare while the installation's week has begun and the history's has not", () => {
    const history = { ...emptyWorkHistory(), closed: days("2026-10-18", Array.from({ length: 14 }, () => 2)) };
    // 01:00 Monday in Auckland is still Sunday in UTC.
    const weeks = workWeeks(history, new Date("2026-10-18T12:00:00.000Z"), "Pacific/Auckland");
    expect([weeks.weekStart, weeks.daysIn]).toEqual(["2026-10-19", 1]);
    expect(weeks.done).toEqual({ now: 0, partial: false, before: null, lastWeek: 14, move: null });
  });

  it("marks a week with a day the history does not hold as a lower bound, and draws no move from it", () => {
    const history = history21();
    history.closed = history.closed.filter((point) => point.t !== "2026-10-13");
    const weeks = workWeeks(history, new Date("2026-10-14T15:00:00.000Z"), "America/Los_Angeles");
    expect(weeks.done).toMatchObject({ now: 19 + 21, partial: true, before: 39, move: null });
  });

  it("says a five-day history cannot reach last week or seven days ago", () => {
    const short: WorkCountsHistory = {
      ...emptyWorkHistory(),
      closed: days("2026-10-14", [1, 2, 3, 4, 5]),
      blocked: days("2026-10-14", [1, 1, 2, 2, 3]),
    };
    const weeks = workWeeks(short, new Date("2026-10-14T15:00:00.000Z"), "America/Los_Angeles");
    expect(weeks.done).toEqual({ now: 3 + 4 + 5, partial: false, before: null, lastWeek: null, move: null });
    expect(weeks.blocked).toEqual({ now: 3, before: null, added: null, move: null });
    expect(weeks.waiting).toEqual({ now: null, before: null, added: null, move: null });
  });

  it("reads each state now against seven days before, with how many entered it in between", () => {
    const weeks = workWeeks(history21(), new Date("2026-10-14T15:00:00.000Z"), "America/Los_Angeles");
    // 2 → 3 → 3 → 5 → 4 → 6 → 6 → 5: rises of 1, 2 and 2.
    expect(weeks.blocked).toEqual({ now: 5, before: 2, added: 5, move: { by: 3, direction: "up", verdict: "bad" } });
    expect(weeks.inProgress).toEqual({ now: 6, before: 4, added: 2, move: { by: 2, direction: "up", verdict: "neutral" } });
    expect(weeks.waiting).toEqual({ now: 3, before: 10, added: 0, move: { by: -7, direction: "down", verdict: "good" } });
    expect(weeks.urgent).toEqual({ now: 2, before: 2, added: 0, move: { by: 0, direction: "flat", verdict: "neutral" } });
  });

  it("gives each figure its own better direction", () => {
    expect(weekMove("done", 5, 3)?.verdict).toBe("good");
    expect(weekMove("done", 3, 5)?.verdict).toBe("bad");
    expect(weekMove("blocked", 5, 3)?.verdict).toBe("bad");
    expect(weekMove("waiting", 5, 3)?.verdict).toBe("bad");
    expect(weekMove("urgent", 3, 5)?.verdict).toBe("good");
    expect(weekMove("inProgress", 5, 3)?.verdict).toBe("neutral");
    expect(weekMove("blocked", 4, null)).toBeNull();
  });
});

describe("sumWorkWeeks", () => {
  const now = new Date("2026-10-14T15:00:00.000Z");

  it("adds the projects' weeks into the portfolio's", () => {
    const one = workWeeks(history21(), now, "America/Los_Angeles");
    const sum = sumWorkWeeks([one, one]);
    expect(sum?.done).toEqual({ now: 120, partial: false, before: 78, lastWeek: 210, move: { by: 42, direction: "up", verdict: "good" } });
    expect(sum?.blocked).toEqual({ now: 10, before: 4, added: 10, move: { by: 6, direction: "up", verdict: "bad" } });
  });

  it("never passes a total that leaves a project out for a whole one", () => {
    const one = workWeeks(history21(), now, "America/Los_Angeles");
    const sum = sumWorkWeeks([one, undefined]);
    expect(sum?.done).toMatchObject({ now: 60, partial: true, before: null, move: null });
    expect(sum?.blocked).toEqual({ now: null, before: null, added: null, move: null });
    expect(sumWorkWeeks([undefined, null])).toBeNull();
  });
});
