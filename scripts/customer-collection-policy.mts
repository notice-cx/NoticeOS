import { ASSET_ID_RE } from '../packages/contract/src/configuration.mjs';

export const CUSTOMER_PROVIDERS = ['mediavine', 'stripe', 'bing-webmaster', 'posthog', 'clarity'] as const;
export type CustomerProvider = typeof CUSTOMER_PROVIDERS[number];
export interface CustomerSitePull {
  workspaceId: string;
  asset: string;
  token: string;
  urls: string[];
}
export interface CustomerCollectionPolicy {
  googleDaily: boolean;
  extendedArchives: boolean;
  collectorProviders: CustomerProvider[];
  sitePulls: CustomerSitePull[];
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PUBLIC_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const provider = (id: unknown): id is CustomerProvider => CUSTOMER_PROVIDERS.some(item => item === id);

function approvedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.href === value && !url.port && !url.username && !url.password && !url.hash
      && PUBLIC_HOST.test(url.hostname) && !/\.(?:local|localhost|internal)$/u.test(url.hostname);
  } catch { return false; }
}

function sitePull(value: unknown): value is CustomerSitePull {
  return isRecord(value) && Object.keys(value).length === 4 && typeof value.workspaceId === 'string' && UUID.test(value.workspaceId)
    && typeof value.asset === 'string' && value.asset.length <= 512 && ASSET_ID_RE.test(value.asset)
    && typeof value.token === 'string' && /^[\x21-\x7e]{1,1024}$/u.test(value.token)
    && Array.isArray(value.urls) && value.urls.length > 0 && value.urls.length <= 8 && value.urls.every(approvedUrl)
    && new Set(value.urls).size === value.urls.length;
}

/** Host configuration authorizes the targets. A workspace's edited roster can
 * disable a target, but cannot redirect its existing bearer elsewhere. */
export function customerCollectionPolicy(value: unknown): CustomerCollectionPolicy {
  if (!isRecord(value)) throw new Error('Invalid local customer collection settings.');
  const { googleDaily = false, extendedArchives = false, collectorProviders = [], sitePulls = [] } = value;
  if (typeof googleDaily !== 'boolean' || typeof extendedArchives !== 'boolean'
    || !Array.isArray(collectorProviders) || !collectorProviders.every(provider)
    || new Set(collectorProviders).size !== collectorProviders.length || !Array.isArray(sitePulls) || sitePulls.length > 64
    || !sitePulls.every(sitePull) || new Set(sitePulls.map(site => JSON.stringify([site.workspaceId, site.asset]))).size !== sitePulls.length) {
    throw new Error('Invalid local customer collection settings.');
  }
  return { googleDaily, extendedArchives, collectorProviders, sitePulls };
}

export function selectedCustomerCounter<T>(policy: CustomerCollectionPolicy | undefined, workspaceId: string, asset: string, entry: T) {
  const approved = policy?.sitePulls.find(site => site.workspaceId === workspaceId && site.asset === asset);
  if (!approved || !isRecord(entry) || !isRecord(entry.source) || entry.source.kind !== 'prometheus'
    || entry.source.enabled !== true || typeof entry.source.url !== 'string' || !approved.urls.includes(entry.source.url)
    || !Array.isArray(entry.cards) || !entry.cards.length) return null;
  return { entry, token: approved.token };
}

export function selectedCustomerPull<T>(policy: CustomerCollectionPolicy | undefined, workspaceId: string, asset: string, pulls: readonly T[] | undefined) {
  const approved = policy?.sitePulls.find(site => site.workspaceId === workspaceId && site.asset === asset);
  if (!approved || !Array.isArray(pulls)) return null;
  const matching: T[] = pulls.filter(entry => isRecord(entry) && entry.asset === asset && entry.enabled === true);
  const [entry] = matching;
  if (matching.length !== 1 || !isRecord(entry) || (entry.format !== 'prometheus' && entry.format !== 'envelope')
    || typeof entry.url !== 'string' || !approved.urls.includes(entry.url)) return null;
  if (entry.additionalEndpoints !== undefined && (!Array.isArray(entry.additionalEndpoints)
    || !entry.additionalEndpoints.every(item => isRecord(item) && (item.enabled === false
      || item.enabled === true && typeof item.url === 'string' && approved.urls.includes(item.url))))) return null;
  return { entry, token: approved.token };
}
