import { scheduleFor, schedulesRefusal, SCHEDULED_JOBS, type JobSchedule, type ScheduleOverrides } from './scheduled-jobs.mjs';
import type { WorkspaceStore } from '../packages/postgres/src/store.mjs';

export type CustomerJob = 'counters' | 'freshness' | 'signal-dumps';
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

/** Read only configuration, asset IDs and the presence of a credential. The caller
 * must already hold a fresh service grant for this store. */
export async function customerSchedules(store: WorkspaceStore, asset: string | null = null): Promise<CustomerSchedule[]> {
  const rows = await store.read(tx => tx.query<{
    overrides: string; asset: string; domain: string | null; google: boolean; sources: string;
  }>(`SELECT COALESCE(c.body->'schedules','{}'::json)::text AS overrides,
      a.asset_id AS asset,a.domain,COALESCE(i.body->'assets'->a.asset_id,'{}'::json)::text AS sources,
      EXISTS (SELECT 1 FROM noticeos.integration_connections g
        JOIN noticeos.connection_secrets s USING(workspace_id,connection_id)
        WHERE g.provider='google' AND g.workspace_id=a.workspace_id) AS google
    FROM noticeos.assets a
    JOIN noticeos.config_documents c ON c.workspace_id=a.workspace_id AND c.document_key='constants'
    LEFT JOIN noticeos.config_documents i ON i.workspace_id=a.workspace_id AND i.document_key='integrations'
    WHERE a.status<>'retired' AND NOT a.is_os AND ($1::text IS NULL OR a.asset_id=$1)
    ORDER BY a.asset_id COLLATE "C"`, [asset]));
  if (!rows.length) return [];
  const overrides: ScheduleOverrides = JSON.parse(rows[0]!.overrides);
  if (!overrides || schedulesRefusal(overrides)) throw new Error('Invalid saved collection schedule.');
  const planned: CustomerSchedule[] = [];
  for (const job of ['freshness', 'counters', 'signal-dumps'] as const) {
    if (job !== 'freshness' && !rows[0]!.google) continue;
    const released = SCHEDULED_JOBS.find(entry => entry.id === job)!;
    const schedule = scheduleFor(job === 'counters' ? { ...released, cron: '0 * * * *' } : released, overrides);
    if (!schedule.enabled) continue;
    const assets = job === 'freshness' ? [null, ...rows.filter(row => row.domain).map(row => row.asset)] : rows.map(row => row.asset);
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
  return planned;
}
