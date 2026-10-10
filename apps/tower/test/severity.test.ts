// @vitest-environment node
// Reporting coverage → the attention system (lib/severity). Home's reporting
// tile reads it.

import { describe, expect, it } from "vitest";
import { coverageSeverity } from "@/lib/severity";

describe("coverageSeverity", () => {
  it("marks stale expected reports as warnings and unconfigured sites as neutral", () => {
    expect(coverageSeverity({ fresh: 3, stale: 0, notExpected: 2, expected: 3 })).toBeNull();
    expect(coverageSeverity({ fresh: 4, stale: 1, notExpected: 0, expected: 5 })).toBe("warn");
  });

  it("is calm when every expected site reported, and when none owes a report", () => {
    expect(coverageSeverity({ fresh: 3, stale: 0, notExpected: 1, expected: 3 })).toBeNull();
    expect(coverageSeverity({ fresh: 0, stale: 0, notExpected: 2, expected: 0 })).toBeNull();
  });
});
