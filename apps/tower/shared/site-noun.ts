// The word a person reads for a site, and the one way a count of them is
// written. Code, URLs and the store say *asset*; everything a person reads says
// *site*. `scripts/ui-lexicon.test.mjs` fails on a hand-rolled singular/plural.

/** "site" for exactly one, "sites" for every other count, zero included. */
export function siteNoun(count: number): "site" | "sites" {
  return count === 1 ? "site" : "sites";
}

/** "1 site", "3 sites", "0 sites". */
export function siteCount(count: number): string {
  return `${count} ${siteNoun(count)}`;
}
