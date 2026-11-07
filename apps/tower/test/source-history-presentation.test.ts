// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SourceDays } from "@/routes/asset-detail/overview-measures";
import { sourceHistoryHeadline } from "@/routes/asset-detail/source-history-presentation";

const now = Date.parse("2026-09-15T12:00:00Z");
const source = (over: Partial<SourceDays> = {}): SourceDays => ({
  id: "search", name: "Search", label: "Search reports", state: "working", stateLabel: null,
  since: "2026-09-13T12:00:00Z", through: "2026-09-14", detail: null,
  days: [
    { t: "2026-09-10", state: "before" },
    { t: "2026-09-11", state: "reported" },
    { t: "2026-09-12", state: "missed" },
    { t: "2026-09-13", state: "counting" },
    { t: "2026-09-14", state: "late" },
  ], ...over,
});

describe("Overview source-history evidence", () => {
  it("prioritizes a failure over an overdue source and over historical gaps", () => {
    const overdue = source({ name: "Analytics", state: "overdue" });
    const failed = source({ name: "Revenue", state: "failing" });
    expect(sourceHistoryHeadline([overdue, failed], now)).toMatchObject({ tone: "error" });
    expect(sourceHistoryHeadline([overdue, failed], now)?.text).toContain(failed.name);
    expect(sourceHistoryHeadline([overdue], now)).toMatchObject({ tone: "warn" });
    expect(sourceHistoryHeadline([overdue], now)?.text).toContain(overdue.name);
  });

  it("uses a historical gap, a complete window or no daily evidence for the remaining headlines", () => {
    expect(sourceHistoryHeadline([source()], now)?.tone).toBe("gap");
    expect(sourceHistoryHeadline([source({ days: [{ t: "2026-09-14", state: "reported" }] })], now)?.tone).toBe("clear");
    expect(sourceHistoryHeadline([source({ days: null })], now)).toBeNull();
    expect(sourceHistoryHeadline([], now)).toBeNull();
  });
});
