/**
 * The operator's clock as a setting: what makes a zone valid, and how a reader
 * turns the saved value into the zone it uses. Config-free, so browser code
 * and the journey harness can import it; `os-time-zone.ts` beside this
 * compiles `config/constants.json` in and serves only as the fallback. Every
 * day-boundary reader resolves the zone through `savedOsTimeZone`, store
 * first, so a deployed install never keeps the zone of its last build.
 */

/**
 * Does `Intl` know this zone? The runtime's own tz database is the only
 * authority: `Intl.DateTimeFormat` throws a RangeError on a name it cannot
 * resolve.
 */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate `config/constants.json` `os_time_zone` at the build boundary, the
 * same way `parseDashboardConfig` validates the display config: a zone the
 * runtime cannot resolve fails the build rather than shipping charts whose
 * x-axis silently falls back to UTC.
 */
export function parseOsTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('config/constants.json os_time_zone must be a non-empty string');
  }
  const zone = value.trim();
  if (!isIanaTimeZone(zone)) {
    throw new Error(
      `config/constants.json os_time_zone must be an IANA timezone name (Area/City, as Intl knows it), got ${JSON.stringify(value)}`,
    );
  }
  return zone;
}

/**
 * The zone to read days in: the saved `config/constants.json` document's
 * `os_time_zone` when it is one `Intl` can resolve, else `fallback` — the copy
 * compiled into the reader's own bundle.
 *
 * A stored document has no build to fail, so a value that is not a usable zone
 * falls back rather than throwing: the page an operator opens to fix a setting
 * must still render, and a zone `Intl` rejects would otherwise move every
 * boundary to UTC in silence. Total by design — anything that is not an object
 * carrying a usable zone answers `fallback`.
 */
export function savedOsTimeZone(constants: unknown, fallback: string): string {
  if (constants === null || typeof constants !== 'object' || Array.isArray(constants)) return fallback;
  const saved = (constants as { os_time_zone?: unknown }).os_time_zone;
  const zone = typeof saved === 'string' ? saved.trim() : saved;
  return isIanaTimeZone(zone) ? zone : fallback;
}

/** The runtime's own spelling of a zone (`Etc/UTC` and `UTC` are one clock),
 * or null for a name `Intl` cannot resolve. */
function canonicalZone(value: unknown): string | null {
  if (!isIanaTimeZone(value)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
}

/**
 * Has somebody chosen this installation's clock? Yes once a save ever set
 * `os_time_zone` (`everSaved`, the config change record), or when the saved
 * zone is not the product's default. A new installation runs on the default
 * (UTC) and nobody chose it.
 */
export function timeZoneChosen(saved: string, productDefault: string, everSaved: boolean): boolean {
  return everSaved || canonicalZone(saved) !== canonicalZone(productDefault);
}

/**
 * The zone a first run offers with one press: the browser's, while nobody has
 * chosen the clock and the browser reads another one. Null otherwise —
 * including a browser zone `Intl` cannot resolve, which is no proposal at all.
 */
export function proposedTimeZone(
  clock: { timeZone: string; chosen: boolean },
  browserZone: string | null | undefined,
): string | null {
  if (clock.chosen) return null;
  const browser = canonicalZone(browserZone);
  if (browser === null || browser === canonicalZone(clock.timeZone)) return null;
  return browser;
}
