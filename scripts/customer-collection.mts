import { scheduleFor, schedulesRefusal, ALL_SCHEDULED_JOBS, type JobSchedule, type ScheduleOverrides } from './scheduled-jobs.mjs';
import type { WorkspaceStore } from '../packages/postgres/src/store.mjs';
import { CUSTOMER_DATAFORSEO_JOBS, customerDataForSeoFacts, isCustomerDataForSeoJob,
  selectedCustomerSite, selectedCustomerCounter, selectedCustomerPull, type CustomerCollectionPolicy } from './customer-collection-policy.mjs';

export const CUSTOMER_GOOGLE_ARCHIVE_PLAN_URL = 'https://scheduler.internal/google-archive-targets';
const CUSTOMER_JOBS = ['freshness', 'counters', 'site-counters', 'signal-dumps', 'mediavine', 'stripe', 'pull', 'asset-zero', 'posthog', 'clarity',
  'hygiene', 'notifications', 'watch-windows', 'panel-review', 'watch-readbacks', ...CUSTOMER_DATAFORSEO_JOBS] as const;
export type CustomerJob = typeof CUSTOMER_JOBS[number];
export const isCustomerJob = (value: unknown): value is CustomerJob => CUSTOMER_JOBS.some(job => job === value);
export const customerJobStep = (job: CustomerJob) => job === 'asset-zero' ? 'report' : job === 'site-counters' ? 'counters'
  : job === 'posthog' ? 'product' : job === 'clarity' ? 'clarity' : isCustomerDataForSeoJob(job) ? 'search' : 'collect';
const ARCHIVE_REPORTS = {
  ga4: ['pages-screens', 'landing-pages', 'traffic-acquisition', 'events', 'events-28d', 'page-events'],
  gsc: ['query', 'page', 'page-query'],
} as const;
const EXTENDED_ARCHIVE_REPORTS = {
  ga4: [...ARCHIVE_REPORTS.ga4, 'content-groups', 'event-source', 'event-state', 'traffic-sources', 'js-errors', 'landing-page-acquisition'],
  gsc: [...ARCHIVE_REPORTS.gsc, 'country', 'device', 'page-country', 'page-device', 'search-appearance-pages', 'image-page-query', 'discover-page'],
} as const;
type GoogleProvider = keyof typeof ARCHIVE_REPORTS;
export interface CustomerGoogleArchiveTarget { asset: string; provider: GoogleProvider }
export type CustomerArchive = { provider: GoogleProvider; report: string } | { provider: 'bing-webmaster'; report?: never };
export interface CustomerSchedule {
  job: CustomerJob;
  schedule: JobSchedule;
  assets: (string | null)[];
  archives?: { asset: string; archive: CustomerArchive }[];
  portfolioAssets?: string[];
}

export function customerArchive(value: unknown): CustomerArchive | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { provider, report } = value as Partial<Record<keyof CustomerArchive, unknown>>;
  if (Object.keys(value).some(key => key !== 'provider' && key !== 'report')) return null;
  if (provider === 'bing-webmaster' && report === undefined) return { provider };
  if ((provider === 'ga4' || provider === 'gsc') && typeof report === 'string'
    && (EXTENDED_ARCHIVE_REPORTS[provider].some(family => family === report) || provider === 'ga4' && report === 'journeys')) return { provider, report };
  return null;
}

export function customerJobSubject(asset: string, archive?: CustomerArchive): string {
  return archive ? JSON.stringify([asset, archive.provider, archive.report]) : asset;
}

/** Return eligible jobs, including paused jobs. The caller must already hold
 * a fresh service grant for this store. */
export async function customerSchedules(store: WorkspaceStore, asset: string | null = null, policy?: CustomerCollectionPolicy,
  googleScope?: readonly CustomerGoogleArchiveTarget[]): Promise<CustomerSchedule[]> {
  const enrolled = await store.read(tx => tx.query<{
    workspace: string; overrides: string; asset: string | null; isOs: boolean; domain: string | null; status: string;
    connected: string[]; sources: string; pulls: string; counter: string | null; journeys: string | null;
  }>(`SELECT COALESCE(c.body->'schedules','{}'::json)::text AS overrides,
      c.workspace_id::text AS workspace,a.asset_id AS asset,a.is_os AS "isOs",a.domain,a.status,
      COALESCE(i.body->'assets'->a.asset_id,'{}'::json)::text AS sources, COALESCE(p.body,'[]'::json)::text AS pulls,
      (n.body->'assets'->a.asset_id)::text AS counter,
      (v.body->'assets'->a.asset_id->'journeys')::text AS journeys,
      ARRAY (SELECT DISTINCT g.provider FROM noticeos.integration_connections g
        JOIN noticeos.connection_secrets s USING(workspace_id,connection_id)
        WHERE g.provider IN ('google','mediavine','stripe','bing-webmaster','discord','ntasks','posthog','clarity') AND g.workspace_id=c.workspace_id) AS connected
    FROM noticeos.config_documents c
    LEFT JOIN noticeos.assets a ON a.workspace_id=c.workspace_id AND (
      (a.is_os AND $1::text IS NULL) OR
      (NOT a.is_os AND a.status<>'retired' AND ($1::text IS NULL OR a.asset_id=$1)))
    LEFT JOIN noticeos.config_documents i ON i.workspace_id=a.workspace_id AND i.document_key='integrations'
    LEFT JOIN noticeos.config_documents p ON p.workspace_id=a.workspace_id AND p.document_key='pull'
    LEFT JOIN noticeos.config_documents n ON n.workspace_id=a.workspace_id AND n.document_key='counters'
    LEFT JOIN noticeos.config_documents v ON v.workspace_id=a.workspace_id AND v.document_key='value-events'
    WHERE c.document_key='constants' AND ($1::text IS NULL OR a.asset_id IS NOT NULL)
    ORDER BY a.asset_id COLLATE "C"`, [asset]));
  if (!enrolled.length) return [];
  const overrides: ScheduleOverrides = JSON.parse(enrolled[0]!.overrides);
  if (!overrides || schedulesRefusal(overrides)) throw new Error('Invalid saved collection schedule.');
  const planned: CustomerSchedule[] = [];
  const settings = (job: CustomerJob) => {
    const released = ALL_SCHEDULED_JOBS.find(entry => entry.id === job)!;
    return scheduleFor(job === 'counters' ? { ...released, cron: '0 * * * *' } : released, overrides);
  };
  const selfReport = settings('asset-zero');
  if (enrolled.some(row => row.isOs)) {
    planned.push({ job: 'asset-zero', schedule: selfReport, assets: [null] });
  }
  const { workspace } = enrolled[0]!;
  const connected = new Set(enrolled[0]!.connected);
  if (asset === null && policy?.revenueNotices?.some(n => n.workspaceId === workspace) && connected.has('discord')) {
    planned.push({ job: 'notifications', schedule: settings('notifications'), assets: [null] });
  }
  if (asset === null && policy?.taskFollowups?.some(binding => binding.workspaceId === workspace)) {
    for (const job of ['watch-windows', 'panel-review', 'watch-readbacks'] as const) {
      if (job === 'watch-windows' || connected.has('ntasks')) planned.push({ job, schedule: settings(job), assets: [null] });
    }
  }
  const rows = enrolled.filter((row): row is typeof row & { asset: string } => !row.isOs && row.asset !== null);
  if (!rows.length) return planned;
  const sites = rows.filter(row => policy ? selectedCustomerSite(policy, workspace, row.asset, row.domain) : row.domain).map(row => row.asset);
  if (policy && sites.length) planned.push({ job: 'hygiene', schedule: settings('hygiene'), assets: sites });
  const portfolioAssets = rows.map(row => row.asset);
  const allowed = new Set(policy?.collectorProviders);
  const domainRows = rows.filter(row => row.domain);
  const providerSites = domainRows.filter(row => row.status !== 'pre-launch');
  const bingAssets = domainRows.filter(row => {
    const source = JSON.parse(row.sources)?.['bing-webmaster'];
    return source?.status !== 'skipped' && source?.status !== 'not-applicable';
  }).map(row => row.asset);
  planned.push({ job: 'freshness', schedule: settings('freshness'),
    assets: [null, ...sites] });
  const archives: NonNullable<CustomerSchedule['archives']> = [];
  if (connected.has('google') && policy?.googleDaily !== false) {
    planned.push({ job: 'counters', schedule: settings('counters'), assets: portfolioAssets });
    archives.push(...rows.flatMap(({ asset, sources, journeys }) => {
      const source = JSON.parse(sources) as Partial<Record<GoogleProvider, { status?: unknown; propertyId?: unknown; siteUrl?: unknown }>>;
      return (['ga4', 'gsc'] as const).flatMap<{ asset: string; archive: CustomerArchive }>(provider => {
        const selected = source?.[provider];
        const ref = provider === 'ga4' ? selected?.propertyId : selected?.siteUrl;
        const mapped = googleScope?.some(target => target.asset === asset && target.provider === provider)
          ?? (typeof ref === 'string' && Boolean(ref.trim()));
        if (!mapped || selected?.status === 'skipped' || selected?.status === 'not-applicable') return [];
        const reports: string[] = [...(policy?.extendedArchives ? EXTENDED_ARCHIVE_REPORTS : ARCHIVE_REPORTS)[provider]];
        if (policy?.extendedArchives && provider === 'ga4') {
          const definitions: unknown = JSON.parse(journeys ?? 'null');
          if (Array.isArray(definitions) && definitions.some(item => item?.kind === 'funnel' && item.status === 'active' && item.source !== 'first-party')) {
            reports.push('journeys');
          }
        }
        return reports.map(report => ({ asset, archive: { provider, report } }));
      });
    }));
  }
  if (policy?.extendedArchives && allowed.has('bing-webmaster') && connected.has('bing-webmaster')) {
    for (const asset of bingAssets) archives.push({ asset, archive: { provider: 'bing-webmaster' } });
  }
  if (archives.length) planned.push({ job: 'signal-dumps', schedule: settings('signal-dumps'),
    assets: [...new Set(archives.map(target => target.asset))], archives });
  if (!policy) return planned;
  const paid = asset === null ? policy.paidDataForSeo.find(item => item.workspaceId === enrolled[0]!.workspace) : undefined;
  if (paid) {
    const facts = await customerDataForSeoFacts(store, paid);
    for (const job of CUSTOMER_DATAFORSEO_JOBS) {
      if (job === 'dataforseo' ? !paid.weekly : !paid.recovery) continue;
      const schedule = settings(job);
      const enabled = schedule.enabled && facts.budgetReady && facts.connectionMatches && facts.savedCap && facts.eligibleAssets.length > 0;
      planned.push({ job, schedule: { ...schedule, enabled }, assets: [null], portfolioAssets: facts.eligibleAssets });
    }
  }
  const counterAssets = rows.filter(row => selectedCustomerCounter(policy, row.workspace, row.asset, JSON.parse(row.counter ?? 'null'))).map(row => row.asset);
  if (counterAssets.length) planned.push({ job: 'site-counters', schedule: settings('site-counters'), assets: counterAssets });
  for (const job of ['posthog', 'clarity'] as const) {
    if ((job === 'posthog' && asset !== null) || !allowed.has(job) || !connected.has(job)) continue;
    const scopedAssets = providerSites.filter(row => {
      const source = JSON.parse(row.sources)?.[job];
      return source?.status !== 'skipped' && source?.status !== 'not-applicable' && (job === 'clarity' || source?.projectId !== undefined);
    }).map(row => row.asset);
    if (scopedAssets.length) planned.push(job === 'clarity' ? { job, schedule: settings(job), assets: scopedAssets }
      : { job, schedule: settings(job), assets: [null], portfolioAssets: scopedAssets });
  }
  for (const job of ['mediavine', 'stripe'] as const) {
    const schedule = settings(job);
    if (!allowed.has(job) || !connected.has(job)) continue;
    const scopedAssets = job === 'stripe' ? rows.filter(row => {
      const source = JSON.parse(row.sources)?.subscriptions;
      return source?.status !== 'skipped' && source?.status !== 'not-applicable';
    }).map(row => row.asset) : portfolioAssets;
    if (scopedAssets.length) planned.push({ job, schedule, assets: [null], portfolioAssets: scopedAssets });
  }
  const pulls: unknown[] = JSON.parse(rows[0]!.pulls);
  const pullAssets: Array<string | null> = rows.filter(row => selectedCustomerPull(policy, row.workspace, row.asset, pulls)).map(row => row.asset);
  if (asset === null && allowed.has('bing-webmaster') && connected.has('bing-webmaster') && rows.some(row => {
    const source = JSON.parse(row.sources)?.['bing-webmaster'];
    return row.domain && source?.status !== 'skipped' && source?.status !== 'not-applicable';
  })) pullAssets.unshift(null);
  if (pullAssets.length) planned.push({ job: 'pull', schedule: settings('pull'), assets: pullAssets, portfolioAssets });
  return planned;
}
