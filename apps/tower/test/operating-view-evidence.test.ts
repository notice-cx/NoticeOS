import { describe, expect, it } from "vitest";
import { UNAVAILABLE_MONEY, type MoneyFigure } from "@noticeos/contract/money";
import type { SiteMoneyRow } from "@/lib/money-page";
import { financialMargin, moneyRowsForView } from "@/routes/financials/view-money";
import { connectionCoverage, providerInView, sourceInView } from "@/routes/operating-views";
import type { ConnectionStatus } from "@shared/connection-status";

function row(asset: string, revenue: number | null, cost: number | null, reported: boolean, change: number | null, currency = "USD"): SiteMoneyRow {
  const figure: MoneyFigure = revenue === null || cost === null ? UNAVAILABLE_MONEY : { currency, revenue, cost, net: revenue - cost };
  return {
    property: { asset, displayName: asset, isOs: false, revenueReported: reported, months: [], figure },
    share: null,
    change: change === null ? null : { percent: change, kind: "month", against: "2026-07" },
  };
}

describe("financial display emphasis", () => {
  it("changes the comparison order while preserving every asset and all recorded figures", () => {
    const rows = [row("example.com", 100, 10, true, 4), row("growth.example", 50, 40, true, 20), row("missing.example", 0, 3, false, null)];
    expect(moneyRowsForView(rows, "overview")).toEqual(rows);
    expect(moneyRowsForView(rows, "growth").map((r) => r.property.asset)).toEqual(["growth.example", "example.com", "missing.example"]);
    expect(moneyRowsForView(rows, "delivery").map((r) => r.property.asset)).toEqual(["growth.example", "example.com", "missing.example"]);
    expect(moneyRowsForView(rows, "revenue").map((r) => r.property.asset)).toEqual(["example.com", "growth.example", "missing.example"]);
    expect(moneyRowsForView(rows, "reliability").map((r) => r.property.asset)).toEqual(["missing.example", "example.com", "growth.example"]);
    for (const view of ["growth", "delivery", "revenue", "reliability"] as const) {
      const shown = moneyRowsForView(rows, view);
      expect(new Set(shown)).toEqual(new Set(rows));
      expect(rows[0]!.property.figure).toEqual({ currency: "USD", revenue: 100, cost: 10, net: 90 });
    }
  });

  it("keeps missing values unknown and never divides an unreported or zero revenue into a margin", () => {
    expect(financialMargin(row("example.com", 100, 10, true, null))).toBe(90);
    expect(financialMargin(row("example.com", 0, 10, true, null))).toBeNull();
    expect(financialMargin(row("example.com", 100, null, true, null))).toBeNull();
    expect(financialMargin(row("example.com", 100, 10, false, null))).toBeNull();
    const usd = row("example.com", 100, 10, true, null);
    const eur = row("other.example", 1000, 100, true, null, "EUR");
    expect(moneyRowsForView([usd, eur], "revenue")).toEqual([usd, eur]);
  });
});

it("counts successful collection separately from unknown, accepted keys and partial failures", () => {
  const status = (kind: ConnectionStatus["kind"], sitesFailing = 0): ConnectionStatus => ({ provider: "example", kind, sitesFailing, sites: [], sitesMeasured: 0, sitesOverdue: 0, missing: 0, incomplete: 0 });
  expect(connectionCoverage([status("working"), status("key-accepted"), status("not-checked"), status("unknown"), status("working", 1)])).toEqual({ total: 5, working: 2, attention: 1, unverified: 2 });
  expect(sourceInView("subscriptions", "revenue")).toBe(true);
  expect(providerInView({ id: "google", lanes: ["ga4", "gsc"] }, "growth")).toBe(true);
  expect(providerInView({ id: "stripe", lanes: ["subscriptions"] }, "growth")).toBe(false);
});
