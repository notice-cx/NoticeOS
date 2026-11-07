// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ageMs, formatAge, isAmber } from "@shared/freshness";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();

describe("ageMs", () => {
  it("is null for missing or unparseable timestamps", () => {
    expect(ageMs(NOW, null)).toBeNull();
    expect(ageMs(NOW, undefined)).toBeNull();
    expect(ageMs(NOW, "not-a-date")).toBeNull();
  });

  it("computes a non-negative age", () => {
    expect(ageMs(NOW, hoursAgo(2))).toBe(2 * HOUR);
    // future timestamps clamp to 0 rather than going negative
    expect(ageMs(NOW, new Date(NOW + 5_000).toISOString())).toBe(0);
  });
});

describe("isAmber (amber past 2× cadence)", () => {
  it("is fresh below the 2× threshold", () => {
    expect(isAmber(NOW, hoursAgo(40), 24)).toBe(false);
    expect(isAmber(NOW, hoursAgo(48), 24)).toBe(false); // exactly 2× is not yet amber
  });

  it("is amber above the 2× threshold", () => {
    expect(isAmber(NOW, hoursAgo(49), 24)).toBe(true);
  });

  it("treats missing data as amber (an absent age is never fresh)", () => {
    expect(isAmber(NOW, null, 24)).toBe(true);
  });
});

describe("formatAge", () => {
  it("renders compact units and an em dash for unknown", () => {
    // The em dash stays here on purpose: the badge's "never" belongs to the
    // badge; this helper is shared with call sites that interpolate it as
    // "{age} ago", where a word would read "never ago".
    expect(formatAge(null)).toBe("—");
    expect(formatAge(5_000)).toBe("5s");
    expect(formatAge(5 * 60_000)).toBe("5m");
    expect(formatAge(3 * HOUR)).toBe("3h");
    expect(formatAge(2 * 86_400_000)).toBe("2d");
  });

});
