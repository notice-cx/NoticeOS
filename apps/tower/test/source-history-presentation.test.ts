import { describe, expect, it } from "vitest";
import type { SourceDays } from "@/routes/asset-detail/overview-measures";
import { sourceHistoryHeadline, sourceHistoryRowSummary } from "@/routes/asset-detail/source-history-presentation";

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
  it("counts only owed days, including unfinished reports, and names missing dates", () => {
    expect(sourceHistoryRowSummary(source())).toBe("Search reports, Sep 10 to Sep 14: reported 2 of 4 days; missed Sep 12; working");
    expect(sourceHistoryRowSummary(source({ days: null }))).toBe("Search reports: no daily record");
  });

  it("prioritizes a failure over an overdue source and over historical gaps", () => {
    const overdue = source({ name: "Analytics", state: "overdue" });
    const failed = source({ name: "Revenue", state: "failing" });
    expect(sourceHistoryHeadline([overdue, failed], now)).toEqual({ tone: "error", text: "Revenue failing · 2d" });
    expect(sourceHistoryHeadline([overdue], now)).toEqual({ tone: "warn", text: "Analytics overdue · 2d" });
  });

  it("uses a historical gap, a complete window or no daily evidence for the remaining headlines", () => {
    expect(sourceHistoryHeadline([source()], now)).toEqual({ tone: "gap", text: "Search missed 1 day · Sep 12" });
    expect(sourceHistoryHeadline([source({ days: [{ t: "2026-09-14", state: "reported" }] })], now)).toEqual({ tone: "clear", text: "Every source reported every day" });
    expect(sourceHistoryHeadline([source({ days: null })], now)).toBeNull();
    expect(sourceHistoryHeadline([], now)).toBeNull();
  });
});
