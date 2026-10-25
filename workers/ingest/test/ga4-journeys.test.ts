import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JourneyDefinition } from '@noticeos/contract/journeys';
import { ga4JourneyRequest, ga4JourneyResult, journeyWindows, runGa4Journeys } from '../src/ga4-journeys.js';
import { archiveCollectedDump, runSignalDumps, type SignalDumpOutcome } from '../src/signal-dumps.js';
import type { GooglePropertyTarget } from '../src/google-signals.js';
import { pgAll, pgExecute, reset } from './helpers';
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
  return { funnelTable: {
    dimensionHeaders: [{ name: 'funnelStepName' }], metricHeaders: [{ name: 'activeUsers' }], metadata,
    rows: DEFINITION.steps.map((step, index) => ({ dimensionValues: [{ value: `${index + 1}. ${step.id}` }], metricValues: [{ value: String(users[index]) }] })),
  }, propertyQuota: { tokensPerDay: { consumed: 2, remaining: 100000 }, tokensPerHour: { consumed: 2, remaining: 20000 } } };
}
function outcome(report: string, end: string, status: 'unchanged' | 'error' = 'error'): SignalDumpOutcome {
  return { asset: TARGET.asset, integration: 'ga4', report, reportDate: end, status,
    providerRows: 0, providerTruncated: false, objectKey: null, errorCode: status === 'error' ? 'failed' : null };
}
function collect(fetchImpl: typeof fetch, options: { nowMs?: number; definition?: JourneyDefinition; budget?: number; target?: GooglePropertyTarget } = {}) {
  const nowMs = options.nowMs ?? NOW;
  const target = options.target ?? TARGET;
  return runGa4Journeys({ env, target, definitions: [options.definition ?? DEFINITION], nowMs, accessToken: 'test-token', fetchImpl,
    budget: { remaining: options.budget ?? 96 },
    archive: (report, end, collected) => archiveCollectedDump(env, { provider: 'google', target, report,
      reportDate: end, requestedAt: new Date(nowMs).toISOString(), dataState: 'revision-window', collected }),
    reuse: async (report, end) => outcome(report, end, 'unchanged'),
    failed: async (report, end) => outcome(report, end), quota: async () => {},
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
  it('requests a closed ordered funnel with exact OR alternatives, parameter and time rules', () => {
    const request = ga4JourneyRequest(DEFINITION, journeyWindows(NOW, TARGET.timeZone)[0]!);
    expect(request).toMatchObject({ funnel: { isOpenFunnel: false, steps: [
      { name: 'view', isDirectlyFollowedBy: false, filterExpression: { orGroup: { expressions: [{ andGroup: { expressions: [
        { funnelEventFilter: { eventName: 'page_view' } }, { funnelFieldFilter: { fieldName: 'pagePath', stringFilter: { value: '/join', matchType: 'EXACT', caseSensitive: true } } },
      ] } }] } } },
      { name: 'complete', withinDurationFromPriorStep: '3600s', filterExpression: { orGroup: { expressions: [
        { funnelEventFilter: { eventName: 'sign_up' } },
        { funnelEventFilter: { eventName: 'activation_handoff', funnelParameterFilterExpression: { andGroup: { expressions: [
          { funnelParameterFilter: { eventParameterName: 'action', stringFilter: { value: 'create_account' } } },
        ] } } } },
      ] } } },
    ] } });
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
  it('archives each window directly and caches provider requests before fetching', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return Response.json(response()); };
    const first = await collect(fetchImpl);
    expect(first).toHaveLength(12);
    expect(first.every((result) => result.status === 'success')).toBe(true);
    expect(calls).toBe(12);
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
    expect(calls).toBe(12);
    await collect(fetchImpl, { definition: { ...DEFINITION, version: 2 } });
    expect(calls).toBe(24);
  });
  it('rechecks recent completed weeks until a real provider confirmation reaches four days', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return Response.json(response()); };
    const tuesday = Date.parse('2026-10-27T12:15:00Z');
    await collect(fetchImpl, { nowMs: tuesday });
    expect(calls).toBe(12);
    await collect(fetchImpl, { nowMs: tuesday + 86_400_000 });
    expect(calls).toBe(17);
    await collect(fetchImpl, { nowMs: tuesday + 2 * 86_400_000 });
    expect(calls).toBe(22);
    await collect(fetchImpl, { nowMs: tuesday + 3 * 86_400_000 });
    expect(calls).toBe(26);
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
  it('bounds requests and refuses an assumed property timezone without provider access', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return Response.json(response()); };
    await collect(fetchImpl, { budget: 2 });
    expect(calls).toBe(2);
    const results = await collect(fetchImpl, { target: { ...TARGET, propertyRef: '654321', timeZoneAssumed: true } });
    expect(calls).toBe(2);
    expect(results.every((result) => result.status === 'error')).toBe(true);
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
