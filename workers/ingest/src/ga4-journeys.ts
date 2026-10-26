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
import { redactLogText } from '../../../scripts/os-log.mjs';

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

async function savedFunnelQuotaLow(env: IngestEnv, target: GooglePropertyTarget, nowMs: number, category = 'funnel'): Promise<boolean> {
  const object = await env.RAW_SIGNALS.get(await funnelQuotaKey(env, target.propertyRef, category));
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

async function funnelQuotaKey(env: IngestEnv, propertyId: string, category = 'funnel'): Promise<string> {
  const objects = await signalObjectScope(env);
  const key = await sha256Hex(new TextEncoder().encode(propertyId));
  return objects.key(`checkpoints/ga4-${category}-quota/${key}.json`);
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
          funnelFieldFilter: { fieldName: 'unifiedPagePathScreen', stringFilter: { matchType: 'EXACT', value: alternative.pagePath, caseSensitive: true } },
        }] } };
      }) } },
    })) },
    funnelVisualizationType: 'STANDARD_FUNNEL', limit: '100', returnPropertyQuota: true,
  };
}

type JourneyVisitors = NonNullable<JourneyPeriod['visitors']>;
const unavailableVisitors = (reason: string): JourneyVisitors => ({ users: null, quality: 'unavailable', reason });

export function ga4VisitorRequest(period: JourneyWindow): Record<string, unknown> {
  return { dateRanges: [{ startDate: period.startDate, endDate: period.endDate }],
    metrics: [{ name: 'activeUsers' }], returnPropertyQuota: true };
}

export function ga4VisitorResult(body: unknown, _expectedTimeZone?: string): JourneyVisitors {
  const report = asRecord(body);
  const headers = Array.isArray(report?.metricHeaders) ? report.metricHeaders : [];
  const metric = headers.findIndex((header) => asRecord(header)?.name === 'activeUsers');
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const row = asRecord(rows[0]);
  const values = Array.isArray(row?.metricValues) ? row.metricValues : [];
  const raw = asRecord(values[metric])?.value;
  if (metric < 0 || rows.length !== 1 || (Array.isArray(report?.dimensionHeaders) && report.dimensionHeaders.length > 0) ||
      typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return unavailableVisitors('GA4 did not return a complete visitor count');
  }
  const metadata = asRecord(report?.metadata);
  if (metadata?.subjectToThresholding === true || metadata?.dataLossFromOtherRow === true) {
    return unavailableVisitors('GA4 reported thresholding or incomplete visitor data');
  }
  const samples = Array.isArray(metadata?.samplingMetadatas) ? metadata.samplingMetadatas : [];
  if (samples.length > 0) {
    if (samples.some((sample) => !/^\d+$/.test(String(asRecord(sample)?.samplesReadCount)) ||
      !/^\d+$/.test(String(asRecord(sample)?.samplingSpaceSize)))) {
      return unavailableVisitors('GA4 visitor sampling metadata was incomplete');
    }
    if (samples.some((sample) => BigInt(String(asRecord(sample)?.samplesReadCount)) > BigInt(String(asRecord(sample)?.samplingSpaceSize)))) {
      return unavailableVisitors('GA4 visitor sampling metadata was invalid');
    }
    if (samples.some((sample) => BigInt(String(asRecord(sample)?.samplesReadCount)) < BigInt(String(asRecord(sample)?.samplingSpaceSize)))) {
      return { users: Number(raw), quality: 'sampled', reason: 'GA4 sampled the visitor count' };
    }
  }
  return { users: Number(raw), quality: 'complete' };
}

function journeyRequestError(status: number, body: unknown, definition: JourneyDefinition, accessToken: string): SignalError {
  const message = asRecord(asRecord(body)?.error)?.message;
  const reason = typeof message === 'string'
    ? redactLogText(accessToken ? message.replaceAll(accessToken, '[REDACTED]') : message).replace(/[\r\n]+/g, ' ').trim()
    : '';
  return new SignalError(isQuotaExhausted(status, body) ? 'ga4_quota_exhausted' : `ga4_journey_${status}`,
    `GA4 journey "${definition.id}" report failed (${status})${reason ? `: ${reason}` : ''}`.slice(0, 500));
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

async function cachedVisitorsComplete(env: IngestEnv, cached: CachedJourney): Promise<boolean> {
  try {
    const object = await env.RAW_SIGNALS.get(cached.objectKey);
    if (!object) return false;
    const archive = asRecord(await boundedResponseJson(new Response(object.body.pipeThrough(new DecompressionStream('gzip'))),
      'Saved GA4 journey', 8 * 1024 * 1024));
    const pages = Array.isArray(archive?.pages) ? archive.pages : [];
    return pages.some((page) => asRecord(asRecord(asRecord(page)?.response)?.visitors)?.quality === 'complete');
  } catch {
    return false;
  }
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
  const visitorCounts = new Map<string, JourneyVisitors>();
  let visitorQuotaLow = await savedFunnelQuotaLow(env, target, nowMs, 'core');
  let haltCause: unknown = await savedFunnelQuotaLow(env, target, nowMs)
    ? new SignalError('ga4_journey_budget_exhausted', 'Journey collection request budget is exhausted') : null;
  for (const definition of active) {
    const definitionId = journeyDefinitionId(definition);
    let definitionHaltCause: SignalError | null = null;
    for (const period of journeyWindows(nowMs, target.timeZone)) {
      const request = ga4JourneyRequest(definition, period);
      const requestKey = await sha256Hex(new TextEncoder().encode(JSON.stringify({ definitionId, propertyId: target.propertyRef,
        timeZone: target.timeZone, identity: 'ga4-active-users', visitorProtocol: 1, kind: period.kind, request })));
      const report = `journeys-${requestKey}`;
      const cached = await cachedJourney(env.STORE, target, report, period.endDate, nowMs);
      if (cached && objects.canReadArchive(cached.objectKey) && await env.RAW_SIGNALS.head(cached.objectKey) &&
          (haltCause !== null || visitorQuotaLow || await cachedVisitorsComplete(env, cached))) {
        outcomes.push(await input.reuse(report, period.endDate, cached));
        continue;
      }
      try {
        if (haltCause !== null) throw haltCause;
        if (definitionHaltCause !== null) throw definitionHaltCause;
        if (budget.remaining <= 0) throw new SignalError('ga4_journey_budget_exhausted', 'Journey collection request budget is exhausted');
        const accessToken = typeof input.accessToken === 'string' ? input.accessToken : await input.accessToken();
        budget.remaining -= 1;
        const response = await input.fetchImpl(`https://analyticsdata.googleapis.com/v1alpha/properties/${encodeURIComponent(target.propertyRef)}:runFunnelReport`, {
          method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
        });
        const body = await boundedResponseJson(response, 'Google', 8 * 1024 * 1024);
        if (!response.ok) {
          throw journeyRequestError(response.status, body, definition, accessToken);
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
        const visitorKey = `${period.startDate}:${period.endDate}`;
        let visitors = visitorCounts.get(visitorKey);
        let visitorPage: { request: Record<string, unknown>; response: unknown } | undefined;
        if (!visitors) {
          if (haltCause !== null || visitorQuotaLow || budget.remaining <= 0) {
            visitors = unavailableVisitors('Visitor collection request budget is exhausted');
          } else {
            const visitorRequest = ga4VisitorRequest(period);
            try {
              budget.remaining -= 1;
              const visitorResponse = await input.fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(target.propertyRef)}:runReport`, {
                method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(visitorRequest), signal: AbortSignal.timeout(30_000),
              });
              const visitorBody = await boundedResponseJson(visitorResponse, 'Google visitors', 1024 * 1024);
              visitorPage = { request: visitorRequest, response: visitorResponse.ok ? visitorBody : { status: visitorResponse.status } };
              if (!visitorResponse.ok) {
                visitorQuotaLow = true;
                visitors = unavailableVisitors(`GA4 visitor report failed (${visitorResponse.status})`);
              } else {
                visitors = ga4VisitorResult(visitorBody, target.timeZone);
                visitorQuotaLow = funnelQuotaLow(asRecord(visitorBody)?.propertyQuota);
                await env.RAW_SIGNALS.put(await funnelQuotaKey(env, target.propertyRef, 'core'), JSON.stringify({
                  observedAt: new Date(nowMs).toISOString(), quota: asRecord(visitorBody)?.propertyQuota ?? null,
                }), { httpMetadata: { contentType: 'application/json' } });
              }
            } catch {
              visitorPage ??= { request: visitorRequest, response: { unavailable: true } };
              visitorQuotaLow = true;
              visitors = unavailableVisitors('GA4 visitor count could not be collected');
            }
          }
          visitorCounts.set(visitorKey, visitors);
        }
        const visitorUsers = visitors.users;
        if (typeof visitorUsers === 'number' && result.steps.some((step) => step.users !== null && step.users > visitorUsers)) {
          visitors = unavailableVisitors('GA4 visitor count was lower than the ordered journey count');
        }
        const { propertyQuota, ...rawResponse } = asRecord(body) ?? {};
        const normalized = { journeyId: definition.id, definitionId, definition, requestKey, propertyId: target.propertyRef,
          timeZone: target.timeZone, identity: 'ga4-active-users', collectedAt: new Date(nowMs).toISOString(), period, ...result, visitors, rawResponse };
        const { collectedAt: _collectedAt, ...canonical } = normalized;
        outcomes.push(await input.archive(report, period.endDate, {
          pages: [{ request, response: { ...normalized, propertyQuota } }, ...(visitorPage ? [visitorPage] : [])],
          canonicalPages: [{ request, response: canonical }], providerRows: result.quality === 'unavailable' ? 0 : result.steps.length,
          providerTruncated: false, quota,
        }));
      } catch (error) {
        // Invalid filters belong to one saved definition; quota, auth and transport failures stop the property.
        if (error instanceof SignalError && error.code === 'ga4_journey_400') definitionHaltCause ??= error;
        else haltCause ??= error;
        outcomes.push(await input.failed(report, period.endDate, error));
      }
    }
  }
  return outcomes;
}

export function assetJourneyDefinitions(config: JourneyConfig | undefined, asset: string): readonly JourneyDefinition[] {
  return readJourneyDefinitions(config?.assets?.[asset]?.journeys) ?? [];
}
