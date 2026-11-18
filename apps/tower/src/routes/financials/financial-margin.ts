import type { SiteMoneyRow } from "@/lib/money-page";

export function financialMargin(row: SiteMoneyRow): number | null {
  const { revenue, net } = row.property.figure;
  return row.property.revenueReported && revenue !== null && revenue > 0 && net !== null ? net / revenue * 100 : null;
}
