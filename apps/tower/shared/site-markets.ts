// A DataForSEO market in words: "United States · English" where the register
// holds 2840/en. The baseline and the words are the contract's
// (packages/contract/src/search-market.mts).

import { DATAFORSEO_BASELINE_MARKET, marketLabel } from "@noticeos/contract/dataforseo";

export { marketLabel };

export const DATAFORSEO_BASELINE = DATAFORSEO_BASELINE_MARKET;

/** The markets a site's DataForSEO reports can be asked in, picked by name on
 * its Data sources row: each place in its main language, the baseline first. */
export const DATAFORSEO_MARKETS: readonly { locationCode: number; languageCode: string }[] = [
  { locationCode: 2840, languageCode: "en" }, { locationCode: 2826, languageCode: "en" }, { locationCode: 2124, languageCode: "en" },
  { locationCode: 2124, languageCode: "fr" }, { locationCode: 2036, languageCode: "en" }, { locationCode: 2554, languageCode: "en" },
  { locationCode: 2372, languageCode: "en" }, { locationCode: 2356, languageCode: "en" }, { locationCode: 2276, languageCode: "de" },
  { locationCode: 2250, languageCode: "fr" }, { locationCode: 2724, languageCode: "es" }, { locationCode: 2380, languageCode: "it" },
  { locationCode: 2528, languageCode: "nl" }, { locationCode: 2616, languageCode: "pl" }, { locationCode: 2620, languageCode: "pt" },
  { locationCode: 2076, languageCode: "pt" }, { locationCode: 2484, languageCode: "es" }, { locationCode: 2840, languageCode: "es" },
];
