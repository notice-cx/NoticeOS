import { ASSET_ID_RE } from '../packages/contract/src/configuration.mjs';

export const CUSTOMER_PROVIDERS = ['mediavine', 'stripe', 'bing-webmaster'] as const;
export type CustomerProvider = typeof CUSTOMER_PROVIDERS[number];
export interface CustomerSitePull {
  workspaceId: string;
  asset: string;
  token: string;
  urls: string[];
}
export interface CustomerSiteCheck { workspaceId: string; asset: string; origins: string[] }
export interface CustomerRevenueNotices { workspaceId: string; webhookId: string }
export interface CustomerCollectionPolicy {
  siteChecks: CustomerSiteCheck[];
  revenueNotices: CustomerRevenueNotices[];
  taskFollowups: { workspaceId: string; serviceId: string }[];
  googleDaily: boolean;
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

function siteCheck(value: unknown): value is CustomerSiteCheck {
  return isRecord(value) && Object.keys(value).length === 3 && typeof value.workspaceId === 'string' && UUID.test(value.workspaceId)
    && typeof value.asset === 'string' && value.asset.length <= 512 && ASSET_ID_RE.test(value.asset)
    && Array.isArray(value.origins) && value.origins.length > 0 && value.origins.length <= 8
    && value.origins.every(origin => typeof origin === 'string' && approvedUrl(origin + '/') && new URL(origin).origin === origin)
    && new Set(value.origins).size === value.origins.length;
}

function revenueNotice(value: unknown): value is CustomerRevenueNotices {
  return isRecord(value) && Object.keys(value).length === 2 && typeof value.workspaceId === 'string' && UUID.test(value.workspaceId)
    && typeof value.webhookId === 'string' && /^[0-9]{17,20}$/u.test(value.webhookId);
}

/** The stored site's domain must still match an origin approved for this workspace and asset. */
export function selectedCustomerSite(policy: CustomerCollectionPolicy | undefined, workspace: string, asset: string, domain: string | null) {
  if (!domain || !PUBLIC_HOST.test(domain)) return undefined;
  return policy?.siteChecks?.find(site => site.workspaceId === workspace && site.asset === asset && site.origins.includes('https://' + domain));
}

/** The reference reads distinguish a site's outage from a collector without internet access. */
export const HEALTH_BEACONS = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://www.google.com/generate_204'] as const;
export function siteCheckAddress(url: URL, origins: readonly string[]) {
  return !url.username && !url.password && !url.hash && (origins.includes(url.origin) || HEALTH_BEACONS.some(target => target === url.href));
}

export function revenueWebhookId(url: URL) {
  if (url.origin !== 'https://discord.com' || url.username || url.password || url.hash || url.search) return null;
  return /^\/api\/webhooks\/([0-9]{17,20})\/[A-Za-z0-9_-]{16,256}$/u.exec(url.pathname)?.[1] ?? null;
}

/** Host configuration authorizes the targets. A workspace's edited roster can
 * disable a target, but cannot redirect its existing bearer elsewhere. */
export function customerCollectionPolicy(value: unknown): CustomerCollectionPolicy {
  if (!isRecord(value)) throw new Error('Invalid local customer collection settings.');
  const { googleDaily = false, collectorProviders = [], sitePulls = [], siteChecks = [], revenueNotices = [], taskFollowups = [] } = value;
  if (!Array.isArray(siteChecks) || siteChecks.length > 256 || !siteChecks.every(siteCheck)
    || new Set(siteChecks.map(site => JSON.stringify([site.workspaceId, site.asset]))).size !== siteChecks.length
    || !Array.isArray(revenueNotices) || revenueNotices.length > 64 || !revenueNotices.every(revenueNotice)
    || new Set(revenueNotices.map(notice => notice.workspaceId)).size !== revenueNotices.length
    || !Array.isArray(taskFollowups) || taskFollowups.length > 64 || !taskFollowups.every(entry => isRecord(entry)
      && Object.keys(entry).length === 2 && typeof entry.workspaceId === 'string' && UUID.test(entry.workspaceId)
      && typeof entry.serviceId === 'string' && UUID.test(entry.serviceId))
    || new Set(taskFollowups.map(entry => entry.workspaceId)).size !== taskFollowups.length
    || new Set(taskFollowups.map(entry => entry.serviceId)).size !== taskFollowups.length
    || typeof googleDaily !== 'boolean' || !Array.isArray(collectorProviders) || !collectorProviders.every(provider)
    || new Set(collectorProviders).size !== collectorProviders.length || !Array.isArray(sitePulls) || sitePulls.length > 64
    || !sitePulls.every(sitePull) || new Set(sitePulls.map(site => JSON.stringify([site.workspaceId, site.asset]))).size !== sitePulls.length) {
    throw new Error('Invalid local customer collection settings.');
  }
  return { googleDaily, collectorProviders, sitePulls, siteChecks, revenueNotices, taskFollowups };
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
