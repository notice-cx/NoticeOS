// Which month's money leads, and what to call it: the one rule Home's money
// tile, the Assets page and the Wall's revenue figure read.

import {
  figureHasMoney,
  portfolioHasData,
  type LedgerFigure,
  type PortfolioBand as PortfolioData,
} from "@shared/wall";

/**
 * WHICH figure leads, and what to call it.
 *
 * Home's money tile states this same net, so the choice cannot be made twice:
 * a second derivation is how a tile and the card it links to start quoting
 * different numbers for one month. `null` means the band has no ledger row at
 * all (`portfolioHasData`), which is a surface's reason to say so in one line.
 *
 * Forecast leads whenever it carries money: a reconciled $0 for a month whose
 * estimates already carry money is the worse headline.
 */
export function portfolioHeadline(
  band: PortfolioData,
): { figure: LedgerFigure; state: "booked" | "forecast" } | null {
  if (!portfolioHasData(band)) return null;
  return figureHasMoney(band.forecast)
    ? { figure: band.forecast, state: "forecast" }
    : { figure: band.booked, state: "booked" };
}

/** The one word beside the figure. Booked money is "reconciled"; everything
 * else is "estimated", and a figure that could be mistaken for booked money is
 * the thing no surface may ever produce. */
export function portfolioHeadlineWord(state: "booked" | "forecast"): string {
  return state === "booked" ? "reconciled" : "estimated";
}
