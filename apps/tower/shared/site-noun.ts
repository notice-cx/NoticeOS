// The word a person reads for a site, and the one way a count of them is
// written (D31; beads `ro-ujb9.142` and `ro-ujb9.130`).
//
// Code, URLs and the store keep *asset* (`/assets`, the `assets` table, asset
// ids); everything a person reads says *site*. A count goes through here so a
// template cannot say "1 assets" or "1 sites" again —
// `scripts/ui-lexicon.test.mjs` fails on a hand-rolled singular/plural pair.

/** "site" for exactly one, "sites" for every other count, zero included. */
export function siteNoun(count: number): "site" | "sites" {
  return count === 1 ? "site" : "sites";
}

/** "1 site", "3 sites", "0 sites". */
export function siteCount(count: number): string {
  return `${count} ${siteNoun(count)}`;
}
