import { MIN_LOCAL_MODEL_OUTPUT_TOKENS, MAX_LOCAL_MODEL_OUTPUT_TOKENS } from '@noticeos/contract/local-model-settings';
import { readTempoMppSettings, TEMPO_HASH, TEMPO_MPP_MAINNET, TEMPO_MPP_TESTNET } from '@noticeos/contract/configuration';
import type { TempoMppSetup } from '@noticeos/contract/tempo-mpp';
import type { IntegrationCredentialsPayload } from '@shared/integrations-page';
import { integrationProvider } from '@noticeos/contract/integrations';
import {
  responseRecord as record, responseString as string, responseNumber as number, responseInteger as integer,
  responseBoolean as boolean, responseNullable as nullable, responseList as list, responseEnum as oneOf,
  responseInstant as instant, responseDay as day, responseMonth as month, responseFields as fields, invalidResponse,
} from './response-value';

const strings = list(string);

export function decodeTempoMppSetup(value: unknown): TempoMppSetup {
  const block = (entry: unknown) => integer(entry) && Number.isSafeInteger(entry) && Number(entry) >= 0;
  if (!fields(value, {
    settings: nullable(entry => readTempoMppSettings(entry) !== null),
    assets: list(entry => fields(entry, { id: string, name: string })),
    scan: nullable(entry => fields(entry, { lastAttemptAt: instant, completedAt: nullable(instant), failed: boolean, nextBlock: block })),
    payments: list(entry => fields(entry, {
      chainId: chain => chain === TEMPO_MPP_MAINNET || chain === TEMPO_MPP_TESTNET,
      hash: hash => string(hash) && TEMPO_HASH.test(hash),
      logIndex: block,
      asset: string,
      baseUnits: amount => string(amount) && /^[1-9]\d{0,77}$/.test(amount),
      settledAt: instant,
      product: nullable(string),
      state: oneOf(['unmatched', 'pending', 'recorded', 'test-payment', 'amount-not-supported']),
    })),
    hasMore: boolean,
  })) invalidResponse('Tempo MPP settings');
  return value as unknown as TempoMppSetup;
}

/** Provider declarations are already shipped for the form. Check that the
 * response uses that same declaration, permitting only its resolved legacy
 * asset metadata. Do not import a server schema or replace received values. */
function providerDeclaration(value: unknown, expected: unknown, legacy = false): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length
    && expected.every((item, index) => providerDeclaration(value[index], item));
  if (!record(expected)) return value === expected;
  if (!record(value)) return false;
  return Object.keys(value).every(key => Object.hasOwn(expected, key) || legacy && key === 'asset' && nullable(string)(value[key]))
    && Object.entries(expected).every(([key, item]) => Object.hasOwn(value, key) && providerDeclaration(value[key], item, key === 'legacyAssetBinding'));
}
const metadata = (value: unknown) => fields(value, {
  account: nullable(string), scopes: strings, connectedAt: nullable(instant), expiresAt: nullable(instant), expirySource: nullable(oneOf(['flow', 'operator'])),
}, { balance: nullable(item => fields(item, {
  usd: amount => string(amount) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(amount) && Number.isFinite(Number(amount)), seenAt: instant,
}) && Object.keys(item as object).every(key => key === 'usd' || key === 'seenAt')) });

function credential(value: unknown, provider: string): boolean {
  return fields(value, {
    provider: id => id === provider, source: oneOf(['store', 'env', 'demo', 'none']), fields: strings, assetsHeld: strings, missingFields: strings,
    auth: nullable(oneOf(['oauth', 'service-account', 'account-key', 'site-keys'])), metadata: nullable(metadata),
    keyVersion: nullable(version => integer(version) && version > 0), createdAt: nullable(instant), updatedAt: nullable(instant),
    lastUsedAt: nullable(instant), lastOkAt: nullable(instant), lastError: nullable(string),
  }, { modelOutputTokens: value => provider === 'local-model' && integer(value) && value >= MIN_LOCAL_MODEL_OUTPUT_TOKENS && value <= MAX_LOCAL_MODEL_OUTPUT_TOKENS, propertyMap: nullable(item => fields(item, {
    needed: boolean, answersFor: list(answer => fields(answer, { asset: string, id: string, label: string })),
  }) && (item.needed === (Array.isArray(item.answersFor) && item.answersFor.length > 0))) });
}
function meter(value: unknown): boolean {
  return value === null || fields(value, { window: window => window === 'asset-day', day,
    assets: list(asset => fields(asset, { asset: string, spent: integer })) })
    || fields(value, { window: window => window === 'portfolio-month', period: month, spentUsd: number, unknownPrices: integer, capUsd: number }, {
      budget: entry => fields(entry, { heldUsd: amount => number(amount) && amount >= 0, availableUsd: amount => number(amount) && amount >= 0 }),
    });
}
export function decodeIntegrationProviders(value: unknown): IntegrationCredentialsPayload {
  if (!fields(value, { generatedAt: instant, keyPresent: boolean, blockers: list(oneOf(['key-missing', 'key-invalid'])), keyReason: nullable(string),
    providers: list(item => {
      if (!record(item) || !record(item.provider) || !string(item.provider.id)) return false;
      const known = integrationProvider(item.provider.id);
      return known !== null && providerDeclaration(item.provider, known) && credential(item.credential, known.id)
        && list(asset => fields(asset, { id: string, lanes: strings }))(item.assets)
        && (!Object.hasOwn(item, 'meter') || meter(item.meter));
    }),
  }) || !Array.isArray(value.providers) || new Set(value.providers.map(item => (item as { provider: { id: string } }).provider.id)).size !== value.providers.length
    || value.keyPresent === true && Array.isArray(value.blockers) && value.blockers.length !== 0) invalidResponse('Integration accounts');
  return value as unknown as IntegrationCredentialsPayload;
}
