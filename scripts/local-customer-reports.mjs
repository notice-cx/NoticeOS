import { access } from 'node:fs/promises';
import { loadCustomerWorkflowModule } from './local-customer-workflow-module.mjs';
import path from 'node:path';
import { configDocumentFile, configDocumentKey } from './config-documents.mjs';
import { analyzeSignalHistory, storedSearchMarket, storedValueEvents } from './signal-history-analyze.mjs';
import { customerArchiveCache } from './customer-archive-cache.mjs';
import { parseArchive } from './signal-archive.mjs';
import { DOWNLOADS_MANIFEST } from './signal-downloads.mjs';
import { publishSignalHistory } from './signal-history.mjs';
import { parseRoster, refreshAsset } from './signal-panels-refresh.mjs';
import { SCHEDULED_JOBS, scheduleFor, schedulesRefusal } from './scheduled-jobs.mjs';

const REPORT_JOB = SCHEDULED_JOBS.find(job => job.id === 'panel-refresh');
const FILES = ['config/constants.json', 'config/signal-panels.json', 'config/integrations.json', 'config/value-events.json'];
const KEY_NAMES = FILES.map(configDocumentKey);
const ORIGIN = 'http://reports.invalid';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
export const REPORT_EFFECT_LIMIT_MS = 15 * 60_000;

async function reportConfiguration(store) {
  return store.read(async tx => {
    const rows = await tx.query(`SELECT document_key,body::text,version FROM noticeos.config_documents WHERE document_key=ANY($1::text[])`, [KEY_NAMES]);
    const documents = new Map(rows.map(row => [configDocumentFile(row.document_key), { body: JSON.parse(row.body), version: row.version }]));
    if (documents.size !== FILES.length) throw new Error('The customer report settings are incomplete.');
    const overrides = documents.get('config/constants.json').body.schedules ?? {};
    if (schedulesRefusal(overrides)) throw new Error('The saved customer report schedule is invalid.');
    const schedule = scheduleFor(REPORT_JOB, overrides);
    const roster = parseRoster(JSON.stringify(documents.get('config/signal-panels.json').body));
    const assets = roster.assets.filter(asset => asset.enabled).map(asset => asset.asset);
    const active = await tx.query(`SELECT asset_id FROM noticeos.assets
      WHERE status<>'retired' AND NOT is_os AND asset_id=ANY($1::text[]) ORDER BY asset_id COLLATE "C"`, [assets]);
    return { schedule, roster, documents, active: active.map(row => row.asset_id) };
  });
}

/** Store selection comes from the scheduler's fresh service admission. The
 * report reads only that store's archived object names and saved documents. */
export function localCustomerReports({ sourceRoot, root, bucket }) {
  let helpers;
  return Object.freeze({
    async targets(store) {
      const { schedule, active } = await reportConfiguration(store);
      return active.length ? [{ job: REPORT_JOB.id, schedule, assets: active }] : [];
    },
    async run({ store, workspaceId, asset, scheduledAt, signal = new AbortController().signal }) {
      if (!UUID.test(workspaceId) || await store.workspaceId() !== workspaceId) throw new Error('Customer report workspace unavailable.');
      signal.throwIfAborted();
      const { schedule, roster, documents, active } = await reportConfiguration(store);
      if (!schedule.enabled || !active.includes(asset)) return null;
      const at = new Date(scheduledAt).toISOString();
      const valueEvents = storedValueEvents(documents);
      const market = storedSearchMarket(documents, asset);
      const start = performance.now();
      let reads = 0, archiveReads = 0, heads = 0, objectBytes = 0, cost, fetchedTag;
      const env = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', STORE: store, RAW_SIGNALS: { async get(key) {
        signal.throwIfAborted();
        reads++;
        const content = await bucket.get(key);
        objectBytes += content?.size ?? 0;
        fetchedTag = content?.etag;
        return content;
      } } };
      const { panelReportReader, writeInsightSnapshot } = await (helpers ??= loadCustomerWorkflowModule(sourceRoot, root, `
        export { panelReportReader } from './panel-source.ts';
        export { writeInsightSnapshot } from './insight-snapshots.ts';
      `)
        .catch(error => { helpers = undefined; throw error; }));
      const reader = panelReportReader(env);
      const windowDays = Math.min(400, roster.windowDays);
      const input = await reader.source(asset, windowDays, Date.parse(at));
      const work = path.join(root, workspaceId);
      if (!input.manifest.length) {
        const known = await access(path.join(work, 'downloads', asset, DOWNLOADS_MANIFEST)).then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        if (!known) return null;
      }
      const archives = customerArchiveCache({ root: path.join(work, 'archive-cache', asset), workspaceId, asset,
        async get(key) {
          signal.throwIfAborted();
          fetchedTag = undefined;
          const body = await reader.object(key);
          if (body === null) throw new Error('Could not recover the archived report (HTTP 404).');
          archiveReads++;
          parseArchive(body, { asset, source: 'durable report archive' });
          return { etag: fetchedTag, bytes: Buffer.from(body.endsWith('\n') ? body : `${body}\n`) };
        },
        head(key) { signal.throwIfAborted(); heads++; return bucket.head(key); },
      });
      const report = await refreshAsset(asset, { door: ORIGIN, publish: true,
        downloadsRoot: path.join(work, 'downloads'), historyRoot: path.join(work, 'history'), analysisRoot: path.join(work, 'reports'),
      }, {
        token: '', now: () => at, market, windowDays, freshnessMaxAgeDays: roster.freshnessMaxAgeDays,
        validateArchives(rows) {
          for (const row of rows) {
            if (typeof row.objectKey === 'string' && !row.objectKey.startsWith(`workspaces/${workspaceId}/raw/`)) {
              throw new Error('The archived report manifest has a different workspace.');
            }
          }
        },
        async readArchive(row) {
          const bytes = await archives(row.objectKey, row.reportDate);
          const source = parseArchive(bytes.toString('utf8'), { asset, source: 'durable report archive' });
          if (source.integration !== row.integration || source.report !== row.report || source.reportDate !== row.reportDate) {
            throw new Error('The archived report identity does not match its manifest.');
          }
          return bytes;
        },
        async get(request) {
          signal.throwIfAborted();
          const { origin, pathname, searchParams } = new URL(request);
          if (origin !== ORIGIN) throw new Error('Report adapter selects no external URL.');
          if (pathname === '/api/panel-source' && searchParams.get('asset') === asset) return Response.json(input);
          return new Response(null, { status: 404 });
        },
        async writeHistory(options) {
          signal.throwIfAborted();
          return publishSignalHistory(options, { now: () => at });
        },
        async analyze(options) {
          signal.throwIfAborted();
          const analysis = await analyzeSignalHistory({ ...options, signal, now: at, readValueEvents: async () => valueEvents });
          cost = analysis.cost;
          return analysis;
        },
        async publish({ snapshot }) {
          signal.throwIfAborted();
          const result = await writeInsightSnapshot(env, JSON.stringify(snapshot));
          if (!result.ok) throw new Error('The stored insights writer refused this report.');
          return result;
        },
      });
      return { publication: report.publication, archivesFetched: archiveReads, trendRows: report.trendRows,
        objectReads: reads, objectHeads: heads, objectBytes, elapsedMs: Math.round(performance.now() - start), cost };
    },
  });
}
