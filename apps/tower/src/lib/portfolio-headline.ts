// Which month's money leads, and what to call it — the one rule Home's money
// tile, the Assets page and the Wall's revenue figure read (bead `ro-pbzu.3`).
// It lived in `components/bands/PortfolioBand.tsx` beside the old Wall's
// portfolio card; since D28 took that card off the Wall (bead `ro-trai.11`) it
// lives here, so the TV downloads the rule without the card, and the card is
// gone (bead `ro-trai.20`).

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
 * FORECAST LEADS whenever it carries money: a reconciled $0 for a month whose
 * estimates already carry money is the worse headline (see `PortfolioBand`).
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
