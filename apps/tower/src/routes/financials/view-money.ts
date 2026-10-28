import type { ViewId } from "@shared/views";
import type { SiteMoneyRow } from "@/lib/money-page";

export const MONEY_VIEW_CONTEXT: Record<ViewId, { title: string; column: string; order: string }> = {
  overview: { title: "Financial context", column: "Net by month", order: "Revenue, largest first" },
  growth: { title: "Revenue movement", column: "Revenue change · net trend", order: "Revenue change, largest first" },
  revenue: { title: "Profitability", column: "Margin · net trend", order: "Net, largest first" },
  delivery: { title: "Cost of work", column: "Direct cost · net trend", order: "Direct cost, largest first" },
  reliability: { title: "Financial coverage", column: "Reporting · net trend", order: "Missing revenue reports first" },
};

/** Presentation order; ledger figures and the portfolio's ranking policy
 * are untouched. Never compare absolute amounts in unlike currencies. */
export function moneyRowsForView(rows: readonly SiteMoneyRow[], view: ViewId): SiteMoneyRow[] {
  if (view === "overview") return [...rows];
  return [...rows].sort((a, b) => {
    if (view === "reliability") return Number(a.property.revenueReported) - Number(b.property.revenueReported);
    if (view === "growth") {
      if (a.change === null || b.change === null) return Number(a.change === null) - Number(b.change === null);
      if (a.change.kind !== b.change.kind) return 0;
      return b.change.percent - a.change.percent;
    }
    if (a.property.figure.currency !== b.property.figure.currency) return 0;
    const key = view === "delivery" ? "cost" : "net";
    const left = a.property.figure[key];
    const right = b.property.figure[key];
    if (left === null || right === null) return Number(left === null) - Number(right === null);
    return right - left;
  });
}

export function financialMargin(row: SiteMoneyRow): number | null {
  const { revenue, net } = row.property.figure;
  return row.property.revenueReported && revenue !== null && revenue > 0 && net !== null ? net / revenue * 100 : null;
}
