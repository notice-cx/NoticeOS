import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JourneyDefinition } from '@noticeos/contract/journeys';
import type { Ga4PropertyQuota } from '@noticeos/contract';
import { ga4JourneyRequest, ga4JourneyResult, ga4VisitorRequest, ga4VisitorResult, journeyWindows, runGa4Journeys } from '../src/ga4-journeys.js';
import { archiveCollectedDump, archivePart, runGa4JourneyDumps, runSignalDumps, type SignalDumpOutcome } from '../src/signal-dumps.js';
import { EGRESS_DOWN_RULE_ID, EgressGate } from '../src/egress.js';
import type { GooglePropertyTarget } from '../src/google-signals.js';
import { SignalError } from '../src/signal-store.js';
import { flagRows, pgAll, pgExecute, reset } from './helpers';
import { providerDumpFetch } from './signal-dumps-fixture';

const DEFINITION: JourneyDefinition = {
  id: 'signup', label: 'Signup', kind: 'funnel', status: 'active', goal: 'Create an account', version: 1,
  steps: [
    { id: 'view', label: 'View', alternatives: [{ eventName: 'page_view', pagePath: '/join' }] },
    { id: 'complete', label: 'Complete', withinSeconds: 3600, alternatives: [{ eventName: 'sign_up' }, { eventName: 'activation_handoff', parameters: [{ name: 'action', value: 'create_account' }] }] },
  ],
};
const TARGET: GooglePropertyTarget = {
  account: 'test', asset: 'meadow.example', integration: 'ga4', propertyRef: '123456', credentialRef: 'test',
  timeZone: 'America/Los_Angeles', timeZoneAssumed: false, mappingSource: 'register',
  auth: { kind: 'service-account', account: { clientEmail: 'test@example.com', privateKey: 'unused', privateKeyId: null } },
};
const NOW = Date.parse('2026-10-25T12:15:00Z');
function response(users = [100, 25], metadata: Record<string, unknown> = {}) {
  return { metricHeaders: [{ name: 'activeUsers' }], rows: [{ metricValues: [{ value: '500' }] }], funnelTable: {
    dimensionHeaders: [{ name: 'funnelStepName' }], metricHeaders: [{ name: 'activeUsers' }], metadata,
    rows: DEFINITION.steps.map((step, index) => ({ dimensionValues: [{ value: `${index + 1}. ${step.id}` }], metricValues: [{ value: String(users[index]) }] })),
  }, propertyQuota: { tokensPerDay: { consumed: 2, remaining: 100000 }, tokensPerHour: { consumed: 2, remaining: 20000 } } };
}
function visitorResponse(users = 500, metadata: Record<string, unknown> = {}) {
  return { metricHeaders: [{ name: 'activeUsers' }], rows: [{ metricValues: [{ value: String(users) }] }],
    metadata, propertyQuota: response().propertyQuota };
}
function outcome(report: string, end: string, status: 'unchanged' | 'error' = 'error'): SignalDumpOutcome {
  return { asset: TARGET.asset, integration: 'ga4', report, reportDate: end, status,
    providerRows: 0, providerTruncated: false, objectKey: null, errorCode: status === 'error' ? 'failed' : null };
}
function collect(fetchImpl: typeof fetch, options: { nowMs?: number; definition?: JourneyDefinition; definitions?: readonly JourneyDefinition[]; budget?: number; target?: GooglePropertyTarget; errors?: unknown[]; quotas?: (Ga4PropertyQuota | null)[] } = {}) {
  const nowMs = options.nowMs ?? NOW;
  const target = options.target ?? TARGET;
  return runGa4Journeys({ env, target, definitions: options.definitions ?? [options.definition ?? DEFINITION], nowMs, accessToken: 'test-token', fetchImpl,
    budget: { remaining: options.budget ?? 96 },
    archive: (report, end, collected) => archiveCollectedDump(env, { provider: 'google', target, report,
      reportDate: end, requestedAt: new Date(nowMs).toISOString(), dataState: 'revision-window', collected }),
    reuse: async (report, end) => outcome(report, end, 'unchanged'),
    failed: async (report, end, error) => { options.errors?.push(error); return outcome(report, end); }, quota: async (quota) => { options.quotas?.push(quota); },
  });
}

beforeEach(reset);
describe('GA4 ordered journey collection', () => {
  it('uses property-local completed days and eight Monday-Sunday windows', () => {
    const periods = journeyWindows(Date.parse('2026-10-26T00:30:00Z'), TARGET.timeZone);
    expect(periods[0]).toMatchObject({ startDate: '2026-10-17', endDate: '2026-10-23' });
    expect(periods[1]).toMatchObject({ startDate: '2026-10-10', endDate: '2026-10-16' });
    expect(periods[2]).toMatchObject({ startDate: '2026-09-26', endDate: '2026-10-23' });
    expect(periods[3]).toMatchObject({ startDate: '2026-08-29', endDate: '2026-09-25' });
    expect(periods.filter((p) => p.kind === 'week')).toHaveLength(8);
    expect(periods[4]).toMatchObject({ startDate: '2026-10-12', endDate: '2026-10-18' });
  });
  it('makes a completed week eligible on Tuesday in the property time zone', () => {
    const before = journeyWindows(Date.parse('2026-10-27T03:59:59Z'), 'America/New_York');
    const after = journeyWindows(Date.parse('2026-10-27T04:00:00Z'), 'America/New_York');
    expect(before[0]!.endDate).toBe('2026-10-24');
    expect(before[4]).toMatchObject({ startDate: '2026-10-12', endDate: '2026-10-18' });
    expect(after[0]!.endDate).toBe('2026-10-25');
    expect(after[4]).toMatchObject({ startDate: '2026-10-19', endDate: '2026-10-25' });
  });
  it('requests a closed ordered funnel with exact OR alternatives, parameter and time rules', () => {
    const request = ga4JourneyRequest(DEFINITION, journeyWindows(NOW, TARGET.timeZone)[0]!);
    expect(request).toMatchObject({ funnel: { isOpenFunnel: false, steps: [
      { name: 'view', isDirectlyFollowedBy: false, filterExpression: { orGroup: { expressions: [{ andGroup: { expressions: [
        { funnelEventFilter: { eventName: 'page_view' } }, { funnelFieldFilter: { fieldName: 'unifiedPagePathScreen', stringFilter: { value: '/join', matchType: 'EXACT', caseSensitive: true } } },
      ] } }] } } },
      { name: 'complete', withinDurationFromPriorStep: '3600s', filterExpression: { orGroup: { expressions: [
        { funnelEventFilter: { eventName: 'sign_up' } },
        { funnelEventFilter: { eventName: 'activation_handoff', funnelParameterFilterExpression: { andGroup: { expressions: [
          { funnelParameterFilter: { eventParameterName: 'action', stringFilter: { value: 'create_account' } } },
        ] } } } },
      ] } } },
    ] } });
  });
  it('collects exact page paths through the filter dimension accepted by Funnel conditions', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (String(_url).endsWith(':runReport')) return Response.json(visitorResponse());
      const request = String(init?.body);
      if (request.includes('"fieldName":"pagePath"')) {
        return Response.json({ error: { message: 'Dimension pagePath is not supported in funnel conditions.' } }, { status: 400 });
      }
      expect(request).toContain('"fieldName":"unifiedPagePathScreen","stringFilter":{"matchType":"EXACT","value":"/join","caseSensitive":true}');
      return Response.json(response());
    };
    const request = JSON.stringify(ga4JourneyRequest(DEFINITION, journeyWindows(NOW, TARGET.timeZone)[0]!));
    const legacy = await fetchImpl('https://fixture.invalid/', { body: request.replace('unifiedPagePathScreen', 'pagePath') });
    expect(legacy.status).toBe(400);
    const results = await collect(fetchImpl);
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.status === 'success')).toBe(true);
  });
  it('stops the invalid definition after one 400 while collecting the next definition', async () => {
    const invalid: JourneyDefinition = { ...DEFINITION, id: 'recipe-save', steps: [
      { id: 'view', label: 'View', alternatives: [{ eventName: 'recipe_view' }] },
      { id: 'complete', label: 'Save', alternatives: [{ eventName: 'recipe_save', parameters: [{ name: 'action', value: 'save' }] }] },
    ] };
    const requests: string[] = [];
    const errors: unknown[] = [];
    const results = await collect(async (_url, init) => {
      const request = String(init?.body);
      requests.push(request);
      return request.includes('recipe_save')
        ? Response.json({ error: { message: 'The event parameter action is not supported in this filter.' } }, { status: 400 })
        : Response.json(response());
    }, { definitions: [invalid, DEFINITION], errors });
    expect(requests).toHaveLength(25);
    expect(requests.filter((request) => request.includes('recipe_save'))).toHaveLength(1);
    expect(results.slice(0, 12).every((result) => result.status === 'error')).toBe(true);
    expect(results.slice(12).every((result) => result.status === 'success')).toBe(true);
    expect(errors).toHaveLength(12);
    expect(errors.every((error) => error instanceof SignalError && error.code === 'ga4_journey_400'
      && error.message === 'GA4 journey "recipe-save" report failed (400): The event parameter action is not supported in this filter.')).toBe(true);
  });
  it('bounds the provider reason and removes credentials before retaining a diagnostic', async () => {
    const errors: unknown[] = [];
    await collect(async () => Response.json({
      error: { message: `Invalid request test-token Bearer fixture-bearer refresh_token=fixture-refresh\n-----BEGIN PRIVATE KEY-----\nfixture-private\n-----END PRIVATE KEY----- ${'detail '.repeat(100)}` },
      headers: { Authorization: 'fixture-raw-header' },
    }, { status: 400 }), { errors });
    const error = errors[0];
    expect(error).toBeInstanceOf(SignalError);
    const diagnostic = (error as SignalError).message;
    expect(diagnostic).toContain('GA4 journey "signup" report failed (400): Invalid request');
    expect(diagnostic.length).toBeLessThanOrEqual(500);
    for (const secret of ['test-token', 'fixture-bearer', 'fixture-refresh', 'fixture-private', 'fixture-raw-header']) {
      expect(diagnostic).not.toContain(secret);
    }
    expect(diagnostic).not.toMatch(/[\r\n]/);
  });
  it.each([401, 403, 429, 500, 'offline'] as const)('keeps a %s failure scoped to the whole property', async (failure) => {
    let calls = 0;
    const errors: unknown[] = [];
    const definitions = [DEFINITION, { ...DEFINITION, id: 'another-signup' }];
    const results = await collect(async () => {
      calls += 1;
      if (failure === 'offline') throw new Error('fixture network offline');
      return Response.json({ error: { message: 'Fixture provider refusal.' } }, { status: failure });
    }, { definitions, errors });
    expect(calls).toBe(1);
    expect(results).toHaveLength(24);
    expect(results.every((result) => result.status === 'error')).toBe(true);
    expect(errors.every((error) => error === errors[0])).toBe(true);
  });
  it('preserves measured zero, and refuses incomplete, malformed or increasing counts', () => {
    expect(ga4JourneyResult(DEFINITION, response([0, 0]))).toMatchObject({ quality: 'complete', steps: [{ users: 0 }, { users: 0 }] });
    for (const body of [{}, response([10, 11]), response([10, Number.NaN])]) {
      expect(ga4JourneyResult(DEFINITION, body)).toMatchObject({ quality: 'unavailable', steps: [{ users: null }, { users: null }] });
    }
    const sampled = response([100, 25], { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }] });
    expect(ga4JourneyResult(DEFINITION, sampled)).toMatchObject({ quality: 'sampled', sampling: { samplesReadCount: '10', samplingSpaceSize: '100' } });
    expect(ga4JourneyResult(DEFINITION, response([100, 25], { subjectToThresholding: true }))).toMatchObject({ quality: 'unavailable', thresholding: 'reported', steps: [{ users: null }, { users: null }] });
  });
  it('measures a separate exact-window visitor population without changing ordered entry conditions', () => {
    const period = journeyWindows(NOW, TARGET.timeZone)[0]!;
    expect(ga4VisitorRequest(period)).toEqual({ dateRanges: [{ startDate: period.startDate, endDate: period.endDate }],
      metrics: [{ name: 'activeUsers' }], returnPropertyQuota: true });
    expect(ga4VisitorResult(visitorResponse(0))).toEqual({ users: 0, quality: 'complete' });
    expect(ga4VisitorResult(visitorResponse(500))).toEqual({ users: 500, quality: 'complete' });
    expect(ga4VisitorResult(visitorResponse(500, { timeZone: 'UTC' }), TARGET.timeZone)).toMatchObject({ users: 500, quality: 'complete' });
    expect(ga4VisitorResult(visitorResponse(500, { samplingMetadatas: [{ samplesReadCount: '100', samplingSpaceSize: '100' }] }))).toEqual({ users: 500, quality: 'complete' });
    expect(ga4VisitorResult(visitorResponse(500, { subjectToThresholding: true }))).toMatchObject({ users: null, quality: 'unavailable' });
    expect(ga4VisitorResult(visitorResponse(500, { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }] }))).toMatchObject({ quality: 'sampled' });
    for (const body of [{}, visitorResponse(Number.NaN), visitorResponse(500, { samplingMetadatas: [{}] }), { ...visitorResponse(), rows: [] },
      { ...visitorResponse(), dimensionHeaders: [{ name: 'date' }] }]) {
      expect(ga4VisitorResult(body)).toMatchObject({ users: null, quality: 'unavailable' });
    }
  });
  it('shares exact-window visitor calls across definitions and archives their independent quality', async () => {
    let visitorCalls = 0;
    let funnelCalls = 0;
    const results = await collect(async (url) => {
      if (String(url).endsWith(':runReport')) { visitorCalls += 1; return Response.json(visitorResponse(500)); }
      funnelCalls += 1; return Response.json(response());
    }, { definitions: [DEFINITION, { ...DEFINITION, id: 'second' }] });
    expect(visitorCalls).toBe(12);
    expect(funnelCalls).toBe(24);
    for (const result of [results[0]!, results[12]!]) {
      const object = await env.RAW_SIGNALS.get(result.objectKey!);
      const envelope = await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).json() as {
        pages: { response: { visitors?: { users: number; quality: string } } }[];
      };
      expect(envelope.pages[0]!.response.visitors).toEqual({ users: 500, quality: 'complete' });
    }
  });
  it('retries unavailable or sampled cached visitor counts even after a window has settled', async () => {
    let visitorCalls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (!String(url).endsWith(':runReport')) return Response.json(response());
      visitorCalls += 1;
      return Response.json(visitorResponse(500, { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }] }));
    };
    await collect(fetchImpl);
    expect(visitorCalls).toBe(12);
    await collect(fetchImpl);
    expect(visitorCalls).toBe(24);
  });
  it('recovers unavailable cached visitor counts while preserving previously collected ordered counts', async () => {
    let visitorCalls = 0;
    let healthy = false;
    const fetchImpl: typeof fetch = async (url) => {
      if (!String(url).endsWith(':runReport')) return Response.json(response());
      visitorCalls += 1;
      return healthy ? Response.json(visitorResponse()) : new Response('{}', { status: 503 });
    };
    await collect(fetchImpl);
    expect(visitorCalls).toBe(1);
    healthy = true;
    await collect(fetchImpl);
    expect(visitorCalls).toBe(13);
    const cached = await collect(fetchImpl);
    expect(cached.every((result) => result.status === 'unchanged')).toBe(true);
    expect(visitorCalls).toBe(13);
  });
  it('reports only Funnel quota through the journey alert callback', async () => {
    const quotas: (Ga4PropertyQuota | null)[] = [];
    await collect(async (url) => {
      if (!String(url).endsWith(':runReport')) return Response.json(response());
      const body = visitorResponse(); body.propertyQuota.tokensPerHour.remaining = 0;
      return Response.json(body);
    }, { quotas });
    expect(quotas).toHaveLength(12);
    expect(quotas.every((quota) => quota?.tokensPerHour?.remaining === 20000)).toBe(true);
  });
  it('retains Core quota guards independently from ordered funnel collection', async () => {
    let visitorCalls = 0;
    let funnelCalls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (!String(url).endsWith(':runReport')) { funnelCalls += 1; return Response.json(response()); }
      visitorCalls += 1;
      const body = visitorResponse(); body.propertyQuota.tokensPerHour.remaining = 0;
      return Response.json(body);
    };
    await collect(fetchImpl);
    await collect(fetchImpl, { definition: { ...DEFINITION, version: 2 } });
    expect(visitorCalls).toBe(1);
    expect(funnelCalls).toBe(24);
  });
  it('keeps ordered users when visitors fail or contradict the funnel', async () => {
    for (const propertyRef of ['baseline-too-small', 'baseline-failed']) {
      const results = await collect(async (url) => String(url).endsWith(':runReport')
        ? propertyRef === 'baseline-too-small' ? Response.json(visitorResponse(50)) : new Response('{}', { status: 503 })
        : Response.json(response()), { target: { ...TARGET, propertyRef } });
      const object = await env.RAW_SIGNALS.get(results[0]!.objectKey!);
      const envelope = await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).json() as {
        pages: { response: { visitors: unknown; steps: unknown } }[];
      };
      expect(envelope.pages[0]!.response).toMatchObject({ visitors: { users: null, quality: 'unavailable' }, steps: [{ users: 100 }, { users: 25 }] });
    }
  });
  it('archives each window directly and caches provider requests before fetching', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return Response.json(response()); };
    const first = await collect(fetchImpl);
    expect(first).toHaveLength(12);
    expect(first.every((result) => result.status === 'success')).toBe(true);
    expect(calls).toBe(24);
    const object = await env.RAW_SIGNALS.get(first[0]!.objectKey!);
    const envelope = await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).json() as {
      pages: { response: { definition: JourneyDefinition; identity: string; period: { endDate: string }; steps: { users: number }[] } }[];
    };
    expect(envelope.pages[0]!.response).toMatchObject({ definition: DEFINITION, identity: 'ga4-active-users',
      period: { endDate: '2026-10-23' }, steps: [{ users: 100 }, { users: 25 }] });
    const { results: archives } = await pgAll<{ report: string; property_ref: string }>(`SELECT report, property_ref FROM noticeos.archive_runs WHERE report LIKE 'journeys-%'`);
    expect(archives).toHaveLength(12);
    expect(archives.every((archive) => archive.property_ref === TARGET.propertyRef)).toBe(true);
    const again = await collect(fetchImpl);
    expect(again.every((result) => result.status === 'unchanged')).toBe(true);
    expect(calls).toBe(24);
    await collect(fetchImpl, { definition: { ...DEFINITION, version: 2 } });
    expect(calls).toBe(48);
  });
  it('rechecks recent completed weeks until a real provider confirmation reaches four days', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return Response.json(response()); };
    const tuesday = Date.parse('2026-10-27T12:15:00Z');
    await collect(fetchImpl, { nowMs: tuesday });
    expect(calls).toBe(22);
    await collect(fetchImpl, { nowMs: tuesday + 86_400_000 });
    expect(calls).toBe(32);
    await collect(fetchImpl, { nowMs: tuesday + 2 * 86_400_000 });
    expect(calls).toBe(42);
    await collect(fetchImpl, { nowMs: tuesday + 3 * 86_400_000 });
    expect(calls).toBe(50);
  });
  it('keeps a provider failure out of counts and stops spending after quota denial', async () => {
    let calls = 0;
    const results = await collect(async () => { calls += 1; return Response.json({ error: { status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }); });
    expect(calls).toBe(1);
    expect(results.every((result) => result.status === 'error')).toBe(true);
  });
  it('stops at the Funnel quota reserve and checks saved quota before another provider request', async () => {
    let calls = 0;
    const low = response();
    low.propertyQuota.tokensPerHour.remaining = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return Response.json(low); };
    await collect(fetchImpl);
    expect(calls).toBe(1);
    await collect(fetchImpl, { definition: { ...DEFINITION, version: 2 } });
    expect(calls).toBe(1);
  });
  it('bounds requests while using the configured timezone before provider metadata arrives', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return Response.json(response()); };
    await collect(fetchImpl, { budget: 2 });
    expect(calls).toBe(2);
    const results = await collect(fetchImpl, { target: { ...TARGET, propertyRef: '654321', timeZoneAssumed: true }, budget: 2 });
    expect(calls).toBe(4);
    expect(results.some((result) => result.status === 'success')).toBe(true);
  });
  it('keeps exact outage obligations blocked by saved quota and clears only a reused window for the selected asset', async () => {
    const low = response();
    low.propertyQuota.tokensPerHour.remaining = 0;
    const initial = await collect(async () => Response.json(low));
    const cached = initial[0]!;
    const guarded = initial[1]!;
    expect(cached.status).toBe('success');
    expect(guarded.status).toBe('error');
    const cachedPart = archivePart('ga4', cached.report, cached.reportDate);
    const guardedPart = archivePart('ga4', guarded.report, guarded.reportDate);
    const unrelatedPart = archivePart('ga4', 'events', guarded.reportDate);
    const dark = new EgressGate(env, {
      lane: 'signal-dumps', at: new Date(NOW - 3_600_000).toISOString(),
      fetchImpl: async () => { throw new Error('fixture network offline'); },
    });
    await dark.isDown();
    dark.recordUnmeasured(TARGET.asset, cachedPart);
    dark.recordUnmeasured(TARGET.asset, guardedPart);
    dark.recordUnmeasured(TARGET.asset, unrelatedPart);
    dark.recordUnmeasured('northwind.example', cachedPart);
    dark.recordUnmeasured('ferns.example');
    await dark.finalize();

    const accounts = JSON.parse(env.GOOGLE_SIGNAL_ACCOUNTS!) as Record<string, { properties: Record<string, Record<string, unknown>> }>;
    for (const account of Object.values(accounts)) for (const property of Object.values(account.properties)) property.time_zone = TARGET.timeZone;
    const requests: string[] = [];
    const result = await runGa4JourneyDumps(env, {
      assets: [TARGET.asset], nowMs: NOW, rawConfig: JSON.stringify(accounts),
      journeyConfig: { assets: { [TARGET.asset]: { journeys: [DEFINITION] } } },
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === 'https://www.cloudflare.com/cdn-cgi/trace') return new Response('fixture connection restored');
        throw new Error(`Unexpected provider request: ${url}`);
      },
    });
    expect(requests).toEqual(['https://www.cloudflare.com/cdn-cgi/trace']);
    expect(result).toMatchObject({ unchanged: 1, failed: 11, egress: { up: true, resolved: 0 } });
    expect(result.outcomes.find((entry) => entry.report === guarded.report)).toMatchObject({
      status: 'error', errorCode: 'ga4_journey_budget_exhausted',
    });
    const [flag] = await flagRows('rule_id = $1', [EGRESS_DOWN_RULE_ID]);
    expect(flag?.resolved_at).toBeNull();
    const inputs = JSON.parse(flag!.rule_inputs!) as {
      lanes: Record<string, { unmeasuredAssets: string[]; parts: Record<string, string[]> }>;
    };
    expect(inputs.lanes['signal-dumps']).toMatchObject({
      unmeasuredAssets: [TARGET.asset, 'northwind.example', 'ferns.example'],
      parts: { [TARGET.asset]: [guardedPart, unrelatedPart], 'northwind.example': [cachedPart] },
    });
    expect(inputs.lanes['signal-dumps']!.parts['ferns.example']).toBeUndefined();
  });
  it('uses the exact property timezone already reported by GA4 for an OAuth mapping', async () => {
    await pgExecute(`INSERT INTO noticeos.signal_runs
      (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone, started_at, finished_at,
       status, window_start, window_end, data_state, provider_rows, observation_count)
      VALUES ($1::uuid, 'timezone-fixture', 'meadow.example', 'ga4', 'test', '123456', 'Pacific/Auckland',
        '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', 'success', '2026-10-20', '2026-10-21', 'final', 1, 1)`,
    [await env.STORE.workspaceId()]);
    const starts: string[] = [];
    const results = await collect(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { dateRanges: { startDate: string }[] };
      starts.push(request.dateRanges[0]!.startDate);
      return Response.json(response());
    }, { target: { ...TARGET, timeZone: 'UTC', timeZoneAssumed: true } });
    expect(results.every((result) => result.status === 'success')).toBe(true);
    expect(starts[0]).toBe('2026-10-18');
  });
  it('runs alongside daily ingest and records cache reuse without another Funnel request', async () => {
    const accounts = JSON.parse(env.GOOGLE_SIGNAL_ACCOUNTS!) as Record<string, { properties: Record<string, Record<string, unknown>> }>;
    for (const account of Object.values(accounts)) for (const property of Object.values(account.properties)) property.time_zone = 'UTC';
    const ordinary = providerDumpFetch();
    let funnelRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith(':runFunnelReport')) { funnelRequests += 1; return Response.json(response()); }
      if (String(url).endsWith(':runReport')) {
        const request = JSON.parse(String(init?.body)) as { dimensions?: unknown; metrics?: { name: string }[] };
        if (request.dimensions === undefined && request.metrics?.length === 1 && request.metrics[0]?.name === 'activeUsers') {
          return Response.json(visitorResponse());
        }
      }
      return ordinary.fetchImpl(url, init);
    };
    const options = { nowMs: NOW, fetchImpl, revisionDays: 1, rawConfig: JSON.stringify(accounts),
      journeyConfig: { assets: { 'meadow.example': { journeys: [DEFINITION] } } } };
    const first = await runSignalDumps(env, options);
    expect(first.outcomes.filter((result) => result.report.startsWith('journeys-')).every((result) => result.status === 'success')).toBe(true);
    expect(funnelRequests).toBe(12);
    const second = await runSignalDumps(env, options);
    const reused = second.outcomes.filter((result) => result.report.startsWith('journeys-'));
    expect(reused).toHaveLength(12);
    expect(reused.every((result) => result.status === 'unchanged')).toBe(true);
    expect(funnelRequests).toBe(12);
    const { results } = await pgAll<{ n: number }>("SELECT count(*)::int AS n FROM noticeos.archive_runs WHERE report LIKE 'journeys-%' AND request_count = 0");
    expect(results[0]!.n).toBe(12);
  });
});
