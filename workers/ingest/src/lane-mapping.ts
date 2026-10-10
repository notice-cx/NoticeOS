// Which property, site or scope each asset is, read by the collectors.
// `config/integrations.json`'s `assets.<asset>.<lane>` entry is the register
// the operator edits on that asset's Sources tab, and it wins where it holds a
// value; each lane's old source is the fallback, so an unmapped asset keeps
// the behaviour it had. The Google credential blob's own property map answers
// only while some asset it names has no mapping (`credentialPropertyMapNeeded`),
// so the last mapping saved retires the copy. `dispatch.ts` resolves the
// document store-first once per cron fire and passes it as `register`; the
// static import is the fallback for an unseeded install.

import {
  DATAFORSEO_BASELINE_MARKET,
  readPosthogAssetSettings,
  savedSearchMarket,
  type CredentialPropertyMapRef,
  type CredentialPropertyMapUse,
  type PosthogAssetSettingsRead,
} from '@noticeos/contract';

import integrationsJson from '../../../config/integrations.json';

/**
 * Where the value a run used came from, recorded on every target and tallied
 * into each collector's completion log.
 */
export type LaneMappingSource =
  /** `config/integrations.json` — the operator's own answer. */
  | 'register'
  /** The `GOOGLE_SIGNAL_ACCOUNTS` credential blob's per-asset property map,
   * read only on a lane where some asset the blob names has no mapping of its
   * own. The blob keeps the routing and each entry's `time_zone` either way. */
  | 'credential'
  /** Bing: the asset's domain matched against the account's verified sites. */
  | 'domain-match'
  /** DataForSEO: the contract's United States · English default. */
  | 'baseline';

/** The lanes that have a per-asset mapping at all (`LANE_MAPPING`). PostHog's
 * is read whole by {@link posthogSettings}, not through `laneMapping`. */
export type MappedLane = 'ga4' | 'gsc' | 'bing-webmaster' | 'dataforseo';

/**
 * One (asset, lane) entry's mapping fields, normalized: a field the register
 * does not hold, or holds as the wrong type, reads as `null` rather than
 * reaching a provider as a surprise. The names are the `asset-lane` field names
 * verbatim — the same strings the Sources tab writes.
 */
export interface LaneMappingFields {
  propertyId: string | null;
  siteUrl: string | null;
  locationCode: number | null;
  languageCode: string | null;
}

/** A value and the source that answered for it. */
export interface ResolvedMapping<T> {
  value: T;
  source: LaneMappingSource;
}

/**
 * The shape this module reads out of `config/integrations.json`. `catalog` is
 * read for labels only, so a data source named by id alone does not make the
 * card print `gsc` at the operator.
 */
export interface LaneRegister {
  assets: Record<string, Record<string, Record<string, unknown>> | undefined>;
  catalog?: { id?: unknown; label?: unknown }[];
}

/** What an asset that has stated no scope of its own still asks in. */
export const DATAFORSEO_BASELINE_LOCATION_CODE = DATAFORSEO_BASELINE_MARKET.locationCode;
export const DATAFORSEO_BASELINE_LANGUAGE_CODE = DATAFORSEO_BASELINE_MARKET.languageCode;

/** The register as compiled in. Every function below takes an override so a
 * test can state its own mapping without editing the operator's file. */
export const LANE_REGISTER = integrationsJson as unknown as LaneRegister;

/**
 * What the register holds for one (asset, lane), or nulls. Every resolver below
 * is this plus the lane's own fallback.
 */
export function laneMapping(
  asset: string,
  lane: MappedLane,
  register: LaneRegister = LANE_REGISTER,
): LaneMappingFields {
  const entry = register.assets?.[asset]?.[lane];
  return {
    propertyId: stringValue(entry?.propertyId),
    siteUrl: stringValue(entry?.siteUrl),
    locationCode: integerValue(entry?.locationCode),
    languageCode: stringValue(entry?.languageCode),
  };
}

/**
 * Not using, as the collectors read it: an asset whose entry for this lane
 * says `skipped` or `not-applicable` is not collected (no request, no attempt
 * row, no spend). One rule for every provider, asked before a target is built,
 * because Not using is a product concept, not a provider's. It matters most
 * where a lane reaches an asset nobody mapped (Bing's domain match, the
 * DataForSEO sweep).
 */
export function laneDeclined(
  asset: string,
  lane: string,
  register: LaneRegister = LANE_REGISTER,
): boolean {
  return cellDeclined(register.assets?.[asset]?.[lane]);
}

/** The same rule asked of one cell already in hand, so there is one answer to
 * "is this declined". */
export function cellDeclined(cell: { status?: unknown } | undefined): boolean {
  return cell?.status === 'skipped' || cell?.status === 'not-applicable';
}

/**
 * The GA4 property id / Search Console site / Bing site this asset maps to.
 * `fallback` is the lane's old source, consulted only when the register holds
 * nothing; `null` from both is "nothing points this asset at a property".
 */
export function resolveLaneRef(
  asset: string,
  lane: 'ga4' | 'gsc' | 'bing-webmaster',
  fallback: ResolvedMapping<string | null>,
  register: LaneRegister = LANE_REGISTER,
): ResolvedMapping<string> | null {
  const mapped = laneMapping(asset, lane, register);
  const declared = lane === 'ga4' ? mapped.propertyId : mapped.siteUrl;
  if (declared !== null) return { value: declared, source: 'register' };
  return fallback.value === null
    ? null
    : { value: fallback.value, source: fallback.source };
}

/**
 * One asset's PostHog region, project and funnels, or the reason they cannot be
 * used. No fallback: a guessed region or project would read another site's
 * data, so an unmapped asset is skipped with the reason named.
 */
export function posthogSettings(
  asset: string,
  register: LaneRegister = LANE_REGISTER,
): PosthogAssetSettingsRead {
  return readPosthogAssetSettings(register.assets?.[asset]?.posthog);
}

/** The scope every DataForSEO family for this asset is asked in. */
export interface DataForSeoScope {
  locationCode: number;
  languageCode: string;
  source: LaneMappingSource;
}

/**
 * One scope for one asset, read once and used by every request builder. The
 * two fields resolve independently; `source` is `register` whenever either
 * came from the file. The rule is the contract's `savedSearchMarket`.
 */
export function resolveDataForSeoScope(
  asset: string,
  register: LaneRegister = LANE_REGISTER,
): DataForSeoScope {
  const saved = savedSearchMarket(register.assets?.[asset]?.dataforseo);
  return saved
    ? { ...saved, source: 'register' }
    : { ...DATAFORSEO_BASELINE_MARKET, source: 'baseline' };
}

/**
 * Every asset the register maps on one Google lane, in file order: what makes
 * a sign-in enough. The credential blob's own entries still win the order, so
 * nothing collects twice.
 */
export function registerMappedAssets(
  lane: 'ga4' | 'gsc',
  register: LaneRegister = LANE_REGISTER,
): { asset: string; ref: string }[] {
  const out: { asset: string; ref: string }[] = [];
  for (const asset of Object.keys(register.assets ?? {})) {
    const mapped = laneMapping(asset, lane, register);
    const ref = lane === 'ga4' ? mapped.propertyId : mapped.siteUrl;
    if (ref !== null) out.push({ asset, ref });
  }
  return out;
}

/**
 * The two data sources a credential can also hold the property of, and the
 * register field that takes the answer over. Keyed by data-source id: a
 * provider that never held one gets no answer at all.
 */
const CREDENTIAL_PROPERTY_MAP_FIELD: Record<string, 'propertyId' | 'siteUrl'> = {
  ga4: 'propertyId',
  gsc: 'siteUrl',
};

/**
 * Does the credential's own property map still have to answer for anything?
 * `named` is every asset the `GOOGLE_SIGNAL_ACCOUNTS` blob names. The ingest
 * answers this rather than the Tower because only the ingest can read the
 * blob: a Tower derivation from the register alone diverges for an orphan
 * asset the credential names with no register entry, and a wrong "safe to
 * remove" is not recoverable from the page. `answersFor` is empty exactly when
 * every named asset is mapped on every covered data source, per data source.
 * `null` means this credential has no property map to answer about.
 */
export function credentialPropertyMapUse(
  named: readonly string[] | null,
  lanes: readonly string[],
  register: LaneRegister = LANE_REGISTER,
): CredentialPropertyMapUse | null {
  const covered = lanes.filter((lane) => lane in CREDENTIAL_PROPERTY_MAP_FIELD);
  if (covered.length === 0 || named === null) return null;
  const labels = new Map(
    (register.catalog ?? [])
      .filter(
        (row): row is { id: string; label: string } =>
          typeof row.id === 'string' && typeof row.label === 'string',
      )
      .map((row) => [row.id, row.label]),
  );
  const answersFor: CredentialPropertyMapRef[] = [];
  for (const asset of named) {
    for (const lane of covered) {
      const mapped = laneMapping(asset, lane as 'ga4' | 'gsc', register);
      const held =
        CREDENTIAL_PROPERTY_MAP_FIELD[lane] === 'propertyId'
          ? mapped.propertyId
          : mapped.siteUrl;
      if (held === null) {
        answersFor.push({ asset, id: lane, label: labels.get(lane) ?? lane });
      }
    }
  }
  return { needed: answersFor.length > 0, answersFor };
}

/** The collector's own half of the same question, derived from
 * {@link credentialPropertyMapUse} so a run and the card cannot drift. */
export function credentialPropertyMapNeeded(
  assets: readonly string[],
  lane: 'ga4' | 'gsc',
  register: LaneRegister = LANE_REGISTER,
): boolean {
  return credentialPropertyMapUse(assets, [lane], register)?.needed === true;
}

/**
 * How many of this run's targets each source answered for, for the completion
 * log line.
 */
export function mappingSourceTally(
  sources: readonly LaneMappingSource[],
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const source of sources) tally[source] = (tally[source] ?? 0) + 1;
  return tally;
}

/** A register string field, or null; an empty string is "not set", which is
 * what clearing the field on the Sources tab leaves behind. */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A register integer field, or null; a non-integer is refused, not rounded. */
function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
