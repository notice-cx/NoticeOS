// The portfolio item is an asset; this helper writes its singular and plural.
// The module path remains compatible with existing imports. `scripts/ui-lexicon.test.mjs` fails on a hand-rolled singular/plural.

/** "asset" for exactly one, "assets" for every other count, zero included. */
export function siteNoun(count: number): "asset" | "assets" {
  return count === 1 ? "asset" : "assets";
}

/** "1 asset", "3 assets", "0 assets". */
export function siteCount(count: number): string {
  return `${count} ${siteNoun(count)}`;
}
