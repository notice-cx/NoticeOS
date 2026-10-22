import type { FinancialCostLine, FinancialsPayload } from "../../shared/financials";

export function costLine(source: string | null, amount: number, overrides: Partial<FinancialCostLine> = {}): FinancialCostLine {
  return { source, amount, family: "infra", currency: "USD", provenance: "unclassified", rows: 1, ...overrides };
}

export function costMonth(period = "2026-09", overrides: Partial<FinancialsPayload> = {}): FinancialsPayload {
  const costLines = period === "2026-08"
    ? [costLine("recurring:hosting", 10.01), costLine("metered:example-model", 5.05), costLine(null, 0, { family: "unknown-family" }), costLine("absent", 1.01)]
    : [costLine("recurring:hosting", 12.12), costLine("metered:example-model", 3.02), costLine(null, 0, { family: "unknown-family" }), costLine("added", 2.02)];
  const amount = period === "2026-08" ? 16.07 : 17.16;
  return {
    generatedAt: "2026-09-15T12:00:00.000Z", period, periods: ["2026-08", "2026-09"],
    periodIsCurrent: period === "2026-09", currentPeriod: "2026-09",
    months: ["2026-08", "2026-09"].map((month) => {
      const cost = month === "2026-08" ? 16.07 : 17.16;
      const figure = { currency: "USD", revenue: 100, cost, net: 100 - cost };
      return { period: month, booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, estimated: figure, total: figure };
    }),
    properties: [], overhead: { currency: "USD", revenue: 0, cost: amount, net: -amount },
    costLines, domains: [], domainOrders: [], empty: false,
    recurringCosts: [{ id: "hosting", label: "Example hosting subscription with a long descriptive name", asset: "example.com", family: "infra", amountUsdPerMonth: 12.12, from: "2026-01" }],
    ...overrides,
  };
}
