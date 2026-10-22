import { describe, expect, it } from "vitest";
import { majorToMinorUnits } from "@noticeos/contract/money";
import { compareRecordedCosts, costSourceLabel, previousCostPeriod } from "@/routes/financials/cost-comparison";
import { costLine, costMonth } from "../e2e/monthly-cost-changes/fixtures";

describe("recorded monthly cost comparison", () => {
  it("preserves cents, ranks absolute changes and reconciles matched sources to month totals", () => {
    const previous = [costLine("increase", 10.01), costLine("decrease", 20.03), costLine("unchanged", 1.11), costLine("zero", 0)];
    const current = [costLine("increase", 10.03), costLine("decrease", 18.02), costLine("unchanged", 1.11), costLine("zero", 0)];
    const { rows, totals } = compareRecordedCosts(previous, current);
    expect(rows.map(({ source, difference }) => [source, difference])).toEqual([["decrease", -2.01], ["increase", 0.02], ["unchanged", 0], ["zero", 0]]);
    expect(totals).toEqual([{ currency: "USD", previous: 31.15, current: 29.16, difference: -1.99 }]);
    expect(rows.reduce((sum, row) => sum + majorToMinorUnits(row.difference!, "USD"), 0)).toBe(majorToMinorUnits(totals[0]!.difference!, "USD"));
  });

  it("keeps added and absent sources unknown while totals include all recorded costs", () => {
    const { rows, totals } = compareRecordedCosts(costMonth("2026-08").costLines, costMonth().costLines);
    expect(rows.find((row) => row.source === "added")).toMatchObject({ previous: null, current: 2.02, difference: null });
    expect(rows.find((row) => row.source === "absent")).toMatchObject({ previous: 1.01, current: null, difference: null });
    expect(totals).toEqual([{ currency: "USD", previous: 16.07, current: 17.16, difference: 1.09 }]);
    expect(rows.slice(0, 2).map((row) => row.difference)).toEqual([2.11, -2.03]);
  });

  it("matches exact source/family/currency tuples, including null and separator characters", () => {
    const previous = [costLine(null, 1), costLine("", 2), costLine("a:b", 3, { family: "c" }), costLine("a", 4, { family: "b:c" })];
    const current = [costLine(null, 1), costLine("", 2), costLine("a:b", 3, { family: "other" }), costLine("a", 4, { family: "b:c" })];
    const { rows } = compareRecordedCosts(previous, current);
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.difference === 0)).toHaveLength(3);
    expect(rows.filter((row) => row.source === "a:b").every((row) => row.difference === null)).toBe(true);
  });

  it("never combines currencies or treats a changed currency as a source match", () => {
    const { rows, totals } = compareRecordedCosts(
      [costLine("same", 1.01), costLine("same", 2.02, { currency: "EUR" }), costLine("changed", 3)],
      [costLine("same", 1.02), costLine("same", 1.01, { currency: "EUR" }), costLine("changed", 3, { currency: "JPY" })],
    );
    expect(rows.filter((row) => row.source === "same").map((row) => row.difference)).toEqual([-1.01, 0.01]);
    expect(rows.filter((row) => row.source === "changed").every((row) => row.difference === null)).toBe(true);
    expect(totals).toEqual([
      { currency: "EUR", previous: 2.02, current: 1.01, difference: -1.01 },
      { currency: "JPY", previous: null, current: 3, difference: null },
      { currency: "USD", previous: 4.01, current: 1.02, difference: -2.99 },
    ]);
  });

  it("retains duplicate exact identities using integer arithmetic", () => {
    expect(compareRecordedCosts([costLine("a", 0.1), costLine("a", 0.2)], [costLine("a", 0.31)]).rows[0]).toMatchObject({ previous: 0.3, current: 0.31, difference: 0.01 });
  });

  it("leaves missing records, unsupported currency and unsafe amounts unavailable", () => {
    expect(compareRecordedCosts([], [costLine("a", 0)]).totals[0]).toMatchObject({ previous: null, current: 0, difference: null });
    for (const line of [costLine("a", NaN), costLine("a", Infinity), costLine("a", Number.MAX_SAFE_INTEGER), costLine("a", 1, { rows: 0 }), costLine("a", 0, { currency: "XYZ" })]) {
      const row = compareRecordedCosts([line], [line]).rows[0]!;
      expect(row).toMatchObject({ previous: null, current: null, difference: null });
    }
  });

  it("uses literal fallback labels without merging equally named sources", () => {
    expect(costSourceLabel(null, [])).toBeNull();
    expect(costSourceLabel("metered:unknown-provider", [])).toBe("unknown-provider");
    expect(costSourceLabel("recurring:unknown-plan", [])).toBe("unknown-plan");
    expect(costSourceLabel("unknown-source", [])).toBe("unknown-source");
    expect(costSourceLabel("domains", [])).toBe("Domain orders");
    expect(compareRecordedCosts([costLine("recurring:a", 1)], [costLine("recurring:b", 1)]).rows).toHaveLength(2);
  });

  it("reads the immediately preceding calendar month across January", () => {
    expect(previousCostPeriod("2026-01")).toBe("2025-12");
    expect(previousCostPeriod("2024-03")).toBe("2024-02");
    expect(previousCostPeriod("2026-12")).toBe("2026-11");
    for (const period of ["2026-13", "2026-1", "invalid", "0000-01"]) expect(previousCostPeriod(period)).toBeNull();
  });
});
