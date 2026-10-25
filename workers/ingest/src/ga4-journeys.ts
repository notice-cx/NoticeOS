import { journeyDefinitionId, readJourneyDefinitions, type JourneyDefinition, type JourneyPeriod } from '@noticeos/contract/journeys';
import { type Ga4PropertyQuota } from '@noticeos/contract';
import type { WorkspaceStore } from '@noticeos/postgres';
import type { GooglePropertyTarget } from './google-signals.js';
import type { CollectedDump, SignalDumpOutcome } from './signal-dumps.js';
import { boundedResponseJson, SignalError } from './signal-store.js';
import { asRecord, sha256Hex } from './shared.js';
import { dateInTimeZone, isValidTimeZone, shiftCalendarDate } from './time-zone.js';
import { previousTimeZone } from './time-zone-change.js';
import { GA4_QUOTA_RESERVE, isQuotaExhausted, parseGa4PropertyQuota } from './ga4-quota.js';
import { signalObjectScope } from './signal-objects.js';

export interface JourneyConfig { assets?: Record<string, { journeys?: unknown } | undefined> }
export interface JourneyWindow { kind: JourneyPeriod['kind']; startDate: string; endDate: string; complete: true }
export interface CachedJourney {
  objectKey: string; objectBytes: number; contentSha256: string; providerRows: number;
}
export interface JourneyBudget { remaining: number }
export const GA4_JOURNEY_REQUEST_LIMIT = 96;
const SETTLE_DAYS = 4;

export function funnelQuotaLow(raw: unknown): boolean {
  const quota = asRecord(raw);
  return [
    ['tokensPerDay', GA4_QUOTA_RESERVE.tokensPerDay], ['tokensPerHour', GA4_QUOTA_RESERVE.tokensPerHour],
    ['tokensPerProjectPerHour', 2_800], ['concurrentRequests', 0], ['serverErrorsPerProjectPerHour', 0],
  ].some(([key, reserve]) => {
    const remaining = asRecord(quota?.[String(key)])?.remaining;
    return typeof remaining === 'number' && remaining <= Number(reserve);
  });
}

async function savedFunnelQuotaLow(env: IngestEnv, target: GooglePropertyTarget, nowMs: number): Promise<boolean> {
  const object = await env.RAW_SIGNALS.get(await funnelQuotaKey(env, target.propertyRef));
  if (!object) return false;
  const saved = asRecord(await boundedResponseJson(new Response(object.body), 'Saved GA4 funnel quota', 16 * 1024));
  const observedAt = typeof saved?.observedAt === 'string' ? Date.parse(saved.observedAt) : Number.NaN;
  if (!Number.isFinite(observedAt) || observedAt > nowMs) return false;
  const quota = asRecord(saved?.quota);
  // Google's daily quota resets at midnight PST, independently of property calendars.
  const quotaDay = (ms: number) => new Date(ms - 8 * 3_600_000).toISOString().slice(0, 10);
  if (quotaDay(observedAt) === quotaDay(nowMs) && funnelQuotaLow({ tokensPerDay: quota?.tokensPerDay })) return true;
  return nowMs - observedAt < 3_600_000 && funnelQuotaLow(quota);
}

async function funnelQuotaKey(env: IngestEnv, propertyId: string): Promise<string> {
  const objects = await signalObjectScope(env);
  const key = await sha256Hex(new TextEncoder().encode(propertyId));
  return objects.key(`checkpoints/ga4-funnel-quota/${key}.json`);
}

/** Each total is requested directly; unique users cannot be summed across days. */
export function journeyWindows(nowMs: number, timeZone: string): JourneyWindow[] {
  const today = dateInTimeZone(nowMs, timeZone);
  const end = shiftCalendarDate(today, -2);
  const period = (kind: JourneyWindow['kind'], endDate: string, days: number): JourneyWindow => ({
    kind, startDate: shiftCalendarDate(endDate, 1 - days), endDate, complete: true,
  });
  const weekday = new Date(`${end}T00:00:00Z`).getUTCDay();
  const lastSunday = shiftCalendarDate(end, -weekday);
  return [period('current7', end, 7), period('prior7', shiftCalendarDate(end, -7), 7),
    period('current28', end, 28), period('prior28', shiftCalendarDate(end, -28), 28),
    ...Array.from({ length: 8 }, (_, index) => period('week', shiftCalendarDate(lastSunday, -7 * index), 7))];
}

export function ga4JourneyRequest(definition: JourneyDefinition, period: JourneyWindow): Record<string, unknown> {
  return {
    dateRanges: [{ startDate: period.startDate, endDate: period.endDate }],
    funnel: { isOpenFunnel: false, steps: definition.steps.map((step) => ({
      name: step.id, isDirectlyFollowedBy: false,
      ...(step.withinSeconds === undefined ? {} : { withinDurationFromPriorStep: `${step.withinSeconds}s` }),
      filterExpression: { orGroup: { expressions: step.alternatives.map((alternative) => {
        const event = { funnelEventFilter: { eventName: alternative.eventName,
          ...(alternative.parameters?.length ? { funnelParameterFilterExpression: { andGroup: { expressions: alternative.parameters.map((parameter) => ({
            funnelParameterFilter: { eventParameterName: parameter.name, stringFilter: { matchType: 'EXACT', value: parameter.value, caseSensitive: true } },
          })) } } } : {}),
        } };
        return alternative.pagePath === undefined ? event : { andGroup: { expressions: [event, {
          funnelFieldFilter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: alternative.pagePath, caseSensitive: true } },
        }] } };
      }) } },
    })) },
    funnelVisualizationType: 'STANDARD_FUNNEL', limit: '100', returnPropertyQuota: true,
  };
}

export function ga4JourneyResult(definition: JourneyDefinition, body: unknown): {
  quality: JourneyPeriod['quality']; reason?: string; steps: JourneyPeriod['steps'];
  sampling?: { samplesReadCount: string; samplingSpaceSize: string }; thresholding: 'reported' | 'not-reported';
} {
  const table = asRecord(asRecord(body)?.funnelTable);
  const dimensions = Array.isArray(table?.dimensionHeaders) ? table.dimensionHeaders : [];
  const metrics = Array.isArray(table?.metricHeaders) ? table.metricHeaders : [];
  const dimension = dimensions.findIndex((header) => asRecord(header)?.name === 'funnelStepName');
  const metric = metrics.findIndex((header) => asRecord(header)?.name === 'activeUsers');
  const missing = () => ({ quality: 'unavailable' as const, reason: 'GA4 did not return complete ordered user counts',
    steps: definition.steps.map((step) => ({ id: step.id, users: null })), thresholding: 'not-reported' as const });
  if (dimension < 0 || metric < 0 || !Array.isArray(table?.rows)) return missing();
  const users = new Map<string, number>();
  for (const value of table.rows) {
    const row = asRecord(value);
    const values = Array.isArray(row?.dimensionValues) ? row.dimensionValues : [];
    const metricValues = Array.isArray(row?.metricValues) ? row.metricValues : [];
    const name = asRecord(values[dimension])?.value;
    const raw = asRecord(metricValues[metric])?.value;
    const step = definition.steps.find((s, index) => name === `${index + 1}. ${s.id}`);
    if (!step || typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || users.has(step.id)) return missing();
    users.set(step.id, Number(raw));
  }
  if (users.size !== definition.steps.length) return missing();
  const steps = definition.steps.map((step) => ({ id: step.id, users: users.get(step.id)! }));
  if (steps.some((step, index) => index > 0 && step.users > steps[index - 1]!.users)) return missing();
  const metadata = asRecord(table.metadata);
  const samples = Array.isArray(metadata?.samplingMetadatas) ? metadata.samplingMetadatas : [];
  const sample = asRecord(samples[0]);
  const sampling = sample && /^\d+$/.test(String(sample.samplesReadCount)) && /^\d+$/.test(String(sample.samplingSpaceSize))
    ? { samplesReadCount: String(sample.samplesReadCount), samplingSpaceSize: String(sample.samplingSpaceSize) } : undefined;
  const thresholded = metadata?.subjectToThresholding === true;
  return { quality: thresholded ? 'unavailable' : samples.length > 0 ? (sampling ? 'sampled' : 'unavailable') : 'complete',
    ...(thresholded ? { reason: 'GA4 reported thresholding' } : samples.length > 0 && !sampling ? { reason: 'GA4 sampling metadata was incomplete' } : {}),
    steps: thresholded || samples.length > 0 && !sampling ? steps.map((step) => ({ ...step, users: null })) : steps,
    ...(sampling ? { sampling } : {}), thresholding: thresholded ? 'reported' : 'not-reported' };
}

async function cachedJourney(store: WorkspaceStore, target: GooglePropertyTarget, report: string, endDate: string,
  nowMs: number): Promise<CachedJourney | null> {
  const [row] = await store.read((tx) => tx.query<{
    objectKey: string; objectBytes: number; contentSha256: string; providerRows: number; confirmedAt: string;
  }>(
    `SELECT o.object_key AS "objectKey", o.object_bytes::float8 AS "objectBytes", o.content_sha256 AS "contentSha256",
            r.provider_rows AS "providerRows", r.requested_at::text AS "confirmedAt"
       FROM noticeos.archive_runs r JOIN noticeos.archive_objects o ON o.workspace_id = r.workspace_id AND o.object_seq = r.object_seq
      WHERE r.asset_id = $1 AND r.integration = 'ga4' AND r.property_ref = $2 AND r.report = $3
        AND r.report_date = $4::date AND r.status IN ('success','unchanged') AND NOT r.provider_truncated
        AND r.request_count > 0 AND r.provider_rows > 0
      ORDER BY r.finished_at DESC, r.run_seq DESC LIMIT 1`, [target.asset, target.propertyRef, report, endDate]));
  if (!row) return null;
  const confirmedDay = dateInTimeZone(Date.parse(row.confirmedAt), target.timeZone);
  const today = dateInTimeZone(nowMs, target.timeZone);
  return confirmedDay === today || confirmedDay >= shiftCalendarDate(endDate, SETTLE_DAYS) ? row : null;
}

export async function runGa4Journeys(input: {
  env: IngestEnv; target: GooglePropertyTarget; definitions: readonly JourneyDefinition[]; nowMs: number;
  accessToken: string | (() => Promise<string>); fetchImpl: typeof fetch; budget: JourneyBudget;
  archive: (report: string, end: string, collected: CollectedDump) => Promise<SignalDumpOutcome>;
  reuse: (report: string, end: string, cached: CachedJourney) => Promise<SignalDumpOutcome>;
  failed: (report: string, end: string, error: unknown) => Promise<SignalDumpOutcome>;
  quota: (quota: Ga4PropertyQuota | null) => Promise<void>;
}): Promise<SignalDumpOutcome[]> {
  const { env, definitions, nowMs, budget } = input;
  let target = input.target;
  const outcomes: SignalDumpOutcome[] = [];
  const active = definitions.filter((d) => d.kind === 'funnel' && d.status === 'active');
  if (active.length === 0) return outcomes;
  const observedTimeZone = await previousTimeZone(env.STORE, target.asset, 'ga4', target.propertyRef);
  if (observedTimeZone && isValidTimeZone(observedTimeZone)) target = { ...target, timeZone: observedTimeZone, timeZoneAssumed: false };
  const objects = await signalObjectScope(env);
  let haltCause: unknown = await savedFunnelQuotaLow(env, target, nowMs)
    ? new SignalError('ga4_journey_budget_exhausted', 'Journey collection request budget is exhausted') : null;
  for (const definition of active) {
    const definitionId = journeyDefinitionId(definition);
    for (const period of journeyWindows(nowMs, target.timeZone)) {
      const request = ga4JourneyRequest(definition, period);
      const requestKey = await sha256Hex(new TextEncoder().encode(JSON.stringify({ definitionId, propertyId: target.propertyRef,
        timeZone: target.timeZone, identity: 'ga4-active-users', kind: period.kind, request })));
      const report = `journeys-${requestKey}`;
      const cached = await cachedJourney(env.STORE, target, report, period.endDate, nowMs);
      if (cached && objects.canReadArchive(cached.objectKey) && await env.RAW_SIGNALS.head(cached.objectKey)) {
        outcomes.push(await input.reuse(report, period.endDate, cached));
        continue;
      }
      try {
        if (target.timeZoneAssumed) throw new SignalError('ga4_journey_timezone_unknown', 'GA4 has not reported this property’s reporting time zone yet');
        if (haltCause !== null) throw haltCause;
        if (budget.remaining <= 0) throw new SignalError('ga4_journey_budget_exhausted', 'Journey collection request budget is exhausted');
        const accessToken = typeof input.accessToken === 'string' ? input.accessToken : await input.accessToken();
        budget.remaining -= 1;
        const response = await input.fetchImpl(`https://analyticsdata.googleapis.com/v1alpha/properties/${encodeURIComponent(target.propertyRef)}:runFunnelReport`, {
          method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
        });
        const body = await boundedResponseJson(response, 'Google', 8 * 1024 * 1024);
        if (!response.ok) {
          throw new SignalError(isQuotaExhausted(response.status, body) ? 'ga4_quota_exhausted' : `ga4_journey_${response.status}`, `GA4 funnel report failed (${response.status})`);
        }
        const quota = parseGa4PropertyQuota(body);
        if (funnelQuotaLow(asRecord(body)?.propertyQuota)) haltCause = new SignalError('ga4_journey_budget_exhausted', 'Journey collection request budget is exhausted');
        try {
          await env.RAW_SIGNALS.put(await funnelQuotaKey(env, target.propertyRef), JSON.stringify({
            observedAt: new Date(nowMs).toISOString(), quota: asRecord(body)?.propertyQuota ?? null,
          }), { httpMetadata: { contentType: 'application/json' } });
        } catch {
          throw new SignalError('local_store_failed', 'GA4 answered, but this machine could not save the Funnel quota reading');
        }
        await input.quota(quota);
        const result = ga4JourneyResult(definition, body);
        const { propertyQuota, ...rawResponse } = asRecord(body) ?? {};
        const normalized = { journeyId: definition.id, definitionId, definition, requestKey, propertyId: target.propertyRef,
          timeZone: target.timeZone, identity: 'ga4-active-users', collectedAt: new Date(nowMs).toISOString(), period, ...result, rawResponse };
        const { collectedAt: _collectedAt, ...canonical } = normalized;
        outcomes.push(await input.archive(report, period.endDate, {
          pages: [{ request, response: { ...normalized, propertyQuota } }],
          canonicalPages: [{ request, response: canonical }], providerRows: result.quality === 'unavailable' ? 0 : result.steps.length,
          providerTruncated: false, quota,
        }));
      } catch (error) {
        haltCause ??= error;
        outcomes.push(await input.failed(report, period.endDate, error));
      }
    }
  }
  return outcomes;
}

export function assetJourneyDefinitions(config: JourneyConfig | undefined, asset: string): readonly JourneyDefinition[] {
  return readJourneyDefinitions(config?.assets?.[asset]?.journeys) ?? [];
}
