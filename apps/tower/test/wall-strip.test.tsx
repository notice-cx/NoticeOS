// The Wall's one top strip: the local time/date, the next meeting and a
// recognizable countdown. System problems live in Needs you rather than as
// an aggregate header badge.

import { render } from "./render";
import { describe, expect, it, vi } from "vitest";
import type { CalendarUpcoming } from "@noticeos/contract";
import { NO_READS } from "@shared/connection-status";
import type { AssetCard, SystemBand } from "@shared/wall";
import {
  WallStrip,
  stripClock,
  stripCountdown,
  stripMeeting,
} from "@/components/wall/WallStrip";
import { NeedsYou } from "@/components/wall/NeedsYou";
import { failingSources, wallIssues } from "@/lib/wall-issues";
import { failingSourceCount, wallSystemState, withSystemIssues, type WallSystemStateKind } from "@/lib/wall-system-state";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** A fresh OS report exactly as the self-report sends it: no agents, no
 * queue, the backup ran three hours ago, spend under the pace. */
const HEALTHY: SystemBand = {
  assetId: "os",
  hasPulse: true,
  spendTodayUsd: 0.41,
  dailyCapUsd: 0.83,
  ingest: { fresh: 5, stale: 0, notExpected: 2, expected: 5 },
  scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: iso(-3 * HOUR) }],
};

function site(id: string, uptime: "live" | "degraded" | "skipped" = "live"): AssetCard {
  return {
    id,
    displayName: id,
    dataSources: [
      { id: "uptime", label: "Uptime", state: uptime, observedAt: iso(-20 * MINUTE), detail: uptime === "degraded" ? "Home page down" : undefined },
    ],
  } as AssetCard;
}

const CALENDAR: CalendarUpcoming = {
  monitoringAvailable: true,
  fetchedAt: iso(-MINUTE),
  feedsConfigured: 1,
  feedsOk: 1,
  calendars: [{ id: "work", color: null, status: "ok" }],
  meetings: [],
} as CalendarUpcoming;

/** Renders as a viewer whose locale is `locale`: every `Intl.DateTimeFormat`
 * the strip makes is made in it. */
function inLocale<T>(locale: string, run: () => T): T {
  const Real = Intl.DateTimeFormat;
  const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
    _locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new Real(locale, options);
  } as typeof Intl.DateTimeFormat);
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

function withMeetingIn(ms: number): CalendarUpcoming {
  return {
    ...CALENDAR,
    meetings: [{ calendar: "work", title: "Partner sync", startsAt: iso(ms), endsAt: iso(ms + 30 * MINUTE), allDay: false, location: null }],
  };
}

describe("the one system state", () => {
  const state = (system: SystemBand, failing = 0) => wallSystemState(system, failing, NOW);

  it("is healthy on a fresh OS report", () => {
    expect(state(HEALTHY)).toMatchObject({ kind: "healthy", severity: null, label: "System" });
  });

  it("names each failure in at most four words, with its tone", () => {
    const cases: [SystemBand, number, WallSystemStateKind, "error" | "warn", string][] = [
      [{ ...HEALTHY, hasPulse: false }, 0, "os-report-missing", "error", "OS report missing"],
      [{ ...HEALTHY, scheduledLanes: [{ job: "backup", outcome: "failed", startedAt: iso(-HOUR) }] }, 0, "job-failed", "error", "A scheduled job failed"],
      [{ ...HEALTHY, scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: iso(-3 * DAY) }] }, 0, "jobs-silent", "error", "Scheduled jobs silent"],
      [HEALTHY, 2, "sources-failing", "error", "2 sources failing"],
      [HEALTHY, 1, "sources-failing", "error", "1 source failing"],
      [{ ...HEALTHY, ingest: { ...HEALTHY.ingest, fresh: 4, stale: 1 } }, 0, "reports-stale", "warn", "1 report stale"],
      [{ ...HEALTHY, spendTodayUsd: 1.2 }, 0, "over-pace", "warn", "Over daily data pace"],
    ];
    for (const [system, failing, kind, severity, label] of cases) {
      expect(state(system, failing)).toMatchObject({ kind, severity, label });
      expect(label.split(" ").length).toBeLessThanOrEqual(4);
    }
  });

  it("lets the worst one win", () => {
    const everything: SystemBand = {
      ...HEALTHY,
      hasPulse: false,
      scheduledLanes: [{ job: "backup", outcome: "failed", startedAt: iso(-HOUR) }],
      ingest: { ...HEALTHY.ingest, stale: 2 },
      spendTodayUsd: 9,
    };
    expect(state(everything, 3).kind).toBe("os-report-missing");
    expect(state({ ...everything, hasPulse: true }, 3).kind).toBe("job-failed");
    expect(state({ ...everything, hasPulse: true, scheduledLanes: HEALTHY.scheduledLanes }, 3).kind).toBe("sources-failing");
    expect(state({ ...everything, hasPulse: true, scheduledLanes: HEALTHY.scheduledLanes }, 0).kind).toBe("reports-stale");
  });

  it("is never amber by construction: no recorded firing yet, a lane that stood down, a site not yet reporting", () => {
    // An installation with no OS row owes no OS report: a subject nobody set
    // up is calm, not red.
    expect(state({ ...HEALTHY, assetId: null, hasPulse: false })).toMatchObject({ kind: "healthy", severity: null });
    expect(state({ ...HEALTHY, scheduledLanes: [] }).kind).toBe("healthy");
    expect(state({ ...HEALTHY, scheduledLanes: [{ job: "backup", outcome: "skipped", startedAt: iso(-HOUR) }] }).kind).toBe("healthy");
    expect(state({ ...HEALTHY, ingest: { ...HEALTHY.ingest, notExpected: 3 } }).kind).toBe("healthy");
  });

  it("counts failing source kinds the way every other screen reads each source", () => {
    expect(failingSourceCount([site("a.example"), site("b.example")], NO_READS, NOW)).toBe(0);
    // One kind failing on two sites is one source to fix.
    expect(failingSourceCount([site("a.example", "degraded"), site("b.example", "degraded")], NO_READS, NOW)).toBe(1);
    // A source the operator marked Not using is never failing.
    expect(failingSourceCount([site("a.example", "skipped")], NO_READS, NOW)).toBe(0);
  });

  // The strip and Needs you read one derivation (`failingSources`), so one
  // screen never states two counts of one fact.
  it("agrees with Needs you when one provider fails on two sites", () => {
    const card = (id: string, uptime: "live" | "degraded" = "live"): AssetCard =>
      ({ ...site(id, uptime), status: "live", pulseReceivedAt: null, panelReview: null, latestPanelDate: null }) as AssetCard;
    const assets = [card("a.example", "degraded"), card("b.example", "degraded"), card("c.example")];
    const view = render(<WallStrip system={HEALTHY} assets={assets} nowMs={NOW} />);
    expect(view.container.querySelector("[data-system-state]")).toBeNull();
    const rows = wallIssues({ assets, attention: [], connections: NO_READS, nowMs: NOW }).filter((issue) =>
      issue.key.startsWith("source-"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site: "2 sites", line: "Uptime collection failing", assets: ["a.example", "b.example"] });
    expect(failingSources(assets, NO_READS, NOW).size).toBe(rows.length);
  });

  it("keeps simultaneous OS, scheduled-job and spend failures as specific ordered rows", () => {
    const broken = { ...HEALTHY, hasPulse: false, spendTodayUsd: 9, scheduledLanes: [{ job: "backup", outcome: "failed" as const, startedAt: iso(-HOUR) }] };
    const issues = withSystemIssues([], broken, NOW);
    expect(issues.map(issue => issue.key)).toEqual(["system-job-failed", "system-os-report-missing", "system-over-pace"]);
    expect(issues[0]?.line).toMatch(/backup.*failed/i);
    const view = render(<NeedsYou issues={[]} system={broken} nowMs={NOW} />);
    for (const condition of ["os-runner-health", "scheduled-lane-health", "budget-guardrail"]) {
      expect(view.container.querySelector(`[data-needs-row][data-material-condition~="${condition}"] svg`)).not.toBeNull();
    }
    expect(view.container.querySelectorAll("[data-needs-row]")).toHaveLength(3);
  });

  it("does not duplicate source/report rows or an already represented OS condition", () => {
    const existing = { key: "report-os", severity: "warn" as const, assets: ["os"], site: "OS", line: "No nightly report in 62h", mark: "Report late", since: iso(-HOUR), conditions: [] };
    expect(withSystemIssues([existing], { ...HEALTHY, hasPulse: false, ingest: { ...HEALTHY.ingest, stale: 2 } }, NOW)).toEqual([
      { ...existing, severity: "error", conditions: ["os-runner-health"] },
    ]);
    const sourceRows = wallIssues({ assets: [site("a.example", "degraded")], attention: [], connections: NO_READS, nowMs: NOW });
    expect(withSystemIssues(sourceRows, { ...HEALTHY, ingest: { ...HEALTHY.ingest, stale: 2 } }, NOW)).toEqual(sourceRows);
    const own = withSystemIssues([], { ...HEALTHY, spendTodayUsd: 9 }, NOW);
    expect(withSystemIssues(own, { ...HEALTHY, spendTodayUsd: 9 }, NOW)).toEqual(own);
  });

  it("keeps new installations and intentionally skipped schedules calm, but shows recorded silence", () => {
    expect(withSystemIssues([], { ...HEALTHY, assetId: null, hasPulse: false, scheduledLanes: [] }, NOW)).toEqual([]);
    expect(withSystemIssues([], { ...HEALTHY, scheduledLanes: [{ job: "backup", outcome: "skipped", startedAt: iso(-HOUR) }] }, NOW)).toEqual([]);
    expect(withSystemIssues([], { ...HEALTHY, scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: iso(-3 * DAY) }] }, NOW)[0]?.line).toBe("Scheduled jobs silent");
  });

});

describe("the strip's time, meeting and countdown", () => {
  it("keeps the locale's day period apart from the numerals, and has none in a 24-hour locale", () => {
    const twelve = stripClock(NOW, "en-US");
    expect(twelve.time).toMatch(/^\d{1,2}:\d{2}$/u);
    expect(twelve.dayPeriod).toMatch(/^(AM|PM)$/u);
    expect(twelve.dayPeriodFirst).toBe(false);
    const twentyFour = stripClock(NOW, "de-DE");
    expect(twentyFour.time).toMatch(/^\d{1,2}:\d{2}$/u);
    expect(twentyFour.dayPeriod).toBeNull();
    // A locale that writes the day period first keeps its own order.
    const first = stripClock(NOW, "ko-KR");
    expect(first.dayPeriod).not.toBeNull();
    expect(first.dayPeriodFirst).toBe(true);
  });

  it("says the next meeting today with its start and distance", () => {
    const next = stripMeeting(withMeetingIn(2.5 * HOUR), NOW);
    expect(next).toMatchObject({ title: "Partner sync", inProgress: false });
    expect(next !== null && typeof next === "object" ? next.distance : "").toBe("in 2h 30m");
  });

  it("says a meeting under way by how long is left", () => {
    const now = stripMeeting(withMeetingIn(-10 * MINUTE), NOW);
    expect(now).toMatchObject({ title: "Partner sync", distance: "20m left", inProgress: true });
  });

  it("says No meetings today only when a calendar could be read", () => {
    expect(stripMeeting(withMeetingIn(3 * DAY), NOW)).toBe("none-today");
    expect(stripMeeting({ ...CALENDAR, feedsOk: 0 }, NOW)).toBeNull();
    expect(stripMeeting(null, NOW)).toBeNull();
  });

  it("counts down in days, then hours and minutes on the last day", () => {
    expect(stripCountdown(NOW, iso(12 * DAY + 3 * HOUR))).toBe("12 days");
    expect(stripCountdown(NOW, iso(DAY))).toBe("1 day");
    expect(stripCountdown(NOW, iso(5 * HOUR + 10 * MINUTE))).toBe("5 hours");
    expect(stripCountdown(NOW, iso(40 * MINUTE))).toBe("40 min");
    expect(stripCountdown(NOW, iso(-HOUR))).toBe("Reached");
    expect(stripCountdown(NOW, "not a date")).toBeNull();
  });
});

describe("the strip", () => {
  const strip = (overrides: Partial<Parameters<typeof WallStrip>[0]> = {}) =>
    render(
      <WallStrip
        system={HEALTHY}
        assets={[site("a.example"), site("b.example")]}
        countdown={{ emoji: "🌁", label: "Team offsite", targetAt: iso(12 * DAY) }}
        meetings={withMeetingIn(2.5 * HOUR)}
        nowMs={NOW}
        {...overrides}
      />,
    );

  it("distinguishes calendar loading from an initial failed read", () => {
    const pending = strip({ meetings: null, calendarState: "loading" });
    expect(pending.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("Loading events");
    expect(pending.container.querySelector("[role='alert']")).toBeNull();
    pending.unmount();

    const failed = strip({ meetings: null, calendarState: "failed" });
    expect(failed.container.querySelector("[data-strip-agenda]")).not.toHaveTextContent("Calendar unavailable");
    expect(failed.container.querySelector("[data-strip-agenda] [role='alert']")).toBeNull();
    expect(failed.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("Retrying automatically");
    expect(failed.container.textContent).not.toContain("No meetings today");
  });

  it("keeps a cached meeting visible with the calendar read age", () => {
    const failed = strip({ calendarState: "failed" });
    expect(failed.container.querySelector("[data-strip-meeting-title]")).toHaveTextContent("Partner sync");
    expect(failed.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("Retrying automatically · cached 1m old");
    expect(failed.container.querySelector("[data-strip-meeting-cue]")).toBeNull();
  });

  it("never calls a partially readable calendar clear", () => {
    const partial = strip({ meetings: { ...CALENDAR, feedsConfigured: 2 }, calendarState: "partial" });
    expect(partial.container.querySelector("[data-strip-meeting='none']")).toHaveTextContent("Calendar incomplete");
    expect(partial.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("Some calendars unavailable");
    expect(partial.container.textContent).not.toContain("No meetings today");
  });

  it("groups the clock/date, next meeting and countdown within a bounded TV header", () => {
    const view = strip();
    const el = view.container.querySelector("[data-wall-strip]")!;
    expect(el).toHaveClass("tv:min-h-24", "wall-strip", "grid", "py-4");
    expect(el).toHaveAttribute("aria-label", "Time, meetings and countdown");
    const clock = stripClock(NOW);
    const period = clock.dayPeriod ?? "";
    expect(el.querySelector("[data-strip-time]")?.textContent).toBe(clock.dayPeriodFirst ? period + clock.time : clock.time + period);
    expect(el.querySelector("[data-strip-clock-group] [data-strip-date]")?.textContent).not.toBe("");
    expect(el.querySelector("[data-strip-meeting-title]")?.textContent).toBe("Partner sync");
    expect(el.querySelector("[data-strip-countdown-value]")?.textContent).toBe("12");
    expect(el.querySelector("[data-strip-countdown-unit]")?.textContent).toBe("days remaining");
    expect(el.querySelector("[data-strip-countdown-label]")?.textContent).toBe("Team offsite");
    expect(el.querySelectorAll("a")).toHaveLength(1);
    expect(el.querySelector("[data-strip-home]")).toHaveAttribute("href", "/");
    expect(el.querySelector("[data-system-state]")).toBeNull();
  });

  it("identifies the served commit and its local date and time beneath the logo", () => {
    const version = { commit: "c".repeat(40), committedAt: "2026-10-05T12:34:00.000Z", modified: false };
    vi.stubGlobal("__NOTICEOS_SOURCE_VERSION__", version);
    try {
      const view = inLocale("en-US", () => strip());
      const line = view.container.querySelector("[data-strip-home] [data-strip-version]")!;
      const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(version.committedAt));
      expect(line.textContent).toBe(`ccccccc · ${when}`);
      expect(line).toHaveAttribute("title", `Commit ${version.commit} · ${version.committedAt}`);
      expect(line.querySelector("time")).toHaveAttribute("datetime", version.committedAt);
      expect(line).toHaveClass("text-wall-strip-label", "text-muted-foreground", "tabular-nums");
      expect(line.previousElementSibling?.querySelector(".brand-lockup")).not.toBeNull();
      view.unmount();
      vi.stubGlobal("__NOTICEOS_SOURCE_VERSION__", { ...version, modified: true });
      expect(strip().container.querySelector("[data-strip-version]")?.textContent).toContain("local edits");
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses the actual release identity when the source commit is unavailable", () => {
    vi.stubGlobal("__NOTICEOS_SOURCE_VERSION__", null);
    vi.stubGlobal("__NOTICEOS_RELEASE__", "d".repeat(64));
    try {
      const view = strip();
      expect(view.container.querySelector("[data-strip-version]")?.textContent).toBe("Build ddddddd");
      expect(view.container.querySelector("[data-strip-version] time")).toBeNull();
      view.unmount();
      vi.stubGlobal("__NOTICEOS_RELEASE__", undefined);
      expect(strip().container.querySelector("[data-strip-version]")?.textContent).toBe("Version unavailable");
    } finally { vi.unstubAllGlobals(); }
  });

  it("identifies development once alongside its real commit and timestamp",()=>{
    vi.stubGlobal("__NOTICEOS_SOURCE_VERSION__",{commit:"c".repeat(40),committedAt:"2026-10-05T12:34:00.000Z",modified:false});
    vi.stubGlobal("__NOTICEOS_LIVE_SOURCE__",true);
    try {
      const line=strip().container.querySelector("[data-strip-version]")!;
      expect(line.textContent).toContain("DEV · ccccccc");expect(line.textContent).not.toContain("live source");
      expect(line.querySelector("time")).toHaveAttribute("datetime","2026-10-05T12:34:00.000Z");
    } finally {vi.unstubAllGlobals();}
  });

  it("never draws source/system aggregate failures in the header", () => {
    const view = strip({ system: { ...HEALTHY, hasPulse: false, spendTodayUsd: 9 }, assets: [site("a.example", "degraded")] });
    expect(view.container.querySelector("[data-system-state]")).toBeNull();
    expect(view.container.textContent).not.toMatch(/sources? failing|OS report missing|Over daily data pace/);
  });

  it.each([
    [2.5 * HOUR, "Up next", "in 2H 30M"],
    [-10 * MINUTE, "Now", "20M left"],
  ])("labels the meeting as upcoming or current (%s)", (offset, label, distance) => {
    const view = strip({ meetings: withMeetingIn(offset) });
    expect(view.container.querySelector("[data-strip-meeting-cue]")?.textContent).toBe(label);
    expect(view.container.querySelector("[data-strip-meeting-title]")?.textContent).toBe("Partner sync");
    expect(view.container.querySelector("[data-strip-meeting-distance]")?.textContent).toBe(distance);
    expect(view.container.querySelector("[data-strip-meeting-when]")?.textContent).not.toMatch(/in|left|now/u);
  });

  it.each([
    [5 * HOUR, "5", "hours remaining"],
    [MINUTE, "1", "min remaining"],
    [0, "Reached", null],
    [-HOUR, "Reached", null],
  ])("keeps countdown meaning before and after the target (%s)", (offset, value, unit) => {
    const view = strip({ countdown: { emoji: "", label: "Launch", targetAt: iso(offset) } });
    expect(view.container.querySelector("[data-strip-countdown-value]")?.textContent).toBe(value);
    expect(view.container.querySelector("[data-strip-countdown-unit]")?.textContent ?? null).toBe(unit);
    expect(view.container.querySelector("[data-strip-countdown]")).toHaveAttribute("data-countdown-state", value === "Reached" ? "reached" : "remaining");
  });

  it("keeps held-read age visible without the next-meeting eyebrow", () => {
    const view = strip({ heldSince: iso(-5 * MINUTE) });
    expect(view.container.querySelector("[data-strip-held]")?.textContent).toContain("reconnecting");
    expect(view.container.querySelector("[data-strip-held] svg")).not.toBeNull();
    expect(view.container.querySelector("[data-strip-meeting-title]")?.textContent).toBe("Partner sync");
    expect(view.container.textContent).not.toContain("Up next");
  });

  it("leaves out what nobody set up: no countdown, no readable calendar", () => {
    const view = strip({ countdown: undefined, meetings: null });
    expect(view.container.querySelector("[data-strip-countdown]")).toBeNull();
    expect(view.container.querySelector("[data-strip-meeting]")).toBeNull();
    expect(view.container.querySelector("[data-strip-agenda]")).toBeNull();
    expect(view.container.querySelector("[data-strip-time]")).not.toBeNull();
  });

  it("draws AM/PM on the words' step, muted, after the time in a 12-hour locale, and none in a 24-hour one", () => {
    const twelve = inLocale("en-US", () => strip());
    const time = twelve.container.querySelector("[data-strip-time]")!;
    const period = time.querySelector("[data-strip-day-period]")!;
    expect(period.textContent).toMatch(/^(AM|PM)$/u);
    expect(period).toHaveClass("text-wall-strip-label", "text-muted-foreground");
    expect(time.lastElementChild).toBe(period);
    twelve.unmount();
    const twentyFour = inLocale("de-DE", () => strip());
    const bare = twentyFour.container.querySelector("[data-strip-time]")!;
    expect(bare.querySelector("[data-strip-day-period]")).toBeNull();
    expect(bare.textContent).toMatch(/^\d{1,2}:\d{2}$/u);
  });

  it("shows the countdown's emoji as a picture on its own tile, and no tile when none is set", () => {
    const view = strip();
    const tile = view.container.querySelector("[data-strip-countdown] [data-strip-countdown-emoji]")!;
    expect(tile.textContent).toBe("🌁");
    expect(tile).toHaveClass("min-h-wall-strip-mark", "min-w-wall-strip-mark", "text-wall-strip-emoji");
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    view.unmount();
    for (const emoji of ["", "  "]) {
      const bare = strip({ countdown: { emoji, label: "Team offsite", targetAt: iso(12 * DAY) } });
      expect(bare.container.querySelector("[data-strip-countdown-emoji]")).toBeNull();
      expect(bare.container.querySelector("[data-strip-countdown-label]")?.textContent).toBe("Team offsite");
      expect(bare.container.querySelector("[data-strip-countdown-days]")?.textContent).toBe("12 days");
      bare.unmount();
    }
  });

  it("says No meetings today in muted ink when the day is clear", () => {
    const view = strip({ meetings: withMeetingIn(3 * DAY) });
    const clear = view.container.querySelector("[data-strip-meeting='none']")!;
    expect(clear.textContent).toBe("No meetings today");
    expect(clear).toHaveClass("text-muted-foreground");
  });
});
