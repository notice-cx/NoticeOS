import { ASSET_ID_RE } from '../packages/contract/src/configuration.mjs';
import { DATAFORSEO_BASE_REPORTS, DATAFORSEO_PANEL_REPORT, DATAFORSEO_PERIODIC_REPORTS } from '../packages/contract/src/signal-families.mjs';
import type { Transaction, WorkspaceStore } from '../packages/postgres/src/store.mjs';

export const CUSTOMER_PROVIDERS = ['mediavine', 'stripe', 'bing-webmaster', 'posthog', 'clarity'] as const;
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
  extendedArchives: boolean;
  collectorProviders: CustomerProvider[];
  sitePulls: CustomerSitePull[];
  paidDataForSeo: CustomerDataForSeoApproval[];
}

export const CUSTOMER_DATAFORSEO_JOBS = ['dataforseo', 'dataforseo-recovery'] as const;
export type CustomerDataForSeoJob = typeof CUSTOMER_DATAFORSEO_JOBS[number];
export const isCustomerDataForSeoJob = (value: unknown): value is CustomerDataForSeoJob => CUSTOMER_DATAFORSEO_JOBS.some(job => job === value);
export interface DataForSeoConnectionPin {
  connectionId: string;
  secretVersion: number;
}
export interface CustomerDataForSeoApproval extends DataForSeoConnectionPin {
  workspaceId: string;
  assets: { asset: string; families: string[] }[];
  weekly: boolean;
  recovery: boolean;
  approvedMonthlyCapUsd: number;
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PUBLIC_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const provider = (id: unknown): id is CustomerProvider => CUSTOMER_PROVIDERS.some(item => item === id);
const paidFamilies = new Set<string>([...DATAFORSEO_BASE_REPORTS, ...DATAFORSEO_PERIODIC_REPORTS, DATAFORSEO_PANEL_REPORT]);
const paidKeys = new Set(['workspaceId', 'connectionId', 'secretVersion', 'assets', 'weekly', 'recovery', 'approvedMonthlyCapUsd']);

function paidAsset(value: unknown): value is CustomerDataForSeoApproval['assets'][number] {
  return isRecord(value) && Object.keys(value).length === 2
    && typeof value.asset === 'string' && value.asset.length <= 512 && ASSET_ID_RE.test(value.asset)
    && Array.isArray(value.families) && value.families.length > 0 && value.families.every(family => paidFamilies.has(family))
    && new Set(value.families).size === value.families.length;
}

function paidApproval(value: unknown): value is CustomerDataForSeoApproval {
  return isRecord(value) && Object.keys(value).every(key => paidKeys.has(key))
    && typeof value.workspaceId === 'string' && UUID.test(value.workspaceId)
    && typeof value.connectionId === 'string' && UUID.test(value.connectionId)
    && typeof value.secretVersion === 'number' && Number.isInteger(value.secretVersion) && value.secretVersion > 0 && value.secretVersion <= 2147483647
    && Array.isArray(value.assets) && value.assets.length > 0 && value.assets.length <= 128
    && value.assets.every(paidAsset) && new Set(value.assets.map(item => item.asset)).size === value.assets.length
    && typeof value.weekly === 'boolean' && typeof value.recovery === 'boolean' && (value.weekly || value.recovery)
    && typeof value.approvedMonthlyCapUsd === 'number' && Number.isFinite(value.approvedMonthlyCapUsd) && value.approvedMonthlyCapUsd > 0;
}

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
  const { googleDaily = false, extendedArchives = false, collectorProviders = [], sitePulls = [],
    siteChecks = [], revenueNotices = [], taskFollowups = [], paidDataForSeo = [] } = value;
  if (!Array.isArray(siteChecks) || siteChecks.length > 256 || !siteChecks.every(siteCheck)
    || new Set(siteChecks.map(site => JSON.stringify([site.workspaceId, site.asset]))).size !== siteChecks.length
    || !Array.isArray(revenueNotices) || revenueNotices.length > 64 || !revenueNotices.every(revenueNotice)
    || new Set(revenueNotices.map(notice => notice.workspaceId)).size !== revenueNotices.length
    || !Array.isArray(taskFollowups) || taskFollowups.length > 64 || !taskFollowups.every(entry => isRecord(entry)
      && Object.keys(entry).length === 2 && typeof entry.workspaceId === 'string' && UUID.test(entry.workspaceId)
      && typeof entry.serviceId === 'string' && UUID.test(entry.serviceId))
    || new Set(taskFollowups.map(entry => entry.workspaceId)).size !== taskFollowups.length
    || new Set(taskFollowups.map(entry => entry.serviceId)).size !== taskFollowups.length
    || typeof googleDaily !== 'boolean' || typeof extendedArchives !== 'boolean' || !Array.isArray(collectorProviders) || !collectorProviders.every(provider)
    || new Set(collectorProviders).size !== collectorProviders.length || !Array.isArray(sitePulls) || sitePulls.length > 64
    || !sitePulls.every(sitePull) || new Set(sitePulls.map(site => JSON.stringify([site.workspaceId, site.asset]))).size !== sitePulls.length
    || !Array.isArray(paidDataForSeo) || paidDataForSeo.length > 64 || !paidDataForSeo.every(paidApproval)
    || new Set(paidDataForSeo.map(paid => paid.workspaceId)).size !== paidDataForSeo.length) {
    throw new Error('Invalid local customer collection settings.');
  }
  return { googleDaily, extendedArchives, collectorProviders, sitePulls, siteChecks, revenueNotices, taskFollowups, paidDataForSeo };
}

const approvedDataForSeoConnection = `EXISTS (SELECT 1 FROM noticeos.integration_connections c
        WHERE c.provider='dataforseo' AND c.connection_id=$1::uuid AND c.workspace_id=$2::uuid
          AND (SELECT max(s.secret_version) FROM noticeos.connection_secrets s WHERE s.workspace_id=c.workspace_id
            AND s.connection_id=c.connection_id)=$3::int)`;

export async function dataForSeoConnectionMatches(tx: Transaction, pin: DataForSeoConnectionPin): Promise<boolean> {
  const [facts] = await tx.query<{ matches: boolean }>(`SELECT ${approvedDataForSeoConnection} AS matches`,
    [pin.connectionId, tx.workspaceId, pin.secretVersion]);
  return facts?.matches === true;
}

export async function customerDataForSeoFacts(store: WorkspaceStore, approval: CustomerDataForSeoApproval) {
  return store.read(async tx => {
    if (tx.workspaceId !== approval.workspaceId) throw new Error('Invalid customer workspace for paid collection.');
    const [facts] = await tx.query<{ connectionMatches: boolean; savedCap: boolean; eligibleAssets: string[]; budgetReady: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid=pg_catalog.to_regclass('noticeos.dataforseo_request_charges')
          AND attname='provider_completed' AND NOT attisdropped) AS "budgetReady",
      ${approvedDataForSeoConnection} AS "connectionMatches",
      EXISTS (SELECT 1 FROM noticeos.config_documents c WHERE c.document_key='constants' AND c.workspace_id=$2::uuid
        AND CASE WHEN jsonb_typeof(c.body::jsonb #> '{monthly_caps,data_usd}')='number'
          THEN (c.body::jsonb #>> '{monthly_caps,data_usd}')::numeric > 0 ELSE false END) AS "savedCap",
      ARRAY (SELECT a.asset_id FROM noticeos.assets a
        LEFT JOIN noticeos.config_documents i ON i.workspace_id=a.workspace_id AND i.document_key='integrations'
        WHERE a.workspace_id=$2::uuid AND NOT a.is_os AND a.status NOT IN ('pre-launch','retired') AND a.domain IS NOT NULL
          AND a.asset_id = ANY($4::text[])
          AND coalesce(i.body->'assets'->a.asset_id->'dataforseo'->>'status','') NOT IN ('skipped','not-applicable')
        ORDER BY a.asset_id COLLATE "C") AS "eligibleAssets"`, [approval.connectionId, tx.workspaceId, approval.secretVersion, approval.assets.map(item => item.asset)]);
    if (!facts) throw new Error('Customer DataForSEO approval could not be checked.');
    return facts;
  });
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
