// A site's search market: the location and language its DataForSEO reports
// are asked in, one rule for the collector, the findings and the Tower.
//
// Authored TypeScript: `pnpm config:generate` writes the `.mjs` and `.d.mts`
// beside it.

export interface SearchMarket { locationCode: number; languageCode: string }

/**
 * The market every DataForSEO family asks in when a site has saved none of its
 * own — the United States, in English: the product's default, not any one
 * installation's.
 */
export const DATAFORSEO_BASELINE_MARKET: Readonly<SearchMarket> = Object.freeze({ locationCode: 2840, languageCode: 'en' });

/**
 * A site's OWN market: its `dataforseo` entry in config/integrations.json
 * (`locationCode`, `languageCode` — the `asset-lane` register fields). The two
 * resolve independently, as the collector asks: a site that saved a location
 * but no language is asked for that place in the default language. Null when
 * the entry holds neither, and the site is asked in the default market.
 */
export function savedSearchMarket(entry: unknown): SearchMarket | null {
  const cell = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
  const location = typeof cell.locationCode === 'number' && Number.isInteger(cell.locationCode) ? cell.locationCode : null;
  const language = typeof cell.languageCode === 'string' && cell.languageCode !== '' ? cell.languageCode : null;
  if (location === null && language === null) return null;
  return {
    locationCode: location ?? DATAFORSEO_BASELINE_MARKET.locationCode,
    languageCode: language ?? DATAFORSEO_BASELINE_MARKET.languageCode,
  };
}

const LOCATIONS: Readonly<Record<number, string>> = {
  2840: 'United States', 2826: 'United Kingdom', 2124: 'Canada', 2036: 'Australia', 2554: 'New Zealand',
  2372: 'Ireland', 2356: 'India', 2276: 'Germany', 2250: 'France', 2724: 'Spain', 2380: 'Italy',
  2528: 'Netherlands', 2616: 'Poland', 2620: 'Portugal', 2076: 'Brazil', 2484: 'Mexico',
};

/** The register's language enum (`asset-lane` `languageCode`), in words. */
const LANGUAGES: Readonly<Record<string, string>> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', pl: 'Polish',
};

/** A market in words, "United Kingdom · English". A code this table does not
 * name is shown as its number rather than guessed. */
export function marketLabel(market: SearchMarket): string {
  const place = LOCATIONS[market.locationCode] ?? `Location ${market.locationCode}`;
  return `${place} · ${LANGUAGES[market.languageCode] ?? market.languageCode}`;
}
