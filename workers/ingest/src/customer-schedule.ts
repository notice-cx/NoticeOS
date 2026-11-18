import { WorkerEntrypoint } from 'cloudflare:workers';
import { openWorkspaceStore } from '@noticeos/postgres';
import { openWorkspaceServiceGrant } from '@noticeos/postgres/service-grant';
import { OS_TIME_ZONE, savedOsTimeZone } from '@noticeos/contract';
import { Cron } from 'croner';
import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { createWorkspaceAdmission } from '../../../scripts/workspace-admission.mjs';
import { customerArchive, customerJobStep, customerJobSubject, customerSchedules, isCustomerJob } from '../../../scripts/customer-collection.mjs';
import { customerCollectionPolicy, selectedCustomerCounter, selectedCustomerPull } from '../../../scripts/customer-collection-policy.mjs';
import { readBoundedJsonText } from '../../../scripts/bounded-json-body.mjs';
import { readCollectorConfigs } from './config-store.js';
import { ruleConfigFromConstants, runAssetZeroPulse, runFreshnessCheck } from './db.js';
import { checkSearchTraffic } from './search-traffic-alerts.js';
import { eligibleAssets, runUptimeChecks } from './hygiene.js';
import { runGoogleSignals } from './google-signals.js';
import { runGa4JourneyDumps, runSignalDumps, type Ga4CustomDimensionConfig } from './signal-dumps.js';
import { googleAccessToken, googleAuthCacheKey, type GoogleAuth } from './google-auth.js';
import type { JourneyConfig } from './ga4-journeys.js';
import { recordCustomerHealthHistory, runCustomerSiteCheck } from './customer-site-health.js';
import { runNotifier } from './notifier.js';
import { resolveCredential } from './credentials.js';
import { DISCORD_WEBHOOK_FIELD } from './discord-webhook.js';
import { revenueWebhookId } from '../../../scripts/customer-collection-policy.mjs';
import { runWatchWindows } from './watch-windows.js';
import type { LaneRegister } from './lane-mapping.js';
import { runBingSignals } from './bing-signals.js';
import { runMediavine } from './mediavine.js';
import { runStripeRevenue } from './stripe.js';
import { runPullAdapter, type PullAssetConfig } from './pull.js';
import { runCountersScrape, type CountersConfig } from './counters.js';
import { runPosthogDumps } from './posthog-dumps.js';
import { runClarityDumps } from './clarity-dumps.js';
import { isolateState } from './isolate-state.js';

interface ScheduleEnv extends IngestEnv {
  NOTICEOS_WORKSPACE_DATABASE_URL?: string;
  NOTICEOS_SCHEDULE_GRANTS?: string;
  NOTICEOS_SCHEDULE_GRANT_DB?: { connectionString: string };
  NOTICEOS_CUSTOMER_COLLECTION?: string;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const denied = () => new Response(null, { status: 403 });
// Only admitted archive calls share these tokens. Reading the current credential first
// changes the key on rotation, and missing, expired and rejected grants are never reused.
const googleArchiveTokens = new Map<string, { accessToken: string; expiresAt: number }>();
isolateState('Customer Google archive tokens', { forget: () => googleArchiveTokens.clear(), held: () => googleArchiveTokens.size > 0 });

function archiveAuthorization(workspaceId: string) {
  let used: { key: string; accessToken: string } | undefined;
  return {
    async accessToken(auth: GoogleAuth, scope: string, nowMs: number, fetchImpl: typeof fetch) {
      const key = `${workspaceId}/${googleAuthCacheKey(auth, scope)}`;
      const cached = googleArchiveTokens.get(key);
      if (cached && cached.expiresAt > nowMs) {
        used = { key, accessToken: cached.accessToken };
        return cached.accessToken;
      }
      googleArchiveTokens.delete(key);
      let lifetime = 0;
      const accessToken = await googleAccessToken(auth, scope, nowMs, fetchImpl, seconds => { lifetime = seconds; });
      const expiresAt = nowMs + Math.min(lifetime * 1000 - 30_000, 5 * 60_000);
      if (expiresAt > nowMs) {
        if (googleArchiveTokens.size >= 64) googleArchiveTokens.delete(googleArchiveTokens.keys().next().value!);
        googleArchiveTokens.set(key, { accessToken, expiresAt });
      }
      used = { key, accessToken };
      return accessToken;
    },
    reject() {
      if (used && googleArchiveTokens.get(used.key)?.accessToken === used.accessToken) googleArchiveTokens.delete(used.key);
    },
  };
}

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
    if (typeof workspaceId !== 'string' || !uuid.test(workspaceId) || !isCustomerJob(job)
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
            WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND state='running' AND service_id=$4::uuid
              AND effect_step=$5 AND lease_expires_at>clock_timestamp()`, [workspaceId, job, occurrence, principalId, customerJobStep(job)]));
          if (!claimed.length) return denied();
          const policy = this.env.NOTICEOS_CUSTOMER_COLLECTION
            ? customerCollectionPolicy(JSON.parse(this.env.NOTICEOS_CUSTOMER_COLLECTION))
            : undefined;
          const plan = (await customerSchedules(store, asset, policy)).find(item => item.job === job && (archive
            ? item.archives?.some(target => target.asset === asset && target.archive.provider === archive.provider && target.archive.report === archive.report)
            : item.assets.includes(asset)));
          if (!plan?.schedule.enabled || !new Cron(plan.schedule.cron, { timezone: plan.schedule.timezone ?? 'UTC', paused: true }).match(new Date(time))) {
            return Response.json({ outcome: 'skipped' });
          }
          const signal = request.signal;
          signal?.throwIfAborted();
          if (job === 'asset-zero') {
            const report = await runAssetZeroPulse({ STORE: store });
            return Response.json({ outcome: report ? 'ran' : 'skipped' });
          }
          const env = { ...this.env, STORE: store };
          const authorization = archive && archive.provider !== 'bing-webmaster' && policy?.extendedArchives ? archiveAuthorization(workspaceId) : undefined;
          const fetchImpl: typeof fetch = async (input, init) => {
            const signals = [signal, init?.signal].filter((s): s is AbortSignal => Boolean(s));
            const response = await fetch(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
            if (response.status === 401) authorization?.reject();
            return response;
          };
          if ((job === 'hygiene' || job === 'freshness') && policy && asset !== null) {
            return Response.json(await runCustomerSiteCheck(env, policy, workspaceId, asset, job, time, fetchImpl));
          }
          if (job === 'notifications') {
            const approved = policy?.revenueNotices?.find(notice => notice.workspaceId === workspaceId);
            if (!approved) return denied();
            const destination = async () => {
              const current = await resolveCredential(env, 'discord', 'store-only');
              const url = current.fields[DISCORD_WEBHOOK_FIELD];
              if (current.source !== 'store' || !url) return null;
              const target = new URL(url);
              return revenueWebhookId(target) === approved.webhookId ? target.href : null;
            };
            if (!await destination()) return denied();
            const notice = await runNotifier(env, { revenueOnly: true, fetchImpl: async (input, init) => {
              const request = new Request(input, init);
              if (request.url !== await destination()) throw new Error('Revenue notification destination is unavailable.');
              return fetchImpl(request);
            } });
            const failed = notice.skipped === 'delivery-failed' || notice.skipped === 'store-unavailable';
            return Response.json(notice, { status: failed ? 503 : 200 });
          }
          if (job === 'watch-windows') {
            const result = await runWatchWindows(env, time);
            return Response.json({ evaluated: result.evaluated, readings: result.readings, failed: result.failed.length });
          }
          if (job === 'freshness' && asset !== null) {
            const entries = (await eligibleAssets(env)).filter(site => site.asset === asset);
            const result = await runUptimeChecks(env, { assets: entries, fetchImpl });
            return Response.json({ attempted: result.checked, failed: result.failed.length });
          }
          const { documents, sources } = await readCollectorConfigs(env, ['config/constants.json', 'config/integrations.json',
            ...(job === 'pull' && asset !== null ? ['config/pull.json'] as const : []),
            ...(job === 'site-counters' ? ['config/counters.json'] as const : []),
            ...(archive?.provider === 'ga4' && archive.report === 'journeys' ? ['config/value-events.json'] as const
              : archive?.provider === 'ga4' ? ['config/ga4-custom-dimensions.json'] as const : [])]);
          const constants = documents['config/constants.json'];
          if (job === 'freshness') {
            await runFreshnessCheck(env);
            await checkSearchTraffic(env, ruleConfigFromConstants(constants));
            if (policy) return Response.json({ outcome: 'ran', history: await recordCustomerHealthHistory(env, Date.now()) });
            return Response.json({ outcome: 'ran' });
          }
          const options = { fetchImpl, scheduled: true,
            laneRegister: documents['config/integrations.json'] as LaneRegister | undefined,
            osTimeZone: savedOsTimeZone(constants, OS_TIME_ZONE), configSources: sources };
          if (job === 'mediavine') {
            const { outcome } = await runMediavine(env, { fetchImpl, nowMs: time, assets: plan.portfolioAssets });
            return Response.json({ outcome });
          }
          if (job === 'stripe') {
            const { outcome, reason } = await runStripeRevenue(env, { fetchImpl, nowMs: time, assets: plan.portfolioAssets,
              laneRegister: options.laneRegister, timeZone: options.osTimeZone });
            return Response.json({ outcome, reason });
          }
          if (job === 'pull') {
            if (asset === null) {
              const { attempted, succeeded, failed } = await runBingSignals(env, { ...options, nowMs: time, assets: plan.portfolioAssets });
              return Response.json({ attempted, succeeded, failed });
            }
            const entries = documents['config/pull.json'] as PullAssetConfig[] | undefined;
            const selected = selectedCustomerPull(policy, workspaceId, asset, entries);
            if (!selected) return Response.json({ outcome: 'skipped' });
            const { attempted, succeeded, failed } = await runPullAdapter(env, { ...options, nowMs: time, entries: [selected.entry],
              credential: { asset, token: selected.token } });
            return Response.json({ attempted, succeeded, failed });
          }
          if (archive && asset !== null) {
            if (!env.RAW_SIGNALS) return new Response(null, { status: 503 });
            const result = archive.provider === 'ga4' && archive.report === 'journeys'
              ? await runGa4JourneyDumps(env, { ...options, accessToken: authorization?.accessToken, assets: [asset],
                journeyConfig: documents['config/value-events.json'] as JourneyConfig | undefined })
              : await runSignalDumps(env, { ...options, accessToken: authorization?.accessToken, retryLimit: 1,
                ga4CustomDimensions: documents['config/ga4-custom-dimensions.json'] as Ga4CustomDimensionConfig | undefined,
                ...(archive.provider === 'bing-webmaster' ? { bingArchiveAssets: [asset] }
                  : { googleArchive: { asset, integration: archive.provider, report: archive.report } }) });
            return Response.json({ attempted: result.attempted, succeeded: result.succeeded, unchanged: result.unchanged, failed: result.failed });
          }
          if (job === 'posthog') {
            if (!env.RAW_SIGNALS) return new Response(null, { status: 503 });
            const { attempted, succeeded, unchanged, failed } = await runPosthogDumps(env, { ...options, assets: plan.portfolioAssets ?? [] });
            return Response.json({ attempted, succeeded, unchanged, failed });
          }
          if (asset === null) return denied();
          if (job === 'clarity') {
            if (!env.RAW_SIGNALS) return new Response(null, { status: 503 });
            const { attempted, succeeded, unchanged, failed } = await runClarityDumps(env, { ...options, assets: [asset] });
            return Response.json({ attempted, succeeded, unchanged, failed });
          }
          if (job === 'site-counters') {
            const config = documents['config/counters.json'] as CountersConfig | undefined;
            const selected = selectedCustomerCounter(policy, workspaceId, asset, config?.assets[asset]);
            if (!selected) return Response.json({ outcome: 'skipped' });
            const { attempted, succeeded, failed } = await runCountersScrape(env, { ...options,
              config: { assets: { [asset]: selected.entry } }, credential: { asset, token: selected.token } });
            return Response.json({ attempted, succeeded, failed });
          }
          const result = await runGoogleSignals(env, { ...options, assets: [asset] });
          return Response.json({ attempted: result.attempted, succeeded: result.succeeded, failed: result.failed });
        } finally { await store.close(); }
      });
    } catch (error) {
      const aborted = request.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      console.warn(aborted ? 'customer_collection_aborted' : 'customer_collection_failed');
      return new Response(null, { status: 503 });
    }
    finally { await grant.close(); }
  }
}
