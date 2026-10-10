// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseDashboardConfig, readDashboardConfig } from "@shared/dashboard";
import { DEFAULT_WALL_LAYOUT } from "@shared/wall-layout";
import { countdownParts, toLocalDateTimeInput } from "@/lib/countdown";

describe("dashboard config", () => {
  it("accepts a named countdown with an absolute target", () => {
    expect(
      parseDashboardConfig({
        readme: "ignored metadata",
        countdown: {
          emoji: "🌁",
          label: "  Team offsite  ",
          targetAt: "2026-08-01T07:00:00.000Z",
        },
      }),
    ).toEqual({
      countdown: {
        emoji: "🌁",
        label: "Team offsite",
        targetAt: "2026-08-01T07:00:00.000Z",
      },
    });
  });

  it("accepts a config with no countdown, so a fresh clone builds", () => {
    // A countdown is one operator's trip, and an install that has none must
    // not have to invent one to get a build.
    expect(parseDashboardConfig({})).toEqual({});
    expect(parseDashboardConfig({ readme: "config/tower.README.md" })).toEqual({});
    expect(parseDashboardConfig({ readme: "x" }).countdown).toBeUndefined();
  });

  it("still refuses a countdown that is present and broken", () => {
    // Absent is a choice; half-written is a mistake, and the build is where
    // the operator wants to hear about it rather than the wall TV.
    expect(() => parseDashboardConfig({ countdown: "soon" })).toThrow(/countdown/u);
    expect(() => parseDashboardConfig({ countdown: {} })).toThrow(/emoji/u);
    expect(() => parseDashboardConfig("not an object")).toThrow(/JSON object/u);
  });

  it("rejects empty labels and timezone-less targets", () => {
    expect(() =>
      parseDashboardConfig({
        countdown: { emoji: "🌁", label: "", targetAt: "2026-08-01T00:00" },
      }),
    ).toThrow(/label/u);
    expect(() =>
      parseDashboardConfig({
        countdown: { emoji: "🌁", label: "Trip", targetAt: "2026-08-01T00:00" },
      }),
    ).toThrow(/timezone/u);
  });

  it("requires one grapheme for the countdown landmark", () => {
    expect(() =>
      parseDashboardConfig({
        countdown: {
          emoji: "",
          label: "Trip",
          targetAt: "2026-08-01T07:00:00.000Z",
        },
      }),
    ).toThrow(/emoji/u);
    expect(() =>
      parseDashboardConfig({
        countdown: {
          emoji: "A",
          label: "Trip",
          targetAt: "2026-08-01T07:00:00.000Z",
        },
      }),
    ).toThrow(/one emoji/u);
    expect(() =>
      parseDashboardConfig({
        countdown: {
          emoji: "🌁✈️",
          label: "Trip",
          targetAt: "2026-08-01T07:00:00.000Z",
        },
      }),
    ).toThrow(/one emoji/u);
  });
});

describe("calendar countdown", () => {
  it("uses real calendar months, then days, hours, and minutes", () => {
    const now = new Date(2026, 6, 29, 10, 15);
    const target = new Date(2026, 8, 2, 12, 45);
    expect(countdownParts(now.getTime(), target.toISOString())).toEqual({
      months: 1,
      days: 4,
      hours: 2,
      minutes: 30,
      complete: false,
    });
  });

  it("stops cleanly at zero after the target", () => {
    expect(
      countdownParts(
        Date.parse("2026-08-02T00:00:00.000Z"),
        "2026-08-01T00:00:00.000Z",
      ),
    ).toEqual({
      months: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      complete: true,
    });
  });

  it("formats an absolute instant for a native local date/time input", () => {
    const instant = new Date(2026, 7, 1, 9, 5);
    expect(toLocalDateTimeInput(instant)).toBe("2026-08-01T09:05");
  });
});

// The build boundary reads `/wall` the way it reads the countdown: absent is
// a valid file, present must be drawable. A layout the Wall could not draw
// fails `vite build` with the validator's own sentence.
describe("the Wall's saved layout, at the build boundary", () => {
  it("leaves the key off when the file has none, so the default has one home", () => {
    expect(parseDashboardConfig({ readme: "x" }).wall).toBeUndefined();
    expect(parseDashboardConfig({}).wall).toBeUndefined();
  });

  it("reads a saved layout through the contract's own parser", () => {
    const config = parseDashboardConfig({
      wall: { layout: DEFAULT_WALL_LAYOUT, history: [] },
    });
    expect(config.wall).toEqual({ layout: DEFAULT_WALL_LAYOUT, history: [] });
  });

  it("fails the build on a layout the Wall could not draw, in the validator's words", () => {
    expect(() =>
      parseDashboardConfig({ wall: { layout: { version: 1, rows: [] } } }),
    ).toThrow("config/tower.json wall.layout: A layout needs at least one row.");
  });

  it("checks the layout even when the file carries no countdown at all", () => {
    expect(() => parseDashboardConfig({ wall: { layout: "not a layout" } })).toThrow(
      /wall\.layout/u,
    );
  });
});

// A saved document is read part by part: the layout and the countdown are
// two settings that share a file. A part that reads is used; a part that
// does not is left out and named, with the value as stored.
describe("a saved config/tower.json, read one part at a time", () => {
  const SITES_ONLY = {
    version: 1,
    rows: [{ id: "only", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }],
  };
  const VALID_WALL = { layout: SITES_ONLY, history: [] };
  const COUNTDOWN = { emoji: "🌁", label: "Trip", targetAt: "2026-08-01T07:00:00.000Z" };

  it("keeps a valid layout beside a countdown it cannot read, and names the countdown", () => {
    const broken = { emoji: "", label: "Trip", targetAt: "2026-08-01T07:00:00.000Z" };
    const config = readDashboardConfig({ wall: VALID_WALL, countdown: broken });
    expect(config.wall).toEqual(VALID_WALL);
    expect(config.countdown).toBeUndefined();
    expect(config.refused).toEqual({
      countdown: { saved: broken, reason: "config/tower.json countdown.emoji must contain one emoji" },
    });
  });

  it("keeps a valid countdown beside a layout it cannot read, and names the layout", () => {
    const broken = { layout: { version: 1, rows: [] } };
    const config = readDashboardConfig({ wall: broken, countdown: COUNTDOWN });
    expect(config.countdown).toEqual(COUNTDOWN);
    // Nothing of it reads, so the Wall draws its default: no `wall` at all.
    expect(config.wall).toBeUndefined();
    expect(config.refused).toEqual({
      wall: { saved: broken, reason: "config/tower.json wall.layout: A layout needs at least one row." },
    });
  });

  it("keeps the versions saved with a refused layout that still read, under the default", () => {
    const good = { savedAt: "2026-09-04T12:00:00.000Z", reason: "Sites only", layout: SITES_ONLY };
    const bad = { savedAt: "2026-09-03T12:00:00.000Z", reason: "Empty", layout: { version: 1, rows: [] } };
    const config = readDashboardConfig({ wall: { layout: "not a layout", history: [good, bad] } });
    expect(config.wall).toEqual({ layout: DEFAULT_WALL_LAYOUT, history: [good] });
    expect(config.refused?.wall?.reason).toMatch(/wall\.layout/u);
  });

  it("names nothing when every part reads, and throws only for a document that is not an object", () => {
    expect(readDashboardConfig({ wall: VALID_WALL, countdown: COUNTDOWN })).not.toHaveProperty("refused");
    expect(readDashboardConfig({})).toEqual({});
    expect(() => readDashboardConfig("not an object")).toThrow(/JSON object/u);
  });

  it("is still the build's rule: parseDashboardConfig throws the first refusal, layout before countdown", () => {
    expect(() => parseDashboardConfig({ wall: { layout: { version: 1, rows: [] } }, countdown: {} }))
      .toThrow("config/tower.json wall.layout: A layout needs at least one row.");
    expect(() => parseDashboardConfig({ wall: VALID_WALL, countdown: {} })).toThrow(/emoji/u);
  });
});
