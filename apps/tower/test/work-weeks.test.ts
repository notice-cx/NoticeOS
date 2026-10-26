// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  emptyWorkHistory,
  sumWorkWeeks,
  weekMove,
  workWeeks,
  type WorkCloses,
  type WorkCountsHistory,
} from "@shared/work";
import type { SeriesPoint } from "@shared/wall";
import { TASK_RESOLUTIONS } from '../../../packages/contract/src/task-resolution.mjs';

const DAY = 86_400_000;

/** One point a day, oldest first, ending on `last`. */
function days(last: string, values: readonly number[]): SeriesPoint[] {
  const end = Date.parse(`${last}T00:00:00.000Z`);
  return values.map((v, i) => ({ t: new Date(end - (values.length - 1 - i) * DAY).toISOString().slice(0, 10), v }));
}

/** 21 days of states ending on Wednesday 2026-10-14. */
function history21(): WorkCountsHistory {
  return {
    ...emptyWorkHistory(),
    // Closes by day: what In and out draws, and nothing the week counts read.
    closed: days("2026-10-14", Array.from({ length: 21 }, () => 50)),
    // Seven days before today (10-07) is index 13; today is index 20.
    blocked: days("2026-10-14", [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 2, 3, 3, 5, 4, 6, 6, 5]),
    inProgress: days("2026-10-14", Array.from({ length: 21 }, () => 4).map((v, i) => (i === 20 ? 6 : v))),
    waiting: days("2026-10-14", Array.from({ length: 21 }, (_, i) => (i >= 13 ? 3 + (20 - i) : 7))),
    urgent: days("2026-10-14", Array.from({ length: 21 }, () => 2)),
  };
}

/** 08:00 on Wednesday 2026-10-14 in Los Angeles: the week began on Monday 10-12. */
const WEDNESDAY = new Date("2026-10-14T15:00:00.000Z");

/** Closes around two Los Angeles weeks, read from 2026-09-29 as the poller's
 * fifteen days reach. Times are UTC; the comment is the Los Angeles time. */
function closes(): WorkCloses {
  return {
    since: "2026-09-29",
    items: [
      { at: "2026-10-04T18:00:00.000Z" }, // Sun 10-04 11:00, the week before last
      { at: "2026-10-05T16:00:00.000Z" }, // Mon 10-05 09:00
      { at: "2026-10-06T16:00:00.000Z", resolution: "duplicate" }, // Tue 10-06, shipped nothing
      { at: "2026-10-07T14:00:00.000Z" }, // Wed 10-07 07:00, before this time last week
      { at: "2026-10-07T17:00:00.000Z" }, // Wed 10-07 10:00, after it
      { at: "2026-10-09T20:00:00.000Z" }, // Fri 10-09
      { at: "2026-10-12T06:30:00.000Z" }, // Sun 10-11 23:30: Monday in UTC, last week here
      { at: "2026-10-12T16:00:00.000Z" }, // Mon 10-12 09:00
      { at: "2026-10-13T16:00:00.000Z" }, // Tue 10-13
      { at: "2026-10-13T18:00:00.000Z" }, // Tue 10-13
      { at: "2026-10-14T14:00:00.000Z", resolution: "wont-do" }, // Wed 10-14 07:00
      { at: "2026-10-14T14:30:00.000Z" }, // Wed 10-14 07:30
    ],
  };
}

describe("workWeeks: done from the closes", () => {
  it("stops cumulative evidence at the source observation and rejects a previous-week snapshot", () => {
    const stale = workWeeks(emptyWorkHistory(), { ...closes(), observedAt: "2026-10-13T19:00:00Z" }, WEDNESDAY, "America/Los_Angeles");
    expect(stale.done.history).toEqual([{ t: "2026-10-12", v: 1 }, { t: "2026-10-13", v: 3 }]);
    expect(stale.done.now).toBe(3);
    const old = workWeeks(emptyWorkHistory(), { ...closes(), observedAt: "2026-10-11T17:00:00Z" }, WEDNESDAY, "America/Los_Angeles");
    expect(old.done.now).toBeNull();
    expect(old.done.history).toBeUndefined();
    const later = workWeeks(emptyWorkHistory(), { ...closes(), observedAt: WEDNESDAY.toISOString() }, WEDNESDAY, "America/Los_Angeles");
    expect(sumWorkWeeks([stale, later])?.done.now).toBeNull();
    expect(sumWorkWeeks([stale, later])?.done.history).toBeUndefined();
  });

  it("compares the same local clock across daylight saving changes", () => {
    const week = workWeeks(emptyWorkHistory(), { since: "2026-10-15", items: [
      { at: "2026-10-25T16:30:00Z" },
      { at: "2026-10-25T17:30:00Z" },
      { at: "2026-11-01T17:30:00Z", resolution: "duplicate" },
      { at: "2026-11-01T19:00:00Z" },
    ] }, new Date("2026-11-01T18:00:00Z"), "America/Los_Angeles");
    expect(week.done.before).toBe(1);
    expect(week.done.history?.at(-1)).toEqual({ t: "2026-11-01", v: 1 });
    expect(week.done.history).toHaveLength(7);
  });

  it("keeps zero days only within complete coverage and omits missing evidence", () => {
    const complete = workWeeks(emptyWorkHistory(), { since: "2026-10-01", items: [] }, WEDNESDAY, "UTC");
    expect(complete.done.history).toEqual(days("2026-10-14", [0, 0, 0]));
    const partial = workWeeks(emptyWorkHistory(), { since: "2026-10-12", items: [] }, WEDNESDAY, "UTC");
    expect(partial.done.history).toBeUndefined();
    expect(partial.done.now).toBeNull();
    expect(workWeeks(emptyWorkHistory(), { since: "2026-02-31", items: [] }, WEDNESDAY, "UTC").done.now).toBeNull();
  });

  it("includes every supported resolution in both prior-week readings and rejects future or invalid times", () => {
    const items = ['2026-10-05', '2026-10-09', '2026-10-12'].flatMap(day => TASK_RESOLUTIONS.map(resolution => ({
      at: `${day}T12:00:00.000Z`, ...(resolution === 'done' ? {} : { resolution }),
    })));
    const week = workWeeks(emptyWorkHistory(), { since: '2026-09-29', items: [...items,
      { at: '2026-10-15T12:00:00.000Z', resolution: 'duplicate' }, { at: 'invalid' },
    ] }, WEDNESDAY, 'UTC');
    expect(week.done).toMatchObject({ now: 5, notDone: 4, before: 5, lastWeek: 10,
      move: { by: 0, direction: 'flat', verdict: 'neutral' } });
    expect(sumWorkWeeks([week, week])?.done).toMatchObject({ now: 10, before: 10, lastWeek: 20 });
  });
  it("counts every close reason this week and last week on the installation's clock", () => {
    const weeks = workWeeks(history21(), closes(), WEDNESDAY, "America/Los_Angeles");
    expect([weeks.weekStart, weeks.daysIn]).toEqual(["2026-10-12", 3]);
    expect(weeks.done).toMatchObject({
      // Mon, Tue, Tue, Won't do and Wed 07:30.
      now: 5,
      notDone: 1,
      // Mon, Tuesday's duplicate and Wed 10-07 07:00.
      before: 3,
      lastWeek: 6,
      move: { by: 2, direction: "up", verdict: "good" },
    });
  });

  it("puts a close in the week its own day falls in on the installation's clock, not UTC's", () => {
    const utc = workWeeks(history21(), closes(), WEDNESDAY, "UTC");
    // In UTC the 06:30 close on 10-12 is Monday's, so this week has one more and last week one fewer.
    expect(utc.done).toMatchObject({ now: 6, notDone: 1, lastWeek: 5 });
  });

  it("starts the week on the installation's Monday in a zone ahead of UTC", () => {
    // 01:00 Monday 10-19 in Auckland is still Sunday 12:00 in UTC.
    const now = new Date("2026-10-18T12:00:00.000Z");
    const ahead: WorkCloses = {
      since: "2026-10-03",
      items: [
        { at: "2026-10-18T10:30:00.000Z" }, // Sun 10-18 23:30 in Auckland
        { at: "2026-10-18T11:30:00.000Z" }, // Mon 10-19 00:30 in Auckland
      ],
    };
    const weeks = workWeeks(emptyWorkHistory(), ahead, now, "Pacific/Auckland");
    expect([weeks.weekStart, weeks.daysIn]).toEqual(["2026-10-19", 1]);
    // Last week's close came after this moment of its week.
    expect(weeks.done).toMatchObject({ now: 1, notDone: 0, lastWeek: 1, before: 0 });
  });

  it("reads a week the closes do not reach back to as unknown, never as short", () => {
    // A seven-day read: this week is whole, last week is not.
    const week = workWeeks(history21(), { ...closes(), since: "2026-10-07" }, WEDNESDAY, "America/Los_Angeles");
    expect(week.done).toMatchObject({ now: 5, notDone: 1, before: null, lastWeek: null, move: null });
    // The read's first day may be partial, so last week needs the day before its Monday.
    const boundary = workWeeks(history21(), { ...closes(), since: "2026-10-05" }, WEDNESDAY, "America/Los_Angeles");
    expect(boundary.done.lastWeek).toBeNull();
    const reaches = workWeeks(history21(), { ...closes(), since: "2026-10-04" }, WEDNESDAY, "America/Los_Angeles");
    expect(reaches.done.lastWeek).toBe(6);
  });

  it("has no done reading without closes, whatever the daily history holds", () => {
    const weeks = workWeeks(history21(), undefined, WEDNESDAY, "America/Los_Angeles");
    expect(weeks.done).toEqual({ now: null, notDone: null, before: null, lastWeek: null, move: null });
  });

  it("counts a week with no closes in it as zero, not unknown", () => {
    const weeks = workWeeks(emptyWorkHistory(), { since: "2026-09-29", items: [] }, WEDNESDAY, "America/Los_Angeles");
    expect(weeks.done).toMatchObject({ now: 0, notDone: 0, before: 0, lastWeek: 0, move: { by: 0, direction: "flat", verdict: "neutral" } });
  });
});

describe("workWeeks: the states from the daily history", () => {
  it("says a five-day history cannot reach seven days ago", () => {
    const short: WorkCountsHistory = { ...emptyWorkHistory(), blocked: days("2026-10-14", [1, 1, 2, 2, 3]) };
    const weeks = workWeeks(short, undefined, WEDNESDAY, "America/Los_Angeles");
    expect(weeks.blocked).toMatchObject({ now: 3, before: null, added: null, move: null });
    expect(weeks.waiting).toEqual({ now: null, before: null, added: null, move: null });
    expect(weeks.blocked.history?.map(point => point.v)).toEqual([null, null, null, 1, 1, 2, 2, 3]);
  });

  it("retains observed endpoints with explicit gaps instead of inventing the missing daily counts", () => {
    const sparse = workWeeks({ ...emptyWorkHistory(), blocked: [{ t: "2026-10-07", v: 5 }, { t: "2026-10-14", v: 2 }] }, undefined, WEDNESDAY, "UTC");
    expect(sparse.blocked.history?.map(point => point.v)).toEqual([5, null, null, null, null, null, null, 2]);
    expect(sparse.blocked.move).toEqual({ by: -3, direction: "down", verdict: "good" });
    expect(sparse.blocked.added).toBeNull();
    expect(sumWorkWeeks([sparse, sparse])?.blocked.history?.map(point => point.v)).toEqual([10, null, null, null, null, null, null, 4]);
  });

  it("reads each state now against seven days before, with how many entered it in between", () => {
    const weeks = workWeeks(history21(), undefined, WEDNESDAY, "America/Los_Angeles");
    // 2 → 3 → 3 → 5 → 4 → 6 → 6 → 5: rises of 1, 2 and 2.
    expect(weeks.blocked).toMatchObject({ now: 5, before: 2, added: 5, move: { by: 3, direction: "up", verdict: "bad" } });
    expect(weeks.inProgress).toMatchObject({ now: 6, before: 4, added: 2, move: { by: 2, direction: "up", verdict: "neutral" } });
    expect(weeks.waiting).toMatchObject({ now: 3, before: 10, added: 0, move: { by: -7, direction: "down", verdict: "good" } });
    expect(weeks.urgent).toMatchObject({ now: 2, before: 2, added: 0, move: { by: 0, direction: "flat", verdict: "neutral" } });
    expect(weeks.blocked.history?.map(point => point.v)).toEqual([2, 3, 3, 5, 4, 6, 6, 5]);
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
  it("sums matching calendar weeks across timezone metadata and rejects mismatched weeks", () => {
    const one = workWeeks(history21(), closes(), WEDNESDAY, "America/Los_Angeles");
    expect(one.done.history).toEqual([{ t: "2026-10-12", v: 1 }, { t: "2026-10-13", v: 3 }, { t: "2026-10-14", v: 5 }]);
    expect(sumWorkWeeks([one, one])?.done.history?.map(point => point.v)).toEqual([2, 6, 10]);
    expect(sumWorkWeeks([one, undefined])?.done.history).toBeUndefined();
    expect(sumWorkWeeks([one, { ...one, weekStart: "2026-10-05" }])?.done.now).toBeNull();
    expect(sumWorkWeeks([one, { ...one, timeZone: "UTC" }])?.done.now).toBe(10);
    const partial = { ...one, done: { ...one.done, history: undefined } };
    expect(sumWorkWeeks([one, partial])?.done.history).toBeUndefined();
    expect(sumWorkWeeks([one, partial])?.done.now).toBe(10);
    const mismatched = { ...one, blocked: { ...one.blocked, history: [{ t: "2026-10-14", v: 5 }] } };
    expect(sumWorkWeeks([one, mismatched])?.blocked.history).toBeUndefined();
  });
  it("adds the projects' weeks into the portfolio's", () => {
    const one = workWeeks(history21(), closes(), WEDNESDAY, "America/Los_Angeles");
    const sum = sumWorkWeeks([one, one]);
    expect(sum?.done).toMatchObject({ now: 10, notDone: 2, before: 6, lastWeek: 12, move: { by: 4, direction: "up", verdict: "good" } });
    expect(sum?.blocked).toMatchObject({ now: 10, before: 4, added: 10, move: { by: 6, direction: "up", verdict: "bad" } });
  });

  it("never passes a total that leaves a project out for a whole one", () => {
    const one = workWeeks(history21(), closes(), WEDNESDAY, "America/Los_Angeles");
    const sum = sumWorkWeeks([one, undefined]);
    expect(sum?.done).toEqual({ now: null, notDone: null, before: null, lastWeek: null, move: null });
    expect(sum?.blocked).toEqual({ now: null, before: null, added: null, move: null });
    const unread = sumWorkWeeks([one, workWeeks(history21(), undefined, WEDNESDAY, "America/Los_Angeles")]);
    expect(unread?.done.now).toBeNull();
    expect(sumWorkWeeks([undefined, null])).toBeNull();
  });
});
