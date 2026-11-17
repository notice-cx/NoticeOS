import { WorkerEntrypoint } from 'cloudflare:workers';
import { openWorkspaceStore } from '@noticeos/postgres';
import { openWorkspaceServiceGrant } from '@noticeos/postgres/service-grant';
import { OS_TIME_ZONE, savedOsTimeZone } from '@noticeos/contract';
import { Cron } from 'croner';
import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { createWorkspaceAdmission } from '../../../scripts/workspace-admission.mjs';
import { customerArchive, customerJobSubject, customerSchedules } from '../../../scripts/customer-collection.mjs';
import { readBoundedJsonText } from '../../../scripts/bounded-json-body.mjs';
import { readCollectorConfigs } from './config-store.js';
import { ruleConfigFromConstants, runFreshnessCheck } from './db.js';
import { checkSearchTraffic } from './search-traffic-alerts.js';
import { eligibleAssets, runUptimeChecks } from './hygiene.js';
import { runGoogleSignals } from './google-signals.js';
import { runSignalDumps } from './signal-dumps.js';
import type { LaneRegister } from './lane-mapping.js';

interface ScheduleEnv extends IngestEnv {
  NOTICEOS_WORKSPACE_DATABASE_URL?: string;
  NOTICEOS_SCHEDULE_GRANTS?: string;
  NOTICEOS_SCHEDULE_GRANT_DB?: { connectionString: string };
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const denied = () => new Response(null, { status: 403 });

/** Only the deployment's private trigger binds this entrypoint. No public route
 * forwards to it. The binding alone cannot run an unclaimed occurrence. */
export class CustomerSchedule extends WorkerEntrypoint<ScheduleEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (workspaceProfile(this.env) !== 'hosted' || url.href !== 'https://scheduler.internal/collect'
      || request.method !== 'POST' || !this.env.NOTICEOS_SCHEDULE_GRANT_DB || !this.env.NOTICEOS_SCHEDULE_GRANTS
      || !this.env.NOTICEOS_WORKSPACE_DATABASE_URL) return denied();
    const connectionString = this.env.NOTICEOS_WORKSPACE_DATABASE_URL;
    let body: { workspaceId?: unknown; job?: unknown; asset?: unknown; occurrence?: unknown; archive?: unknown };
    try { body = JSON.parse(await readBoundedJsonText(request, 4096)); }
    catch { return denied(); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return denied();
    const { workspaceId, job, asset, occurrence } = body;
    if (typeof workspaceId !== 'string' || !uuid.test(workspaceId) || (job !== 'freshness' && job !== 'counters' && job !== 'signal-dumps')
      || (asset !== null && (typeof asset !== 'string' || !asset.length || asset.length > 512))
      || typeof occurrence !== 'string' || occurrence.length > 128) return denied();
    const archive = customerArchive(body.archive);
    if (job === 'signal-dumps' ? !archive || asset === null : body.archive !== undefined) return denied();
    const [at, suffix, extra] = occurrence.split('/');
    const time = Date.parse(at ?? '');
    if (!Number.isFinite(time) || time % 60_000 || new Date(time).toISOString() !== at || extra !== undefined) return denied();
    const digest = asset === null ? 'workspace' : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(customerJobSubject(asset, archive ?? undefined)))), byte => byte.toString(16).padStart(2, '0')).join('');
    if (suffix !== digest) return denied();
    const bindings: { workspaceId: string; serviceId: string }[] = JSON.parse(this.env.NOTICEOS_SCHEDULE_GRANTS);
    const selected = bindings.filter(binding => binding.workspaceId === workspaceId);
    if (selected.length !== 1 || !uuid.test(selected[0]!.serviceId)) return denied();
    const principalId = selected[0]!.serviceId;
    const grant = openWorkspaceServiceGrant({ connectionString: this.env.NOTICEOS_SCHEDULE_GRANT_DB.connectionString, workspaceId, principalId });
    try {
      const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('customer collection'), authority: () => grant.facts() });
      return await admission.withAdmission('workflows.run', { requestedWorkspaceId: workspaceId, correlationId: crypto.randomUUID() }, request, async () => {
        const store = openWorkspaceStore(connectionString, { workspaceId, maxConnections: 1 });
        try {
          const claimed = await store.read(tx => tx.query(`SELECT 1 FROM noticeos.hosted_job_occurrences
            WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND state='running' AND effect_step='collect'
              AND service_id=$4::uuid AND lease_expires_at>clock_timestamp()`, [workspaceId, job, occurrence, principalId]));
          if (!claimed.length) return denied();
          const plan = (await customerSchedules(store, asset)).find(item => item.job === job && (archive
            ? item.archives?.some(target => target.asset === asset && target.archive.provider === archive.provider && target.archive.report === archive.report)
            : item.assets.includes(asset)));
          if (!plan || !new Cron(plan.schedule.cron, { timezone: plan.schedule.timezone ?? 'UTC', paused: true }).match(new Date(time))) {
            return Response.json({ outcome: 'skipped' });
          }
          const env = { ...this.env, STORE: store };
          const signal = request.signal;
          signal?.throwIfAborted();
          const fetchImpl: typeof fetch = (input, init) => {
            const signals = [signal, init?.signal].filter((s): s is AbortSignal => Boolean(s));
            return fetch(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
          };
          if (job === 'freshness' && asset !== null) {
            const entries = (await eligibleAssets(env)).filter(site => site.asset === asset);
            const result = await runUptimeChecks(env, { assets: entries, fetchImpl });
            return Response.json({ attempted: result.checked, failed: result.failed.length });
          }
          const { documents, sources } = await readCollectorConfigs(env, ['config/constants.json', 'config/integrations.json']);
          const constants = documents['config/constants.json'];
          if (job === 'freshness') {
            await runFreshnessCheck(env);
            await checkSearchTraffic(env, ruleConfigFromConstants(constants));
            return Response.json({ outcome: 'ran' });
          }
          if (asset === null) return denied();
          const options = { fetchImpl, scheduled: true,
            laneRegister: documents['config/integrations.json'] as LaneRegister | undefined,
            osTimeZone: savedOsTimeZone(constants, OS_TIME_ZONE), configSources: sources };
          if (archive) {
            if (!env.RAW_SIGNALS) return new Response(null, { status: 503 });
            const result = await runSignalDumps(env, { ...options, retryLimit: 1,
              googleArchive: { asset, integration: archive.provider, report: archive.report } });
            return Response.json({ attempted: result.attempted, succeeded: result.succeeded, unchanged: result.unchanged, failed: result.failed });
          }
          const result = await runGoogleSignals(env, { ...options, assets: [asset] });
          return Response.json({ attempted: result.attempted, succeeded: result.succeeded, failed: result.failed });
        } finally { await store.close(); }
      });
    } catch { return new Response(null, { status: 503 }); }
    finally { await grant.close(); }
  }
}
