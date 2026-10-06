// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  formatAxisCount,
  formatCalendarDate,
  formatCalendarRange,
  formatPercent,
  formatTimestamp,
} from "@/lib/format";

describe("formatAxisCount (bead ro-oag5)", () => {
  it("fits every tick in the count axis' four characters", () => {
    // The midpoint of an odd peak is a half; it keeps its decimal only while
    // that still fits.
    expect(formatAxisCount(930.5)).toBe("931");
    expect(formatAxisCount(131.5)).toBe("132");
    expect(formatAxisCount(59.5)).toBe("59.5");
    expect(formatAxisCount(23.5)).toBe("23.5");
    expect(formatAxisCount(0)).toBe("0");
    expect(formatAxisCount(1_861)).toBe("1.9K");
    expect(formatAxisCount(12_345)).toBe("12K");
    expect(formatAxisCount(123_456)).toBe("123K");
    for (const value of [0.5, 9.5, 99.5, 999.5, 1_000, 9_950, 99_999, 1_234_567]) {
      expect(formatAxisCount(value).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("formatPercent", () => {
  it("does not round directional movement down to a misleading zero", () => {
    expect(formatPercent(0)).toBe("0");
    expect(formatPercent(0.24)).toBe("0.2");
    expect(formatPercent(-0.24)).toBe("-0.2");
    expect(formatPercent(12.4)).toBe("12");
  });
});

describe("evidence instants", () => {
  it("shows the local calendar date and explicit zone without ISO syntax", () => {
    expect(formatTimestamp("2026-09-05T04:00:00.046Z", "America/Los_Angeles"))
      .toBe("Sep 4, 2026, 9:00:00 PM PDT");
    expect(formatTimestamp("2026-09-04T21:00:00-07:00", "UTC"))
      .toBe("Sep 5, 2026, 4:00:00 AM UTC");
  });

  it("distinguishes the repeated daylight-saving hour by its zone", () => {
    expect(formatTimestamp("2026-11-01T08:30:00Z", "America/Los_Angeles"))
      .toBe("Nov 1, 2026, 1:30:00 AM PDT");
    expect(formatTimestamp("2026-11-01T09:30:00Z", "America/Los_Angeles"))
      .toBe("Nov 1, 2026, 1:30:00 AM PST");
  });

  it("does not invent a readable date for an invalid instant", () => {
    expect(formatTimestamp("not a timestamp", "UTC")).toBe("Unavailable");
  });
});

describe("calendar evidence labels", () => {
  it("collapses a single date and same-month ranges into spoken labels", () => {
    expect(formatCalendarDate("2026-07-30")).toBe("Jul 30, 2026");
    expect(formatCalendarRange("2026-07-30", "2026-07-30")).toBe(
      "Jul 30, 2026",
    );
    expect(formatCalendarRange("2026-07-25", "2026-07-30")).toBe(
      "Jul 25–30, 2026",
    );
  });

  it("keeps the year unambiguous across months and years", () => {
    expect(formatCalendarRange("2026-03-27", "2026-07-24")).toBe(
      "Mar 27–Jul 24, 2026",
    );
    expect(formatCalendarRange("2025-12-30", "2026-01-02")).toBe(
      "Dec 30, 2025–Jan 2, 2026",
    );
  });
});
