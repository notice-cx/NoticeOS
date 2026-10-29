import { PropertyFavicon } from "@/components/PropertyFavicon";
import type { ViewId } from "@shared/views";
import { portfolioPresentation } from "@/routes/assets/presentation";
import { PortfolioRows } from "@/components/viz/PortfolioRows";
import { formatUsd } from "@/lib/format";
import type { SiteLine } from "@/lib/sites-index";
import { cn } from "@/lib/utils";

const cents = (value: number) => formatUsd(value, { cents: true });

/**
 * The Sites comparison: one ruled row per site in the caller's order, each
 * with its health word, people a day over the last four weeks, yesterday's
 * money against the same weekday a week before, its share of the month and
 * its data sources live of owed. Tasks, search and the ledger are a site's
 * own tabs. Raised, because it is the page's one hero.
 */
export function AssetsTable({ lines, className, view = "overview" }: { lines: readonly SiteLine[]; className?: string; view?: ViewId }) {
  return (
    <PortfolioRows
      rows={lines.map((line) => ({
        ...line.row,
        icon: <PropertyFavicon domain={line.card.id} icons={line.card.icons} displayName={line.card.displayName} />,
      }))}
      columnOrder={view === "overview" ? undefined : portfolioPresentation(view).columns}
      formatMoney={cents}
      className={cn("shadow-raised", className)}
    />
  );
}

export default AssetsTable;
