import { scheduleFor, schedulesRefusal, SCHEDULED_JOBS, type JobSchedule, type ScheduleOverrides } from './scheduled-jobs.mjs';
import type { WorkspaceStore } from '../packages/postgres/src/store.mjs';
import { selectedCustomerSite, selectedCustomerPull, type CustomerCollectionPolicy } from './customer-collection-policy.mjs';

const CUSTOMER_JOBS = ['freshness', 'counters', 'signal-dumps', 'mediavine', 'stripe', 'pull', 'asset-zero', 'hygiene', 'notifications', 'watch-windows', 'panel-review', 'watch-readbacks'] as const;
export type CustomerJob = typeof CUSTOMER_JOBS[number];
export const isCustomerJob = (value: unknown): value is CustomerJob => CUSTOMER_JOBS.some(job => job === value);
export const customerJobStep = (job: CustomerJob) => job === 'asset-zero' ? 'report' : 'collect';
const ARCHIVE_REPORTS = {
  ga4: ['pages-screens', 'landing-pages', 'traffic-acquisition', 'events', 'events-28d', 'page-events'],
  gsc: ['query', 'page', 'page-query'],
} as const;
type GoogleProvider = keyof typeof ARCHIVE_REPORTS;
export interface CustomerArchive {
  provider: GoogleProvider;
  report: string;
}
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
  if ((provider !== 'ga4' && provider !== 'gsc') || typeof report !== 'string'
    || !ARCHIVE_REPORTS[provider].some(family => family === report)) return null;
  return { provider, report };
}

export function customerJobSubject(asset: string, archive?: CustomerArchive): string {
  return archive ? JSON.stringify([asset, archive.provider, archive.report]) : asset;
}

/** Return eligible jobs, including paused jobs. The caller must already hold
 * a fresh service grant for this store. */
export async function customerSchedules(store: WorkspaceStore, asset: string | null = null, policy?: CustomerCollectionPolicy): Promise<CustomerSchedule[]> {
  const enrolled = await store.read(tx => tx.query<{
    workspace: string; overrides: string; asset: string; isOs: boolean; domain: string | null; connected: string[]; sources: string; pulls: string;
  }>(`SELECT COALESCE(c.body->'schedules','{}'::json)::text AS overrides,
      a.workspace_id::text AS workspace,a.asset_id AS asset,a.is_os AS "isOs",a.domain,
      COALESCE(i.body->'assets'->a.asset_id,'{}'::json)::text AS sources, COALESCE(p.body,'[]'::json)::text AS pulls,
      ARRAY (SELECT DISTINCT g.provider FROM noticeos.integration_connections g
        JOIN noticeos.connection_secrets s USING(workspace_id,connection_id)
        WHERE g.provider IN ('google','mediavine','stripe','bing-webmaster','discord','ntasks') AND g.workspace_id=a.workspace_id) AS connected
    FROM noticeos.assets a
    JOIN noticeos.config_documents c ON c.workspace_id=a.workspace_id AND c.document_key='constants'
    LEFT JOIN noticeos.config_documents i ON i.workspace_id=a.workspace_id AND i.document_key='integrations'
    LEFT JOIN noticeos.config_documents p ON p.workspace_id=a.workspace_id AND p.document_key='pull'
    WHERE (a.is_os AND $1::text IS NULL)
       OR (NOT a.is_os AND a.status<>'retired' AND ($1::text IS NULL OR a.asset_id=$1))
    ORDER BY a.asset_id COLLATE "C"`, [asset]));
  if (!enrolled.length) return [];
  const overrides: ScheduleOverrides = JSON.parse(enrolled[0]!.overrides);
  if (!overrides || schedulesRefusal(overrides)) throw new Error('Invalid saved collection schedule.');
  const planned: CustomerSchedule[] = [];
  const settings = (job: CustomerJob) => {
    const released = SCHEDULED_JOBS.find(entry => entry.id === job)!;
    return scheduleFor(job === 'counters' ? { ...released, cron: '0 * * * *' } : released, overrides);
  };
  const selfReport = settings('asset-zero');
  if (enrolled.some(row => row.isOs)) {
    planned.push({ job: 'asset-zero', schedule: selfReport, assets: [null] });
  }
  const rows = enrolled.filter(row => !row.isOs);
  if (!rows.length) return planned;
  const { workspace } = rows[0]!;
  const connected = new Set(rows[0]!.connected);
  const sites = rows.filter(row => policy ? selectedCustomerSite(policy, workspace, row.asset, row.domain) : row.domain).map(row => row.asset);
  if (policy && sites.length) planned.push({ job: 'hygiene', schedule: settings('hygiene'), assets: sites });
  if (asset === null && policy?.revenueNotices?.some(n => n.workspaceId === workspace) && connected.has('discord')) {
    planned.push({ job: 'notifications', schedule: settings('notifications'), assets: [null] });
  }
  if (asset === null && policy?.taskFollowups?.some(binding => binding.workspaceId === workspace)) {
    for (const job of ['watch-windows', 'panel-review', 'watch-readbacks'] as const) {
      if (job === 'watch-windows' || connected.has('ntasks')) planned.push({ job, schedule: settings(job), assets: [null] });
    }
  }
  for (const job of ['freshness', 'counters', 'signal-dumps'] as const) {
    if (job !== 'freshness' && (!connected.has('google') || policy?.googleDaily === false)) continue;
    const schedule = settings(job);
    const assets = job === 'freshness' ? [null, ...sites] : rows.map(row => row.asset);
    if (job !== 'signal-dumps') {
      planned.push({ job, schedule, assets });
      continue;
    }
    const archives = rows.flatMap(({ asset, sources }) => {
      const source = JSON.parse(sources) as Partial<Record<GoogleProvider, { status?: unknown; propertyId?: unknown; siteUrl?: unknown }>>;
      return (['ga4', 'gsc'] as const).flatMap(provider => {
        const selected = source?.[provider];
        const ref = provider === 'ga4' ? selected?.propertyId : selected?.siteUrl;
        if (typeof ref !== 'string' || !ref.trim() || selected?.status === 'skipped' || selected?.status === 'not-applicable') return [];
        return ARCHIVE_REPORTS[provider].map(report => ({ asset, archive: { provider, report } }));
      });
    });
    if (archives.length) planned.push({ job, schedule, assets: [...new Set(archives.map(target => target.asset))], archives });
  }
  if (!policy) return planned;
  const allowed = new Set(policy.collectorProviders);
  const portfolioAssets = rows.map(row => row.asset);
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
