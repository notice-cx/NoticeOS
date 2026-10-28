import type { ViewId } from "@shared/views";
import type { PortfolioColumn } from "@/components/viz/PortfolioRows";
import type { SitesOrder } from "@/lib/sites-index";

const PRESENTATION: Record<ViewId, { order: SitesOrder; columns: readonly PortfolioColumn[] }> = {
  overview: { order: "seed", columns: ["people", "revenue", "share", "sources"] },
  growth: { order: "users", columns: ["people", "revenue", "share", "sources"] },
  revenue: { order: "money", columns: ["revenue", "share", "people", "sources"] },
  delivery: { order: "delivery", columns: ["work", "sources", "people", "revenue", "share"] },
  reliability: { order: "health", columns: ["sources", "people", "revenue", "share"] },
};

export function portfolioPresentation(view: ViewId) {
  return PRESENTATION[view];
}
