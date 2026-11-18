import { ASSET_ID_MAX, CONFIG_ASSET_KEY_RE } from '../packages/contract/src/configuration.mjs';
import { readJourneyDefinitions } from '../packages/contract/src/journeys.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const assetKey = value => typeof value === 'string' && value.length <= ASSET_ID_MAX && CONFIG_ASSET_KEY_RE.test(value);
const propertyId = value => typeof value === 'string' && /^(?:properties\/)?[0-9]{1,32}$/u.test(value);
const disabled = status => status === 'skipped' || status === 'not-applicable';
const needsGa4 = definitions => definitions.some(definition =>
  definition.kind === 'funnel' && definition.source !== 'first-party' && definition.status === 'active');

export function projectShadowJourneys(valueEvents, integrations, assets) {
  if (!record(valueEvents?.assets)) return [];
  return Object.entries(valueEvents.assets).flatMap(([asset, saved]) => {
    if (!assetKey(asset) || !assets.has(asset)) return [];
    const definitions = readJourneyDefinitions(saved?.journeys);
    if (!definitions?.length) return [];
    const mapping = needsGa4(definitions) ? integrations?.assets?.[asset]?.ga4 : undefined;
    if (disabled(mapping?.status)) return [{ asset, definitions, ga4: { status: mapping.status } }];
    if (mapping?.propertyId != null) {
      if (!propertyId(mapping.propertyId)) throw new Error('A saved journey has an invalid GA4 property.');
      return [{ asset, definitions, ga4: { status: 'needs-setup', propertyId: mapping.propertyId } }];
    }
    return [{ asset, definitions }];
  });
}

export function validShadowJourneys(value) {
  if (!Array.isArray(value)) return false;
  const assets = new Set();
  return value.every(entry => {
    const hasBinding = record(entry) && Object.hasOwn(entry, 'ga4');
    if (!exact(entry, ['asset', 'definitions', ...(hasBinding ? ['ga4'] : [])])
      || !assetKey(entry.asset) || assets.has(entry.asset) || !readJourneyDefinitions(entry.definitions)?.length) return false;
    assets.add(entry.asset);
    if (!hasBinding) return true;
    const { ga4 } = entry;
    return needsGa4(entry.definitions) && (disabled(ga4?.status) ? exact(ga4, ['status'])
      : exact(ga4, ['status', 'propertyId']) && ga4.status === 'needs-setup' && propertyId(ga4.propertyId));
  });
}
