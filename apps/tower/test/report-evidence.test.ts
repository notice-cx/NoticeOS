// @vitest-environment node
import { describe, expect, it } from "vitest";
import { UNAVAILABLE_MONEY, type MoneyFigure } from "@noticeos/contract/money";
import type { SiteMoneyRow } from "@/lib/money-page";
import { financialMargin } from "@/routes/financials/financial-margin";
import { connectionCoverage } from "@/routes/operating-views";
import type { ConnectionStatus } from "@shared/connection-status";

function row(asset: string, revenue: number | null, cost: number | null, reported: boolean, change: number | null, currency = "USD"): SiteMoneyRow {
  const figure: MoneyFigure = revenue === null || cost === null ? UNAVAILABLE_MONEY : { currency, revenue, cost, net: revenue - cost };
  return {
    property: { asset, displayName: asset, isOs: false, revenueReported: reported, months: [], figure },
    share: null,
    change: change === null ? null : { percent: change, kind: "month", against: "2026-07" },
  };
}

describe("asset margin", () => {
  it("keeps missing values unknown and never divides an unreported or zero revenue into a margin", () => {
    expect(financialMargin(row("example.com", 100, 10, true, null))).toBe(90);
    expect(financialMargin(row("example.com", 0, 10, true, null))).toBeNull();
    expect(financialMargin(row("example.com", 100, null, true, null))).toBeNull();
    expect(financialMargin(row("example.com", 100, 10, false, null))).toBeNull();

  });
});

it("counts successful collection separately from unknown, accepted keys and partial failures", () => {
  const status = (kind: ConnectionStatus["kind"], sitesFailing = 0): ConnectionStatus => ({ provider: "example", kind, sitesFailing, sites: [], sitesMeasured: 0, sitesOverdue: 0, missing: 0, incomplete: 0 });
  expect(connectionCoverage([status("working"), status("key-accepted"), status("not-checked"), status("unknown"), status("working", 1)])).toEqual({ total: 5, working: 2, attention: 1, unverified: 2 });
});
