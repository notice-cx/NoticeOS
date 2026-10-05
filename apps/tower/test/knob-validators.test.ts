import { describe, expect, it } from "vitest";
import {
  validateCountdownEmoji,
  validateDisplayLabel,
  validateFutureDateTime,
  validateProbability,
  validatePositiveInt,
  validateTimeZone,
  validateUrl,
  validateUsd,
} from "@/lib/knob-validators";

describe("validateUrl (pull.json scrape endpoint)", () => {
  it("accepts http/https URLs, trimming whitespace", () => {
    expect(validateUrl("  https://meals.example/metrics ")).toEqual({
      ok: true,
      value: "https://meals.example/metrics",
    });
  });

  it("rejects non-URLs and non-http schemes with a reason", () => {
    expect(validateUrl("not a url").ok).toBe(false);
    expect(validateUrl("ftp://x.test").ok).toBe(false);
    expect(validateUrl("").ok).toBe(false);
  });
});

describe("validateProbability (alpha)", () => {
  it("accepts values strictly between 0 and 1", () => {
    expect(validateProbability("0.01")).toEqual({ ok: true, value: 0.01 });
  });

  it("rejects out-of-range and non-numeric", () => {
    expect(validateProbability("0").ok).toBe(false);
    expect(validateProbability("1").ok).toBe(false);
    expect(validateProbability("1.5").ok).toBe(false);
    expect(validateProbability("abc").ok).toBe(false);
  });
});

describe("validatePositiveInt (min baseline / window hours)", () => {
  it("accepts whole numbers ≥ 1", () => {
    expect(validatePositiveInt("3")).toEqual({ ok: true, value: 3 });
  });

  it("rejects fractions and < 1", () => {
    expect(validatePositiveInt("2.5").ok).toBe(false);
    expect(validatePositiveInt("0").ok).toBe(false);
    expect(validatePositiveInt("-4").ok).toBe(false);
  });
});

describe("validateUsd (spend caps / operator rate)", () => {
  it("accepts non-negative amounts", () => {
    expect(validateUsd("25")).toEqual({ ok: true, value: 25 });
    expect(validateUsd("0")).toEqual({ ok: true, value: 0 });
  });

  it("rejects negatives and junk", () => {
    expect(validateUsd("-1").ok).toBe(false);
    expect(validateUsd("").ok).toBe(false);
  });
});

describe("validateTimeZone (constants.json os_time_zone)", () => {
  it("accepts IANA names, trimming whitespace", () => {
    expect(validateTimeZone("  Europe/Warsaw ")).toEqual({
      ok: true,
      value: "Europe/Warsaw",
    });
    expect(validateTimeZone("America/Los_Angeles").ok).toBe(true);
    expect(validateTimeZone("UTC").ok).toBe(true);
  });

  it("refuses anything the build boundary would also refuse", () => {
    // The field asks the same question the contract asks of the committed
    // value, so a zone that saves is a zone that builds (bead ro-py40).
    expect(validateTimeZone("").ok).toBe(false);
    expect(validateTimeZone("   ").ok).toBe(false);
    expect(validateTimeZone("America/Atlantis").ok).toBe(false);
    expect(validateTimeZone("Pacific Time").ok).toBe(false);
    // The runtime's tz database is the authority, and it DOES know the legacy
    // aliases — "PST" is a link to PST8PDT. Refusing them here would refuse a
    // zone the build then accepts, which is the one thing this must not do.
    expect(validateTimeZone("PST").ok).toBe(true);
  });
});

describe("countdown inputs", () => {
  it("accepts one emoji grapheme and rejects blank or multiple landmarks", () => {
    expect(validateCountdownEmoji("  👨‍👩‍👧‍👦  ")).toEqual({
      ok: true,
      value: "👨‍👩‍👧‍👦",
    });
    expect(validateCountdownEmoji("   ").ok).toBe(false);
    expect(validateCountdownEmoji("A").ok).toBe(false);
    expect(validateCountdownEmoji("🌁✈️").ok).toBe(false);
  });

  it("trims a useful display label and rejects empty/oversized labels", () => {
    expect(validateDisplayLabel("  SF Trip  ")).toEqual({
      ok: true,
      value: "SF Trip",
    });
    expect(validateDisplayLabel("   ").ok).toBe(false);
    expect(validateDisplayLabel("x".repeat(81)).ok).toBe(false);
  });

  it("converts a future local datetime to ISO and rejects elapsed targets", () => {
    const now = new Date(2026, 6, 29, 10, 0).getTime();
    const result = validateFutureDateTime("2026-08-01T09:30", now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Date(result.value).getTime()).toBe(
        new Date(2026, 7, 1, 9, 30).getTime(),
      );
    }
    expect(validateFutureDateTime("2026-07-01T09:30", now).ok).toBe(false);
  });
});
