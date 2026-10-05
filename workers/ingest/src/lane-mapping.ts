// WHICH PROPERTY, SITE OR SCOPE EACH ASSET IS, read by the collectors
// (bead `ro-vu8d.16`, epic `ro-vu8d`, D21).
//
// ONE MAPPING, ONE PLACE. `config/integrations.json`'s `assets.<asset>.<lane>`
// entry is the register the operator edits on that asset's Sources tab
// (`asset-lane` in scripts/config-registers.mjs, bead `ro-vu8d.4`), and since
// this module exists it is also what the collectors ask. Before it, the same
// fact was written down in three other places and read from all three: the GA4
// property id and the Search Console site lived inside the
// `GOOGLE_SIGNAL_ACCOUNTS` credential blob, the Bing site was re-derived per run
// by matching the asset's own domain against the verified list, and the
// DataForSEO scope was `location_code: 2840, language_code: 'en'` written out
// five times in one file. A saved mapping steered nothing.
//
// THE REGISTER WINS WHERE IT HOLDS A VALUE; each lane's old source is the
// FALLBACK, so an asset nobody has mapped keeps exactly the behaviour it had.
//
// AND SINCE `ro-90mr` THE GOOGLE FALLBACK LETS GO BY ITSELF. The credential
// blob's `properties` map held the same fact a second time, which D21 and the
// one-representation rule both refuse as a permanent state; it survived only so
// `ro-vu8d.16` could land without an operator migration. It now answers per
// lane, and only while it still has to: `credentialPropertyMapNeeded` below asks
// the register about every asset the blob NAMES, and the Google collector stops
// reading `ga4_property_id` / `gsc_site_url` on a lane the register already
// answers for all of them. That is a provable no-op the day it flips — a value
// the register holds was already winning — which is exactly why it needs no
// migration and no operator step: the last mapping saved retires the copy.
//
// TIMING IS THE NEXT RUN, ONCE THE STORE HOLDS THE DOCUMENT (beads `ro-syok.7`
// and `ro-7xv2`). `dispatch.ts` resolves `config/integrations.json` store-first
// once per cron fire and passes it in as the `register` override every function
// below already took, so a Save on the Sources tab is what the next collector
// run asks for — no restart, no deploy. The static import below is the FALLBACK
// and nothing more: an install that has not seeded gets `LANE_REGISTER`, byte
// for byte what it got yesterday. The surface derives which of those two it
// says from the same source word (`laneMappingTiming`), so the sentence and the
// behaviour cannot drift.

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
 * WHERE THE VALUE A RUN USED CAME FROM — recorded on every target and tallied
 * into each collector's completion log, so "collected from the register" and
 * "collected from the legacy credential map" are things a run SAID rather than
 * something a reader infers from a value that happens to match.
 */
export type LaneMappingSource =
  /** `config/integrations.json` — the operator's own answer. */
  | 'register'
  /**
   * The `GOOGLE_SIGNAL_ACCOUNTS` credential blob's per-asset property map.
   *
   * RETIRING ITSELF (bead `ro-90mr`): it is read only on a lane where at least
   * one asset the blob names has no mapping of its own, so this source stops
   * appearing in a run's tally the moment the last of them is mapped. What the
   * blob keeps either way is the ROUTING — which account authenticates which
   * asset — and each entry's `time_zone`.
   */
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
 * The shape this module reads out of `config/integrations.json`.
 *
 * The `assets` half is the mapping every resolver below asks. The `catalog`
 * half joined it with bead `ro-vu8d.22`, for LABELS only: the answer to *is the
 * credential's own property map still read* is now reported to the Tower from
 * here (see {@link credentialPropertyMapUse}), and a data source named by id
 * alone would make the card print `gsc` at the operator.
 */
export interface LaneRegister {
  assets: Record<string, Record<string, Record<string, unknown>> | undefined>;
  catalog?: { id?: unknown; label?: unknown }[];
}

/** DataForSEO's portfolio baseline — the United States, in English. Written
 * once here instead of five times in `dataforseo-dumps.ts`, and it is what an
 * asset that has stated no scope of its own still asks in. */
export const DATAFORSEO_BASELINE_LOCATION_CODE = DATAFORSEO_BASELINE_MARKET.locationCode;
export const DATAFORSEO_BASELINE_LANGUAGE_CODE = DATAFORSEO_BASELINE_MARKET.languageCode;

/** The register as compiled in. Every function below takes an override so a
 * test can state its own mapping without editing the operator's file. */
export const LANE_REGISTER = integrationsJson as unknown as LaneRegister;

/**
 * What the register holds for one (asset, lane) — the ONE mapping, or nulls.
 *
 * `laneMapping('example.com', 'ga4').propertyId` is the whole question the GA4
 * collector asks; every resolver below is this plus the lane's own fallback.
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
 * NOT USING, AS THE COLLECTORS READ IT (bead `ro-ujb9.96.7.18`).
 *
 * An asset whose entry for this lane says `skipped` — the operator's "Not
 * using", with its reason, from the asset's Data sources row or an unticked
 * row in the connect panel — or `not-applicable` is NOT COLLECTED: no request,
 * no attempt row, no spend. ONE rule for every provider, asked by every
 * collector before a target is built — Google, Bing, DataForSEO, Clarity,
 * PostHog and Mediavine alike — because Not using is a product concept, not a
 * provider's. It matters most where a lane reaches an asset nobody mapped:
 * Bing matches the asset's own domain against the account's verified sites,
 * and the weekly DataForSEO sweep collects every launched asset with a domain.
 * Until this, both kept collecting (and DataForSEO kept billing) a site its row
 * said was declined — the posture was a word on a card, and the integration
 * health read already drew it paused.
 */
export function laneDeclined(
  asset: string,
  lane: string,
  register: LaneRegister = LANE_REGISTER,
): boolean {
  return cellDeclined(register.assets?.[asset]?.[lane]);
}

/** The same rule asked of one cell already in hand — the integration health
 * read's "paused" and Mediavine's own sync gate ask it this way, so there is
 * one answer to "is this declined" rather than three. */
export function cellDeclined(cell: { status?: unknown } | undefined): boolean {
  return cell?.status === 'skipped' || cell?.status === 'not-applicable';
}

/**
 * The GA4 property id / Search Console site / Bing site this asset maps to.
 *
 * `fallback` is what the lane read before this bead: the credential blob's own
 * value for Google, the verified-site domain match for Bing. It answers only
 * when the register holds nothing, and `null` from both is "nothing points this
 * asset at a property", which each caller already knows how to report.
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
 * One asset's PostHog region, project and funnels (bead `ro-ghis.1`), or the
 * reason they cannot be used. There is NO fallback: PostHog has no
 * portfolio-wide project, and a guessed region or project would read another
 * site's data, so an unmapped asset is skipped with the reason named.
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
 * One scope for one asset, read once and used by all five request builders.
 *
 * The two fields resolve INDEPENDENTLY — an asset that states a location but no
 * language is asking for that market in the baseline language, which is a real
 * answer rather than a half-configured one. The reported `source` is `register`
 * whenever either field came from the file, because that is the question the
 * Sources tab is asking: is this asset's own answer steering the run. The rule
 * is the contract's `savedSearchMarket`, the one the search findings name the
 * market by (bead `ro-ujb9.207`).
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
 * Every asset the register maps on one Google lane, in file order.
 *
 * This is what makes a sign-in enough (`ro-vu8d.3` + `ro-vu8d.17`): an install
 * that connected with OAuth and never pasted an account map has a working
 * credential, and the register is the only thing that can say which asset is
 * which property. The credential blob's own entries still win the ORDER — a
 * caller skips what it already covered — so nothing collects twice.
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
 * THE TWO DATA SOURCES A CREDENTIAL CAN ALSO HOLD THE PROPERTY OF, and the
 * register field that takes the answer over.
 *
 * Keyed by data-source id rather than by provider on purpose: what makes the
 * Google credential special is not its name, it is that `GOOGLE_SIGNAL_ACCOUNTS`
 * carries a `ga4_property_id` / `gsc_site_url` per asset. A provider that never
 * held one gets no answer at all, derived rather than declared.
 */
const CREDENTIAL_PROPERTY_MAP_FIELD: Record<string, 'propertyId' | 'siteUrl'> = {
  ga4: 'propertyId',
  gsc: 'siteUrl',
};

/**
 * DOES THE CREDENTIAL'S OWN PROPERTY MAP STILL HAVE TO ANSWER FOR ANYTHING?
 * (bead `ro-90mr`; made the ONLY answer by bead `ro-vu8d.22`)
 *
 * `named` is every asset the `GOOGLE_SIGNAL_ACCOUNTS` blob NAMES — the keys of
 * its `properties` objects, which are the routing half and stay. The question is
 * only ever asked of those: an install's blob is the list of assets whose
 * Google collection it is responsible for, and an asset nobody has ever put in
 * it cannot be broken by this.
 *
 * WHY THE TOWER NO LONGER ASKS ITS OWN VERSION (bead `ro-vu8d.22`). Until this,
 * two functions answered from different inputs: this one asked it of the assets
 * the CREDENTIAL names, and the Tower asked it of the assets that declare a
 * ga4/gsc cell in `config/integrations.json`, because the Tower must never see
 * credential contents. They agree for every asset in both and diverge for an
 * ORPHAN — an asset the credential names with no entry in the register at all.
 * The collector keeps reading `ga4_property_id` for that asset (correctly: it is
 * its only mapping) while the card said the map answered for none of them, which
 * would tell the operator they can delete ids that are still steering a run.
 * A wrong "safe to remove" is not recoverable from the page, so there is one
 * function, it lives here beside the collector's own read, and the ingest
 * REPORTS the answer as asset ids and data-source ids — no more sensitive than
 * what `IntegrationProviderStatus.assets` already carries.
 *
 * `answersFor` is empty exactly when every named asset is mapped on every
 * covered data source, so `ga4_property_id` / `gsc_site_url` could only be
 * SHADOWED values — and the collector stops reading them rather than reading
 * them to discard them. Per data source, not per install: an asset can be mapped
 * for GA4 and not yet for Search Console, and the half that is finished should
 * not wait for the half that is not.
 *
 * `null` means this credential has no property map to answer about — the honest
 * answer for a provider that never held one, and for a Google install with no
 * account blob at all (an OAuth sign-in and nothing else).
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

/** The collector's own half of the same question, per data source — `true`
 * while this credential's map still answers for any asset it names. Derived
 * from {@link credentialPropertyMapUse} rather than repeating its predicate, so
 * what a run reads and what the card says cannot drift. */
export function credentialPropertyMapNeeded(
  assets: readonly string[],
  lane: 'ga4' | 'gsc',
  register: LaneRegister = LANE_REGISTER,
): boolean {
  return credentialPropertyMapUse(assets, [lane], register)?.needed === true;
}

/**
 * How many of this run's targets each source answered for — one small object
 * per completion log line, so a run records which mapping it ran on without a
 * migration and without repeating the answer per property.
 */
export function mappingSourceTally(
  sources: readonly LaneMappingSource[],
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const source of sources) tally[source] = (tally[source] ?? 0) + 1;
  return tally;
}

/** A register string field, or null — an empty string is "not set", because
 * that is what clearing the field on the Sources tab leaves behind. */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A register integer field, or null. A non-integer number is refused rather
 * than rounded: the declaration only ever licenses integers here. */
function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
