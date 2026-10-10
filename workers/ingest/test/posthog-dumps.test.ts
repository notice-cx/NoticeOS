import { env } from 'cloudflare:test';
import { POSTHOG_FAMILIES, integrationFailureMessage, posthogArchiveBodySchema, type PosthogFunnel } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  POSTHOG_LEASE_MS,
  POSTHOG_REQUEST_TIMEOUT_MS,
  POSTHOG_RETRY_LIMIT,
  claimPosthogLease,
  posthogLeaseKey,
  posthogQuery,
  runPosthogDumps,
  windowFor,
} from '../src/posthog-dumps.js';
import { putCredential } from '../src/credentials.js';
import { forgetConfigCache, getConfigDocument, seedConfigDocuments } from '../src/config-store.js';
import { EGRESS_DOWN_CODE, EGRESS_DOWN_RULE_ID } from '../src/egress.js';
import { healthFailure } from '../src/integration-health-store.js';
import { readIntegrationHealth } from '../src/integration-health-read.js';
import { LOCAL_STORE_FAILED } from '../src/signal-dumps.js';
import type { LaneRegister } from '../src/lane-mapping.js';
import {
  ARCHIVE_RUNS,
  credentialVerdict,
  cutUplink,
  openEgressFlags,
  pgAll,
  pgCount,
  pgFirst,
  pgRows,
  refuseArchiveRuns,
  reset,
  emptyTables,
  setConnection,
  storeArchiveRun,
  storedHealthStates,
} from './helpers.js';

// 12:30 UTC on 2026-09-23 is 08:30 in New York: the last complete project day
// is 2026-09-22, so the daily windows END there.
const NOW = Date.parse('2026-09-23T12:30:00.000Z');
const KEY = 'phx_test_personal_key_never_logged';
const ORIGIN = 'https://us.posthog.com';

const CALCULATOR: PosthogFunnel = {
  id: 'calculator',
  name: 'Calculator',
  steps: [{ event: '$pageview', path: '/calculator' }, { event: 'form_start' }, { event: 'calculation_complete' }],
};

function register(settings: Record<string, unknown> = { host: 'us', projectId: '424242', funnels: [CALCULATOR] }): LaneRegister {
  return { assets: { 'meadow.example': { posthog: settings } } };
}

const KEYS = JSON.stringify({ 'meadow.example': KEY });

// ---------------------------------------------------------------------------
// Recorded response fixtures, shaped as PostHog's query endpoint answers:
// `results` rows in the SELECT's column order, plus `columns`.
// ---------------------------------------------------------------------------

const FIXTURE_ROWS: Record<string, unknown[][]> = {
  'web-daily': [
    ['2026-09-21', 41220, 17350, 19880],
    ['2026-09-22', 43910, 18012, 20431],
  ],
  events: [
    ['$pageview', 612004, 190331, '2026-09-08', '2026-09-22'],
    ['$exception', 48640, 4210, '2026-09-08', '2026-09-22'],
    ['form_start', 15864, 15864, '2026-09-08', '2026-09-22'],
    ['calculation_complete', 15394, 15394, '2026-09-08', '2026-09-22'],
    ['first_meal_logged', 1597, 527, '2026-09-08', '2026-09-22'],
  ],
  exceptions: [
    ['TypeError', 'Load failed', 40975, 1314, 2210, 402, 0, '/calculator', 'Mobile Safari'],
    ['Error', 'Script error.', 1702, 1438, 1511, 4, 0, '/', 'Chrome'],
    ['TypeError', "Cannot read properties of undefined (reading 'default')", 301, 264, 280, 3, 1, '/recipes', 'Chrome'],
    ['TypeError', 'm._result.default', 133, 117, 121, 2, 1, '/calculator', 'Safari'],
  ],
  rageclicks: [
    ['/calculator', 'input', null, 'heightFeet', 3301, 1493, 3290, 9, 2, 18826],
    ['/calculator', 'input', null, 'heightInches', 2270, 1041, 2262, 6, 2, 18826],
    ['/calculator', 'input', null, 'age', 2140, 987, 2131, 7, 2, 18826],
    ['/calculator', 'input', null, 'weight', 1660, 757, 1655, 4, 1, 18826],
    ['/calculator', 'button', 'Next', null, 470, 215, 468, 2, 0, 18826],
    ['/calculator', 'label', 'Female', null, 402, 185, 401, 1, 0, 18826],
    ['/calculator', 'label', 'Male', null, 290, 134, 290, 0, 0, 18826],
    ['/calculator', 'button', 'Calculate My Plan', null, 262, 120, 261, 1, 0, 18826],
  ],
  'web-vitals': [
    ['/calculator', 'Desktop', 'Chrome OS', 3844, 744, 0.051, 1802, 22298],
    ['/calculator', 'Desktop', 'Windows', 2146, 224, 0.02, 1211, 12500],
    ['/calculator', 'Desktop', 'Mac OS X', 1655, 136, 0.012, 903, 11139],
    ['/calculator', 'Mobile', 'iOS', 1709, 144, 0.031, 1004, 30112],
    ['/', 'Desktop', 'Windows', 3256, 190, null, 1500, 9001],
    ['/', 'Mobile', 'Android', 1645, 120, 0.01, 900, 8800],
  ],
  funnels: [[18826, 15864, 15394]],
};

const FIXTURE_COLUMNS: Record<string, string[]> = {
  'web-daily': ['date', 'pageviews', 'people', 'sessions'],
  events: ['event', 'count', 'people', 'first_seen', 'last_seen'],
  exceptions: ['exception_type', 'exception_message', 'occurrences', 'people', 'sessions', 'max_per_session', 'has_source_file', 'top_path', 'top_browser'],
  rageclicks: ['path', 'tag', 'text', 'attr', 'clicks', 'people', 'desktop_clicks', 'mobile_clicks', 'tablet_clicks', 'page_people'],
  'web-vitals': ['path', 'device', 'os', 'lcp_p75', 'inp_p75', 'cls_p75', 'fcp_p75', 'measurements'],
  funnels: ['funnel_1_step_1', 'funnel_1_step_2', 'funnel_1_step_3'],
};

function posthogBody(family: string, rows: unknown[][] = FIXTURE_ROWS[family]!) {
  return {
    results: rows,
    columns: FIXTURE_COLUMNS[family],
    types: [],
    hasMore: false,
    is_cached: false,
    timings: [],
  };
}

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  family: string | null;
  query: string | null;
}

type Responder = (call: Call) => Response;

function familyOf(name: unknown): string | null {
  return typeof name === 'string' && name.startsWith('noticeos:posthog-') ? name.slice('noticeos:posthog-'.length) : null;
}

const answerAll: Responder = (call) =>
  call.method === 'GET'
    ? Response.json({ id: 424242, name: 'Meadow Board', timezone: 'America/New_York' })
    : Response.json(posthogBody(call.family!), {
        headers: { 'x-posthog-query-budget-remaining-bytes': '9000000000', 'x-posthog-query-bytes-read': '1000' },
      });

function posthogFetch(responder: Responder = answerAll): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { name?: string; query?: { query?: string } }) : null;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      family: familyOf(body?.name),
      query: body?.query?.query ?? null,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function archivedBody(objectKey: string): Promise<{ envelope: Record<string, unknown>; text: string }> {
  const object = await env.RAW_SIGNALS.get(objectKey);
  const text = await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return { envelope: JSON.parse(text) as Record<string, unknown>, text };
}

type ManifestRow = {
  report: string;
  status: string;
  reportDate: string;
  providerRows: number;
  providerTruncated: number;
  credentialRef: string;
  propertyRef: string;
  dataState: string;
  objectKey: string | null;
  errorCode: string | null;
};

/** The PostHog report runs, in the order they were written. */
async function manifests(): Promise<ManifestRow[]> {
  return pgRows<ManifestRow>(
    `SELECT report, status, report_date AS "reportDate", provider_rows AS "providerRows",
            provider_truncated AS "providerTruncated", credential_ref AS "credentialRef",
            property_ref AS "propertyRef", data_state AS "dataState", object_key AS "objectKey",
            error_code AS "errorCode"
       FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog' ORDER BY run_seq`,
  );
}

beforeEach(reset);

describe('PostHog product analytics archive', () => {
  it('archives all six families for meadow.example with the contract body', async () => {
    const { fetchImpl, calls } = posthogFetch();
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });

    expect(result).toMatchObject({ attempted: 6, succeeded: 6, failed: 0, budgetStopped: false, budgetRemainingBytes: 9000000000, bytesRead: 6000 });
    // One project read, then the six families strictly one after another.
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${ORIGIN}/api/projects/424242/`,
      ...Array.from({ length: 6 }, () => `POST ${ORIGIN}/api/projects/424242/query/`),
    ]);
    expect(calls.map((call) => call.family)).toEqual([null, 'web-daily', 'events', 'exceptions', 'rageclicks', 'web-vitals', 'funnels']);
    expect(calls.every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);

    const rows = await manifests();
    expect(rows.map((row) => [row.report, row.status, row.reportDate])).toEqual([
      ['web-daily', 'success', '2026-09-22'],
      ['events', 'success', '2026-09-22'],
      ['exceptions', 'success', '2026-09-22'],
      ['rageclicks', 'success', '2026-09-22'],
      ['web-vitals', 'success', '2026-09-22'],
      ['funnels', 'success', '2026-09-22'],
    ]);
    const workspaceId = await env.STORE.workspaceId();
    for (const row of rows) {
      expect(row).toMatchObject({ credentialRef: 'POSTHOG_KEYS', propertyRef: 'us:424242', dataState: 'provider-snapshot', providerTruncated: 0 });
      expect(row.objectKey).toMatch(new RegExp(`^workspaces/${workspaceId}/raw/posthog/posthog/meadow\\.example/${row.report}/2026-09-22/`));
    }

    // Each archive is the standard envelope with ONE page whose response is the
    // contract body, and never carries the key.
    const bodies = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const { envelope, text } = await archivedBody(row.objectKey!);
      expect(text).not.toContain(KEY);
      expect(envelope).toMatchObject({ schemaVersion: 1, provider: 'posthog', integration: 'posthog', report: row.report, asset: 'meadow.example', reportDate: '2026-09-22' });
      const pages = envelope.pages as { request: Record<string, unknown>; response: Record<string, unknown> }[];
      expect(pages).toHaveLength(1);
      expect(posthogArchiveBodySchema.safeParse(pages[0]!.response).success).toBe(true);
      expect((pages[0]!.request.query as { query: string }).query).toMatch(/LIMIT \d+$/);
      bodies.set(row.report, pages[0]!.response);
    }

    // Windows are project-local and trailing, ending on the last complete day.
    expect(bodies.get('web-daily')).toMatchObject({ window: { start: '2026-08-26', end: '2026-09-22' }, rowLimit: 28, projectTimeZone: 'America/New_York', collectedAt: '2026-09-23T12:30:00.000Z', truncated: false });
    expect(bodies.get('events')).toMatchObject({ window: { start: '2026-09-09', end: '2026-09-22' }, rowLimit: 500 });
    expect(bodies.get('web-vitals')).toMatchObject({ rowLimit: 300 });
    expect(bodies.get('funnels')).toMatchObject({ window: { start: '2026-09-16', end: '2026-09-22' }, rowLimit: 3 });

    // The acceptance readings survive parsing verbatim.
    expect((bodies.get('events')!.rows as unknown[])).toContainEqual({ event: 'first_meal_logged', count: 1597, people: 527, firstSeen: '2026-09-08', lastSeen: '2026-09-22' });
    expect((bodies.get('exceptions')!.rows as unknown[])[0]).toEqual({
      type: 'TypeError', message: 'Load failed', count: 40975, people: 1314, sessions: 2210, maxPerSession: 402,
      hasSourceFile: false, topPath: '/calculator', topBrowser: 'Mobile Safari',
    });
    expect((bodies.get('rageclicks')!.rows as { attr: string | null; people: number }[]).filter((row) => row.attr !== null).map((row) => [row.attr, row.people])).toEqual([
      ['heightFeet', 1493], ['heightInches', 1041], ['age', 987], ['weight', 757],
    ]);
    expect((bodies.get('rageclicks')!.rows as { text: string | null }[]).map((row) => row.text).filter(Boolean)).toEqual(['Next', 'Female', 'Male', 'Calculate My Plan']);
    expect((bodies.get('web-vitals')!.rows as unknown[])[0]).toEqual({ path: '/calculator', device: 'Desktop', os: 'Chrome OS', lcpP75: 3844, inpP75: 744, clsP75: 0.051, fcpP75: 1802, measurements: 22298 });
    expect((bodies.get('web-vitals')!.rows as { clsP75: number | null }[])[4]!.clsP75).toBeNull();
    expect(bodies.get('funnels')!.rows).toEqual([
      { funnelId: 'calculator', name: 'Calculator', step: 1, event: '$pageview', path: '/calculator', people: 18826 },
      { funnelId: 'calculator', name: 'Calculator', step: 2, event: 'form_start', path: null, people: 15864 },
      { funnelId: 'calculator', name: 'Calculator', step: 3, event: 'calculation_complete', path: null, people: 15394 },
    ]);
  });

  it('reproduces a fixed window for every family on an explicit scope', async () => {
    const { fetchImpl, calls } = posthogFetch();
    const result = await runPosthogDumps(env, {
      nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register(),
      scope: { asset: 'meadow.example', window: { start: '2026-09-08', end: '2026-09-22' } },
    });
    expect(result).toMatchObject({ attempted: 6, succeeded: 6 });
    for (const call of calls.filter((c) => c.method === 'POST')) {
      expect(call.query).toContain("timestamp >= toDateTime('2026-09-08 00:00:00')");
      expect(call.query).toContain("timestamp < toDateTime('2026-09-23 00:00:00')");
    }
    // Fifteen days, in seconds, is the ordered-conversion window.
    expect(calls.find((c) => c.family === 'funnels')!.query).toContain('windowFunnel(1296000)');
  });

  it('answers unchanged for a settled window re-run, writing no second object', async () => {
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl: posthogFetch().fetchImpl, rawKeys: KEYS, laneRegister: register() });
    const before = (await env.RAW_SIGNALS.list()).objects.length;
    // A later collectedAt must not change the content hash.
    const again = await runPosthogDumps(env, { nowMs: NOW + 3_600_000, fetchImpl: posthogFetch().fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(again).toMatchObject({ attempted: 6, succeeded: 0, unchanged: 6 });
    expect((await env.RAW_SIGNALS.list()).objects.length).toBe(before);
    expect((await manifests()).filter((row) => row.status === 'unchanged')).toHaveLength(6);
  });

  it('keeps the contract bound and marks the archive truncated when PostHog had more', async () => {
    const many = Array.from({ length: 501 }, (_, i) => [`event_${String(i).padStart(3, '0')}`, 1000 - i, 1, '2026-09-10', '2026-09-20']);
    const { fetchImpl, calls } = posthogFetch((call) =>
      call.family === 'events' ? Response.json(posthogBody('events', many)) : answerAll(call),
    );
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    // Asked for one more than the bound, so "exactly the bound" and "more" differ.
    expect(calls.find((c) => c.family === 'events')!.query).toMatch(/LIMIT 501$/);
    const events = (await manifests()).find((row) => row.report === 'events')!;
    expect(events).toMatchObject({ status: 'success', providerRows: 500, providerTruncated: 1 });
    const { envelope } = await archivedBody(events.objectKey!);
    const body = (envelope.pages as { response: { rows: unknown[]; truncated: boolean } }[])[0]!.response;
    expect(body.rows).toHaveLength(500);
    expect(body.truncated).toBe(true);
  });

  it('stops the whole run on a 429 budget refusal and records which families were skipped', async () => {
    const { fetchImpl, calls } = posthogFetch((call) =>
      call.family === 'exceptions'
        ? Response.json(
            { type: 'throttled_error', code: 'api_queries_budget_exceeded', detail: 'Query budget exceeded.' },
            { status: 429, headers: { 'retry-after': '1800', 'x-posthog-query-budget-remaining-bytes': '0' } },
          )
        : answerAll(call),
    );
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(result).toMatchObject({ attempted: 3, succeeded: 2, failed: 1, budgetStopped: true, budgetRemainingBytes: 0 });
    // Nothing is asked after the refusal.
    expect(calls.map((call) => call.family)).toEqual([null, 'web-daily', 'events', 'exceptions']);
    expect((await manifests()).map((row) => [row.report, row.status, row.errorCode])).toEqual([
      ['web-daily', 'success', null],
      ['events', 'success', null],
      ['exceptions', 'error', 'posthog_query_budget_exceeded'],
    ]);
    expect(result.skipped.filter((skip) => skip.family !== null).map((skip) => [skip.family, skip.reason])).toEqual([
      ['rageclicks', 'budget-exhausted'],
      ['web-vitals', 'budget-exhausted'],
      ['funnels', 'budget-exhausted'],
    ]);
  });

  it('names a request-rate 429 apart from the budget', async () => {
    const { fetchImpl } = posthogFetch((call) =>
      call.family === 'web-daily'
        ? Response.json({ type: 'throttled_error', code: 'throttled', detail: 'Request was throttled.' }, { status: 429 })
        : answerAll(call),
    );
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(result).toMatchObject({ attempted: 1, failed: 1, budgetStopped: true });
    expect((await manifests())[0]!.errorCode).toBe('posthog_rate_limit');
    expect(new Set(result.skipped.filter((s) => s.family !== null).map((s) => s.reason))).toEqual(new Set(['rate-limited']));
  });

  it('stops before asking again when PostHog reports no budget left', async () => {
    const { fetchImpl, calls } = posthogFetch((call) =>
      call.method === 'POST'
        ? Response.json(posthogBody(call.family!), { headers: { 'x-posthog-query-budget-remaining-bytes': '0' } })
        : answerAll(call),
    );
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, budgetStopped: true });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('skips an asset with no key, or a key and no project, without a call or a manifest row', async () => {
    const { fetchImpl, calls } = posthogFetch();
    const none = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: '', laneRegister: { assets: {} } });
    expect(none).toMatchObject({ attempted: 0 });
    expect(none.skipped.find((s) => s.asset === 'meadow.example')?.reason).toBe('not-configured');

    const mappedNoKey = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: '', laneRegister: register() });
    expect(mappedNoKey.skipped.find((s) => s.asset === 'meadow.example')?.reason).toBe('no-key');

    const keyNoMapping = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register({ host: 'us' }) });
    expect(keyNoMapping.skipped.find((s) => s.asset === 'meadow.example')).toMatchObject({ reason: 'mapping-missing', detail: expect.stringContaining('projectId') });

    const badHost = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register({ host: 'apac', projectId: '424242' }) });
    expect(badHost.skipped.find((s) => s.asset === 'meadow.example')?.reason).toBe('mapping-invalid');

    expect(calls).toHaveLength(0);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog'`)).toBe(0);
  });

  it('skips the funnels family with a reason when none are declared', async () => {
    const { fetchImpl, calls } = posthogFetch();
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register({ host: 'us', projectId: '424242' }) });
    expect(result).toMatchObject({ attempted: 5, succeeded: 5 });
    expect(calls.some((call) => call.family === 'funnels')).toBe(false);
    expect(result.skipped).toContainEqual(expect.objectContaining({ asset: 'meadow.example', family: 'funnels', reason: 'no-funnels' }));
  });

  it('degrades a revoked key to failed-access attempts, never a crash', async () => {
    const { fetchImpl, calls } = posthogFetch((call) =>
      Response.json({ type: 'authentication_error', code: 'authentication_failed', detail: 'Personal API key found in request Authorization header is invalid.' }, { status: 401 }),
    );
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(result).toMatchObject({ attempted: 6, failed: 6, budgetStopped: false });
    // One project read, no query: the key's refusal is today's answer for all six.
    expect(calls).toHaveLength(1);
    const rows = await manifests();
    expect(new Set(rows.map((row) => row.errorCode))).toEqual(new Set(['posthog_access_denied']));
    const message = await pgFirst<{ m: string }>(`SELECT error_message AS m FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog' LIMIT 1`);
    expect(message?.m).not.toContain(KEY);
    // One short line a site's Data sources row draws.
    const stored = await pgAll<{ m: string }>(`SELECT DISTINCT error_message AS m FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog'`);
    expect(stored.results.map((row) => row.m)).toEqual([
      'PostHog refused the key · HTTP 401 · Personal API key found in request Authorization header is invalid.',
    ]);
    // The health classifier files it under access.
    const state = (await storedHealthStates()).find((row) => row.provider === 'posthog');
    if (state !== undefined) expect(state.failure_kind).toBe('access');
  });

  it('stops asking once a query is refused with 403, and records the rest as the same failure', async () => {
    const { fetchImpl, calls } = posthogFetch((call) =>
      call.family === 'events' ? Response.json({ type: 'authentication_error', detail: 'API key missing required scope query:read' }, { status: 403 }) : answerAll(call),
    );
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(calls.map((call) => call.family)).toEqual([null, 'web-daily', 'events']);
    expect(result).toMatchObject({ attempted: 6, succeeded: 1, failed: 5 });
    expect((await manifests()).slice(1).every((row) => row.errorCode === 'posthog_access_denied')).toBe(true);
  });

  it('names a project PostHog does not have as a mapping problem', async () => {
    const { fetchImpl } = posthogFetch((call) => (call.method === 'GET' ? Response.json({ detail: 'Not found.' }, { status: 404 }) : answerAll(call)));
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(new Set((await manifests()).map((row) => row.errorCode))).toEqual(new Set(['posthog_mapping_project_not_found']));
  });

  it('refuses an answer whose columns are not the ones the query named', async () => {
    const { fetchImpl } = posthogFetch((call) =>
      call.family === 'web-daily' ? Response.json({ results: [[1, 2]], columns: ['a', 'b'] }) : answerAll(call),
    );
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect((await manifests())[0]).toMatchObject({ report: 'web-daily', status: 'error', errorCode: 'posthog_invalid_response' });
  });

  it('runs on the key entered in the product and leaves its verdict on the card', async () => {
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_KEYS: KEYS } });
    const { fetchImpl, calls } = posthogFetch();
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, laneRegister: register() });
    expect(result).toMatchObject({ attempted: 6, succeeded: 6 });
    expect(calls[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect((await manifests())[0]!.credentialRef).toBe('store:POSTHOG_KEYS');
    const stamped = await credentialVerdict('posthog');
    expect(stamped).toEqual({ lastOkAt: new Date(NOW).toISOString(), lastError: null });
  });

  it('leaves a refused key on the card as one short line, in the words the site row uses', async () => {
    // What went wrong, then the count — never a list of every site and report.
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_KEYS: KEYS } });
    const { fetchImpl } = posthogFetch(() =>
      Response.json({ type: 'authentication_error', detail: 'Personal API key found in request Authorization header is invalid.' }, { status: 401 }),
    );
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl, laneRegister: register() });
    const stamped = await credentialVerdict('posthog');
    expect(stamped?.lastError).toBe('Access was refused · 6 of 6 reports');
  });
});

// ---------------------------------------------------------------------------
// One run per asset at a time. The lease clock is pinned to NOW so every expiry
// below is exact.
// ---------------------------------------------------------------------------

const clock = () => NOW;

/** The asset's lease as the store holds it, its end in epoch milliseconds. */
async function leaseRow(asset = 'meadow.example'): Promise<{ owner: string; expiresAt: number } | null> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ owner: string; expires_at: string }>('SELECT owner, expires_at FROM noticeos.integration_leases WHERE lease_key = $1', [
      posthogLeaseKey(asset),
    ]),
  );
  return row === undefined ? null : { owner: row.owner, expiresAt: Date.parse(javascriptInstant(row.expires_at)) };
}

async function holdLease(asset: string, owner: string, expiresAt: number): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      'INSERT INTO noticeos.integration_leases (workspace_id, lease_key, owner, expires_at) VALUES ($1::uuid, $2, $3, $4::timestamptz)',
      [tx.workspaceId, posthogLeaseKey(asset), owner, new Date(expiresAt)],
    ),
  );
}

/** A PostHog that answers nothing until `open()`; `started` resolves on the
 * first request, i.e. once the run holds its lease. */
function gatedPosthogFetch(responder: Responder = answerAll) {
  const inner = posthogFetch(responder);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    reached();
    await gate;
    return inner.fetchImpl(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls: inner.calls, started, open };
}

describe('PostHog — one run per asset at a time', () => {
  it('bounds the lease well past the longest run and short of a missed day', () => {
    // The longest run on one asset: the project read, six queries and the
    // windows an outage cost it, each cut off at the request timeout, one after
    // another.
    expect(POSTHOG_RETRY_LIMIT).toBe(POSTHOG_FAMILIES.length);
    const longestRunMs = (1 + POSTHOG_FAMILIES.length + POSTHOG_RETRY_LIMIT) * POSTHOG_REQUEST_TIMEOUT_MS;
    expect(POSTHOG_LEASE_MS).toBeGreaterThanOrEqual(4 * longestRunMs);
    expect(POSTHOG_LEASE_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  it('holds the asset while it runs and releases it when it succeeds', async () => {
    const posthog = gatedPosthogFetch();
    const run = runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl: posthog.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    await posthog.started;
    const held = await leaseRow();
    expect(held?.expiresAt).toBe(NOW + POSTHOG_LEASE_MS);
    expect(held?.owner).toMatch(/^[0-9a-f-]{36}$/);
    posthog.open();
    expect(await run).toMatchObject({ attempted: 6, succeeded: 6 });
    expect(await leaseRow()).toBeNull();
  });

  it('lets exactly one of two runs over the same asset ask PostHog', async () => {
    const first = gatedPosthogFetch();
    const firstRun = runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl: first.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    await first.started;
    const second = posthogFetch();
    const refused = await runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl: second.fetchImpl, rawKeys: KEYS, laneRegister: register(), scope: { asset: 'meadow.example' } });
    expect(refused).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
    expect(second.calls).toHaveLength(0);
    first.open();
    expect(await firstRun).toMatchObject({ attempted: 6, succeeded: 6 });
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog'`)).toBe(6);
  });

  it('skips, with its reason, an asset another run holds, and still collects the others', async () => {
    // An on-demand run took meadow.example ten minutes ago.
    await holdLease('meadow.example', 'on-demand-run', NOW + POSTHOG_LEASE_MS - 600_000);
    const { fetchImpl, calls } = posthogFetch();
    const keys = JSON.stringify({ 'meadow.example': KEY, 'northwind.example': 'phx_nom_key' });
    const both: LaneRegister = {
      assets: {
        'meadow.example': { posthog: { host: 'us', projectId: '424242', funnels: [CALCULATOR] } },
        'northwind.example': { posthog: { host: 'us', projectId: '700001' } },
      },
    };
    // The daily run: no scope, every asset.
    const result = await runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl, rawKeys: keys, laneRegister: both });

    expect(result.skipped.find((skip) => skip.asset === 'meadow.example')).toEqual({
      asset: 'meadow.example',
      family: null,
      reason: 'in-flight',
      detail: 'Already running for meadow.example · started 600s ago · nothing asked · free at 2026-09-23T12:50:00.000Z',
      inFlight: { startedAt: '2026-09-23T12:20:00.000Z', runningSeconds: 600, leaseExpiresAt: '2026-09-23T12:50:00.000Z' },
    });
    // Nothing was asked about meadow.example's project; northwind.example's was read.
    expect(calls.some((call) => call.url.includes('/424242/'))).toBe(false);
    expect(calls.filter((call) => call.url.includes('/700001/'))).toHaveLength(6);
    expect(result).toMatchObject({ attempted: 5, succeeded: 5 });
    expect(new Set((await manifests()).map((row) => row.propertyRef))).toEqual(new Set(['us:700001']));
    // The holder's lease is untouched; northwind.example's was given back.
    expect(await leaseRow()).toEqual({ owner: 'on-demand-run', expiresAt: NOW + POSTHOG_LEASE_MS - 600_000 });
    expect(await leaseRow('northwind.example')).toBeNull();
  });

  it('takes over a lease a crashed run left behind once it has expired', async () => {
    await holdLease('meadow.example', 'crashed-run', NOW);
    const { fetchImpl } = posthogFetch();
    const result = await runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(result).toMatchObject({ attempted: 6, succeeded: 6 });
    expect(result.skipped.some((skip) => skip.reason === 'in-flight')).toBe(false);
    expect(await leaseRow()).toBeNull();

    // One millisecond short of expiry, the same lease still holds.
    await holdLease('meadow.example', 'live-run', NOW + 1);
    expect(await claimPosthogLease(env.STORE, 'meadow.example', NOW)).toMatchObject({ owner: null, heldBy: { leaseExpiresAt: new Date(NOW + 1).toISOString() } });
  });

  it('releases the lease after provider failures and after a 429 budget stop', async () => {
    const denied = posthogFetch(() => Response.json({ detail: 'Invalid key.' }, { status: 401 }));
    expect(await runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl: denied.fetchImpl, rawKeys: KEYS, laneRegister: register() })).toMatchObject({ attempted: 6, failed: 6 });
    expect(await leaseRow()).toBeNull();

    const budget = posthogFetch((call) =>
      call.family === 'events'
        ? Response.json({ type: 'throttled_error', code: 'api_queries_budget_exceeded', detail: 'Query budget exceeded.' }, { status: 429 })
        : answerAll(call),
    );
    expect(await runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl: budget.fetchImpl, rawKeys: KEYS, laneRegister: register() })).toMatchObject({ budgetStopped: true, failed: 1 });
    expect(await leaseRow()).toBeNull();
  });

  it('releases the lease when the run throws, and the error still surfaces', async () => {
    const { fetchImpl } = posthogFetch();
    // The store refusing every report run, so the run THROWS mid-asset; the
    // lease itself still reaches the store.
    const restore = await refuseArchiveRuns();
    try {
      await expect(
        runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl, rawKeys: KEYS, laneRegister: register() }),
      ).rejects.toThrow('the store refused the write');
    } finally {
      await restore();
    }
    expect(await leaseRow()).toBeNull();
  });

  it('never frees a lease a later run has taken over', async () => {
    const posthog = gatedPosthogFetch();
    const run = runPosthogDumps(env, { nowMs: NOW, clock, fetchImpl: posthog.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    await posthog.started;
    // This run outlived its lease and a successor took the asset.
    await env.STORE.write((tx) =>
      tx.execute("UPDATE noticeos.integration_leases SET owner = 'successor' WHERE lease_key = $1", [posthogLeaseKey('meadow.example')]),
    );
    posthog.open();
    await run;
    expect((await leaseRow())?.owner).toBe('successor');
  });
});

// ---------------------------------------------------------------------------
// A store failure while saving a report PostHog answered.
// ---------------------------------------------------------------------------

/** R2 refusing the archive object of one family; everything else is stored. */
function objectPutsFail(bucket: R2Bucket, family: string): R2Bucket {
  return new Proxy(bucket, {
    get(target, prop) {
      if (prop === 'put') {
        return (key: string, ...rest: unknown[]) => {
          if (key.includes(`/${family}/`)) return Promise.reject(new Error('R2 put failed: we encountered an internal error'));
          return (target.put as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('PostHog — a store failure while saving a report', () => {
  // A past day: a Health observation counts once it has finished, and one
  // dated after the test's own clock never would.
  const DAY = Date.parse('2026-09-14T12:30:00.000Z');

  /** The stored Health state of one window of one family. */
  async function healthOf(family: string, end: string) {
    const row = (await storedHealthStates()).find((state) =>
      state.provider === 'posthog' && state.capability === 'posthog-archive' && state.family === JSON.stringify([family, end, '', '']));
    return row === undefined ? null : { outcome: row.outcome, failure: row.failure_kind, code: row.safe_code };
  }

  /** Every query a run sent, as `family window-end`. */
  const askedWindows = (calls: Call[]): string[] =>
    calls
      .filter((call) => call.method === 'POST')
      .map((call) => {
        const match = /timestamp < toDateTime\('(\d{4}-\d{2}-\d{2}) 00:00:00'\)/.exec(call.query ?? '');
        const end = match === null ? null : new Date(Date.parse(`${match[1]}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        return `${call.family} ${end}`;
      });

  it('names a database failure while saving as this machine’s, and never asks PostHog again for it', async () => {
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_KEYS: KEYS } });
    const posthog = posthogFetch();
    // The store refusing every STORED run — the write that ends
    // `archiveCollectedDump` — while failure rows and the lease still land.
    const restore = await refuseArchiveRuns({ stored: true, message: 'disk I/O error' });
    let result: Awaited<ReturnType<typeof runPosthogDumps>>;
    try {
      result = await runPosthogDumps(env, { nowMs: DAY, fetchImpl: posthog.fetchImpl, laneRegister: register() });
    } finally {
      await restore();
    }

    // PostHog answered all six; the store kept none of them.
    expect(posthog.calls.filter((call) => call.method === 'POST')).toHaveLength(6);
    expect(result).toMatchObject({ attempted: 6, succeeded: 0, failed: 6 });
    const rows = await manifests();
    expect(rows.map((row) => [row.report, row.status, row.errorCode])).toEqual(
      POSTHOG_FAMILIES.map((family) => [family, 'error', LOCAL_STORE_FAILED]),
    );
    const message = await pgFirst<{ m: string }>(`SELECT error_message AS m FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog' LIMIT 1`);
    expect(message?.m).toMatch(/^PostHog answered, but this machine could not save the web-daily report: .*disk I\/O error/);
    // Health files it as NoticeOS's own fault, never as PostHog unreachable.
    expect(healthFailure(LOCAL_STORE_FAILED)).toEqual({ failure: 'monitoring', code: 'monitoring' });
    for (const family of POSTHOG_FAMILIES) {
      expect(await healthOf(family, '2026-09-13')).toEqual({ outcome: 'failure', failure: 'monitoring', code: 'monitoring' });
    }
    // A save that failed says nothing about the key.
    expect(
      await credentialVerdict('posthog'),
    ).toEqual({ lastOkAt: null, lastError: null });

    // The next day asks PostHog for its own window only: nothing is owed.
    const next = posthogFetch();
    const after = await runPosthogDumps(env, { nowMs: DAY + 86_400_000, fetchImpl: next.fetchImpl, laneRegister: register() });
    expect(after.retried).toBe(0);
    expect(askedWindows(next.calls)).toEqual(POSTHOG_FAMILIES.map((family) => `${family} 2026-09-14`));
  });

  it('names a file-store failure while saving as this machine’s, shows it as an OS fault, and never asks PostHog again for it', async () => {
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_KEYS: KEYS } });
    // Connected long before this run, so the Health read counts it.
    await setConnection('posthog', { updated_at: '2026-09-01T00:00:00.000Z' });
    const posthog = posthogFetch();
    const result = await runPosthogDumps(
      { ...env, RAW_SIGNALS: objectPutsFail(env.RAW_SIGNALS, 'events') },
      { nowMs: DAY, fetchImpl: posthog.fetchImpl, laneRegister: register() },
    );

    expect(result).toMatchObject({ attempted: 6, succeeded: 5, failed: 1 });
    expect((await manifests()).find((row) => row.report === 'events')).toMatchObject({ status: 'error', errorCode: LOCAL_STORE_FAILED, objectKey: null });
    expect(await healthOf('events', '2026-09-13')).toEqual({ outcome: 'failure', failure: 'monitoring', code: 'monitoring' });
    // The key worked for every report PostHog answered.
    expect(
      await credentialVerdict('posthog'),
    ).toEqual({ lastOkAt: new Date(DAY).toISOString(), lastError: null });

    // The Integrations page reads it as NoticeOS's fault, not PostHog's.
    await emptyTables(['config_documents']);
    forgetConfigCache();
    const files = ['config/integrations.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'];
    const reads = await Promise.all(files.map((file) => getConfigDocument(env, file)));
    await seedConfigDocuments(env, { documents: Object.fromEntries(reads.map((read) => [read.file, read.body])), actor: 'test' });
    try {
      const health = await readIntegrationHealth(env, Date.now() + 1000);
      const events = health.items.find((item) => item.provider === 'posthog' && item.detail === 'events · 2026-09-13');
      expect(events).toMatchObject({ state: 'failing', failure: 'monitoring' });
      expect(integrationFailureMessage(events!)).toBe('NoticeOS could not record or coordinate this operation.');
      expect(health.items.filter((item) => item.provider === 'posthog' && item.failure === 'network')).toEqual([]);
    } finally {
      await emptyTables(['config_documents']);
      forgetConfigCache();
    }

    const next = posthogFetch();
    const after = await runPosthogDumps(env, { nowMs: DAY + 86_400_000, fetchImpl: next.fetchImpl, laneRegister: register() });
    expect(after.retried).toBe(0);
    expect(askedWindows(next.calls)).not.toContain('events 2026-09-13');
  });
});

// ---------------------------------------------------------------------------
// An offline night, and the windows it cost. NOW's run owns the window ending
// 2026-09-22; the next day's run owns the one ending 09-23.
// ---------------------------------------------------------------------------

describe('PostHog — an offline night and the windows it cost', () => {
  const NEXT_DAY = NOW + 86_400_000;
  const FAMILIES = [...POSTHOG_FAMILIES];

  /** The window end a query asked for, read off its upper time bound. */
  function askedEnd(call: Call): string | null {
    const match = /timestamp < toDateTime\('(\d{4}-\d{2}-\d{2}) 00:00:00'\)/.exec(call.query ?? '');
    return match === null ? null : new Date(Date.parse(`${match[1]}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  }
  /** Every query a run sent, as `family window-end`, in order. */
  const asked = (calls: Call[]): string[] =>
    calls.filter((call) => call.method === 'POST').map((call) => `${call.family} ${askedEnd(call)}`);

  /** PostHog AND the reference sites answering — the run after an outage,
   * which asks the beacons once to settle the flag. */
  const reachable = (fetchImpl: typeof fetch): typeof fetch => cutUplink(fetchImpl, { beaconUp: true, through: () => true });

  /** What the open os-egress-down flag says PostHog is still owed. */
  async function owedOnFlag(): Promise<Record<string, string[]> | undefined> {
    const [row] = await pgRows<{ inputs: string }>(
      `SELECT rule_inputs::text AS inputs FROM noticeos.current_flags WHERE rule_id = $1 AND resolved_at IS NULL`,
      [EGRESS_DOWN_RULE_ID],
    );
    const lanes = row === undefined ? undefined : (JSON.parse(row.inputs) as { lanes?: Record<string, { parts?: Record<string, string[]> }> }).lanes;
    return lanes?.posthog?.parts;
  }

  /** One manifest row, written the way the collector writes a failure. */
  async function failedWindow(
    report: string,
    reportDate: string,
    code: string,
    requestedAt = '2026-09-21T12:30:00.000Z',
    propertyRef = 'us:424242',
  ): Promise<void> {
    await storeArchiveRun({
      id: crypto.randomUUID(), asset: 'meadow.example', integration: 'posthog', report, credential_ref: 'POSTHOG_KEYS',
      property_ref: propertyRef, report_date: reportDate, finished_at: requestedAt, status: 'error',
      error_code: code, error_message: 'fixture',
    });
  }

  /** The newest attempt at one window end. */
  async function latest(report: string, reportDate: string) {
    return pgFirst<{ status: string; errorCode: string | null }>(`SELECT status, error_code AS "errorCode" FROM ${ARCHIVE_RUNS}
        WHERE integration = 'posthog' AND report = $1 AND report_date = $2
        ORDER BY requested_at DESC, finished_at DESC, run_seq DESC LIMIT 1`, [report, reportDate]);
  }

  it('writes no PostHog row for a dead night — one OS fact instead', async () => {
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_KEYS: KEYS } });
    const posthog = posthogFetch();
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl: cutUplink(posthog.fetchImpl), laneRegister: register() });

    expect(result).toMatchObject({ attempted: 6, succeeded: 0, failed: 6, retried: 0 });
    for (const outcome of result.outcomes) expect(outcome).toMatchObject({ egressDown: true, errorCode: EGRESS_DOWN_CODE });
    expect(posthog.calls).toHaveLength(0);
    // No manifest, no Health observation, no credential verdict: nothing that
    // reads as PostHog's failure.
    expect(await manifests()).toEqual([]);
    expect((await storedHealthStates()).filter((row) => row.provider === 'posthog')).toEqual([]);
    expect(
      await credentialVerdict('posthog'),
    ).toEqual({ lastOkAt: null, lastError: null });
    // One flag, whose PostHog entry names every window down to its end, so the
    // offline alert counts it and stays open until a run asks for them.
    expect(result.egress).toMatchObject({ up: false, fired: 1, unmeasuredAssets: ['meadow.example'] });
    expect(await openEgressFlags()).toBe(1);
    expect(await owedOnFlag()).toEqual({ 'meadow.example': FAMILIES.map((family) => `posthog:${family}:2026-09-22`) });
  });

  it('asks nothing more of PostHog when the uplink dies after the project read', async () => {
    const posthog = posthogFetch();
    const sent: string[] = [];
    const dying = cutUplink(posthog.fetchImpl, { through: (url) => url === `${ORIGIN}/api/projects/424242/` });
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(input instanceof Request ? input.url : input));
      return dying(input, init);
    }) as typeof fetch;
    const result = await runPosthogDumps(env, { nowMs: NOW, fetchImpl, rawKeys: KEYS, laneRegister: register() });

    expect(result).toMatchObject({ attempted: 6, failed: 6 });
    expect(result.outcomes.every((outcome) => outcome.egressDown === true)).toBe(true);
    // The first query met the wall; the other five were never sent into it.
    expect(sent.filter((url) => url.endsWith('/query/'))).toHaveLength(1);
    expect(await manifests()).toEqual([]);
    expect(await openEgressFlags()).toBe(1);
  });

  it('asks the dark night’s windows again once the connection is back, and closes the alert', async () => {
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl: cutUplink(posthogFetch().fetchImpl), rawKeys: KEYS, laneRegister: register() });

    const posthog = posthogFetch();
    const back = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: reachable(posthog.fetchImpl), rawKeys: KEYS, laneRegister: register() });

    expect(back).toMatchObject({ attempted: 12, succeeded: 12, failed: 0, retried: 6 });
    // Per family, the window the dark night owed and then today's.
    expect(asked(posthog.calls)).toEqual(FAMILIES.flatMap((family) => [`${family} 2026-09-22`, `${family} 2026-09-23`]));
    // The exact window that night's own run would have asked.
    expect(posthog.calls.find((call) => call.family === 'web-daily')!.query).toContain("timestamp >= toDateTime('2026-08-26 00:00:00')");
    // Each family's newest row is still today's window, which is what the
    // Tower reads as its current one.
    const rows = await manifests();
    for (const family of FAMILIES) expect(rows.filter((row) => row.report === family).at(-1)!.reportDate).toBe('2026-09-23');
    expect(rows.every((row) => row.status === 'success')).toBe(true);
    expect(back.egress).toMatchObject({ up: true, resolved: 1 });
    expect(await openEgressFlags()).toBe(0);

    // A gap once filled is not asked for again.
    const next = await runPosthogDumps(env, { nowMs: NEXT_DAY + 86_400_000, fetchImpl: posthogFetch().fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(next.retried).toBe(0);
  });

  it('asks again a window PostHog never answered, once one it answered “not now”, never a refused key', async () => {
    // A night PostHog could not be reached while the OS could reach the world:
    // PostHog's network failure, recorded as before.
    const dropped = await runPosthogDumps(env, {
      nowMs: NOW, fetchImpl: cutUplink(posthogFetch().fetchImpl, { beaconUp: true }), rawKeys: KEYS, laneRegister: register(),
    });
    expect(new Set(dropped.outcomes.map((outcome) => outcome.errorCode))).toEqual(new Set(['posthog_request_failed']));
    expect(dropped.egress.fired).toBe(0);
    await failedWindow('web-vitals', '2026-09-21', 'posthog_timeout');
    // A refused key is PostHog's verdict on the key: never asked again daily.
    await failedWindow('events', '2026-09-20', 'posthog_access_denied');
    // "Not now": a malformed answer, an error page — and an error page that
    // replaced a network failure. Each is asked once more.
    await failedWindow('events', '2026-09-19', 'posthog_invalid_response');
    await failedWindow('events', '2026-09-18', 'posthog_http_500');
    await failedWindow('events', '2026-09-17', 'posthog_request_failed', '2026-09-17T12:30:00.000Z');
    await failedWindow('events', '2026-09-17', 'posthog_http_503', '2026-09-18T12:30:00.000Z');
    // A network failure on a project the asset no longer reads.
    await failedWindow('events', '2026-09-16', 'posthog_request_failed', '2026-09-17T12:30:00.000Z', 'us:111111');
    // The same "not now" twice for one window is PostHog's settled answer.
    await failedWindow('events', '2026-09-15', 'posthog_http_502', '2026-09-16T12:30:00.000Z');
    await failedWindow('events', '2026-09-15', 'posthog_http_503', '2026-09-17T12:30:00.000Z');
    await failedWindow('events', '2026-09-14', 'posthog_invalid_response', '2026-09-15T12:30:00.000Z');
    await failedWindow('events', '2026-09-14', 'posthog_invalid_response', '2026-09-16T12:30:00.000Z');
    // PostHog answered; this machine failed to keep it.
    await failedWindow('exceptions', '2026-09-20', LOCAL_STORE_FAILED);

    const posthog = posthogFetch();
    const next = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: posthog.fetchImpl, rawKeys: KEYS, laneRegister: register(), retryLimit: 20 });

    expect(next.retried).toBe(10);
    expect(asked(posthog.calls).filter((ask) => !ask.endsWith('2026-09-23'))).toEqual([
      'web-daily 2026-09-22',
      'events 2026-09-17',
      'events 2026-09-18',
      'events 2026-09-19',
      'events 2026-09-22',
      'exceptions 2026-09-22',
      'rageclicks 2026-09-22',
      'web-vitals 2026-09-21',
      'web-vitals 2026-09-22',
      'funnels 2026-09-22',
    ]);
    for (const family of FAMILIES) expect(await latest(family, '2026-09-22')).toMatchObject({ status: 'success' });
    expect(await latest('web-vitals', '2026-09-21')).toMatchObject({ status: 'success' });
    for (const end of ['2026-09-17', '2026-09-18', '2026-09-19']) expect(await latest('events', end)).toMatchObject({ status: 'success' });
    expect(await latest('events', '2026-09-20')).toMatchObject({ errorCode: 'posthog_access_denied' });
    expect(await latest('events', '2026-09-15')).toMatchObject({ errorCode: 'posthog_http_503' });
    expect(await latest('events', '2026-09-14')).toMatchObject({ errorCode: 'posthog_invalid_response' });
    expect(await latest('exceptions', '2026-09-20')).toMatchObject({ errorCode: LOCAL_STORE_FAILED });
  });

  it('asks no more than its bound per run — oldest first, the rest on the next runs', async () => {
    for (const date of ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']) {
      await failedWindow('events', date, 'posthog_request_failed');
    }
    const seen: string[][] = [];
    for (let day = 1; day <= 4; day += 1) {
      const posthog = posthogFetch();
      const result = await runPosthogDumps(env, {
        nowMs: NOW + day * 86_400_000, fetchImpl: posthog.fetchImpl, rawKeys: KEYS, laneRegister: register(), retryLimit: 2,
      });
      seen.push(asked(posthog.calls).filter((ask) => ask < 'events 2026-09-20' && ask.startsWith('events ')).map((ask) => ask.slice(7)));
      expect(result.retried).toBe(seen.at(-1)!.length);
    }
    expect(seen).toEqual([['2026-09-15', '2026-09-16'], ['2026-09-17', '2026-09-18'], ['2026-09-19'], []]);
  });

  it('asks nothing again while the uplink is down, and stops after one ask PostHog still drops', async () => {
    await failedWindow('events', '2026-09-20', 'posthog_request_failed');
    await failedWindow('events', '2026-09-21', 'posthog_request_failed');
    const priorRows = await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog'`);

    const dark = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: cutUplink(posthogFetch().fetchImpl), rawKeys: KEYS, laneRegister: register() });
    expect(dark.retried).toBe(0);
    expect(dark.outcomes.every((outcome) => outcome.egressDown === true)).toBe(true);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog'`)).toBe(priorRows);

    // The world answers; PostHog reads the project, then drops every query.
    const flaky = await runPosthogDumps(env, {
      nowMs: NEXT_DAY,
      fetchImpl: cutUplink(posthogFetch().fetchImpl, { beaconUp: true, through: (url) => !url.endsWith('/query/') }),
      rawKeys: KEYS,
      laneRegister: register(),
    });
    expect(flaky.retried).toBe(1);
    expect(await latest('events', '2026-09-20')).toMatchObject({ status: 'error', errorCode: 'posthog_request_failed' });
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE report = 'events' AND report_date = '2026-09-21'`)).toBe(1);

    // Both are still owed, and the first healthy run fills them.
    const back = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: reachable(posthogFetch().fetchImpl), rawKeys: KEYS, laneRegister: register() });
    expect(back.retried).toBe(2);
    expect(await latest('events', '2026-09-20')).toMatchObject({ status: 'success' });
    expect(await latest('events', '2026-09-21')).toMatchObject({ status: 'success' });
  });

  it('still stops the whole run on a 429 met during a re-collection', async () => {
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl: cutUplink(posthogFetch().fetchImpl), rawKeys: KEYS, laneRegister: register() });

    const posthog = posthogFetch((call) =>
      call.family === 'events'
        ? Response.json({ type: 'throttled_error', code: 'api_queries_budget_exceeded', detail: 'Query budget exceeded.' }, { status: 429 })
        : answerAll(call),
    );
    const result = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: reachable(posthog.fetchImpl), rawKeys: KEYS, laneRegister: register() });

    expect(result).toMatchObject({ attempted: 3, succeeded: 2, failed: 1, retried: 2, budgetStopped: true });
    // Nothing is asked after the refusal: no owed window, and none of today's.
    expect(asked(posthog.calls)).toEqual(['web-daily 2026-09-22', 'web-daily 2026-09-23', 'events 2026-09-22']);
    expect(result.skipped.filter((skip) => skip.family !== null).map((skip) => [skip.family, skip.reason])).toEqual([
      ['events', 'budget-exhausted'],
      ['exceptions', 'budget-exhausted'],
      ['rageclicks', 'budget-exhausted'],
      ['web-vitals', 'budget-exhausted'],
      ['funnels', 'budget-exhausted'],
    ]);
    // The four the stop never reached stay owed on the alert, which stays open
    // for them.
    expect(await latest('events', '2026-09-22')).toMatchObject({ errorCode: 'posthog_query_budget_exceeded' });
    expect(await owedOnFlag()).toEqual({
      'meadow.example': ['exceptions', 'rageclicks', 'web-vitals', 'funnels'].map((family) => `posthog:${family}:2026-09-22`),
    });

    // The next day: the four the alert names, the refused window once more,
    // and the windows of 09-23 the stop never asked — oldest first, six at most.
    const again = posthogFetch();
    const next = await runPosthogDumps(env, { nowMs: NEXT_DAY + 86_400_000, fetchImpl: reachable(again.fetchImpl), rawKeys: KEYS, laneRegister: register() });
    expect(next.retried).toBe(6);
    // Named window by window, with the four left for the next run.
    expect(next.recollected.map((outcome) => `${outcome.report} ${outcome.reportDate}`)).toEqual([
      'events 2026-09-22',
      'events 2026-09-23',
      ...['exceptions', 'rageclicks', 'web-vitals', 'funnels'].map((family) => `${family} 2026-09-22`),
    ]);
    expect(next.retryNotAsked).toBe(4);
    expect(asked(again.calls)).toEqual([
      'web-daily 2026-09-24',
      'events 2026-09-22',
      'events 2026-09-23',
      'events 2026-09-24',
      ...['exceptions', 'rageclicks', 'web-vitals', 'funnels'].flatMap((family) => [`${family} 2026-09-22`, `${family} 2026-09-24`]),
    ]);
    expect(await openEgressFlags()).toBe(0);

    // And the day after, the rest of what the stop never asked.
    const last = posthogFetch();
    const after = await runPosthogDumps(env, { nowMs: NEXT_DAY + 2 * 86_400_000, fetchImpl: last.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(after.retried).toBe(4);
    expect(asked(last.calls).filter((ask) => ask.endsWith('2026-09-23'))).toEqual(
      ['exceptions', 'rageclicks', 'web-vitals', 'funnels'].map((family) => `${family} 2026-09-23`),
    );
    for (const family of FAMILIES) {
      expect(await latest(family, '2026-09-22')).toMatchObject({ status: 'success' });
      expect(await latest(family, '2026-09-23')).toMatchObject({ status: 'success' });
    }
  });

  // -------------------------------------------------------------------------
  // A window PostHog answered "not now", and the windows a 429 never reached.
  // -------------------------------------------------------------------------

  /** PostHog answering the named windows (`family`, window end) its own way,
   * and every other request as `answerAll` does. */
  const answering = (...rules: [string, string, () => Response][]): Responder => (call) => {
    const rule = rules.find(([family, end]) => call.family === family && askedEnd(call) === end);
    return rule === undefined ? answerAll(call) : rule[2]();
  };
  const serverError = (status: number) => () => Response.json({ detail: `Server error ${status}.` }, { status });
  const malformed = () => Response.json({ results: [[1, 2]], columns: ['a', 'b'] });
  const budgetSpent = () =>
    Response.json({ type: 'throttled_error', code: 'api_queries_budget_exceeded', detail: 'Query budget exceeded.' }, { status: 429 });

  it('asks a window PostHog failed with a 5xx or a malformed answer once more, and it leaves the Integrations page once answered', async () => {
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_KEYS: KEYS } });
    await setConnection('posthog', { updated_at: '2026-09-01T00:00:00.000Z' });
    await emptyTables(['config_documents']);
    forgetConfigCache();
    const files = ['config/integrations.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'];
    const reads = await Promise.all(files.map((file) => getConfigDocument(env, file)));
    await seedConfigDocuments(env, { documents: Object.fromEntries(reads.map((read) => [read.file, read.body])), actor: 'test' });
    const failing = async () =>
      (await readIntegrationHealth(env, Date.now() + 1000)).items
        .filter((item) => item.provider === 'posthog' && item.state === 'failing')
        .map((item) => [item.detail, item.failure]);
    // Past days, like the Health read's own tests: an attempt is recorded when
    // it finishes, and one dated after the test's clock would not count.
    const DAY = Date.parse('2026-09-14T12:30:00.000Z');
    try {
      const first = posthogFetch(answering(['web-daily', '2026-09-13', serverError(503)], ['events', '2026-09-13', malformed]));
      await runPosthogDumps(env, { nowMs: DAY, fetchImpl: first.fetchImpl, laneRegister: register() });
      expect(await latest('web-daily', '2026-09-13')).toMatchObject({ errorCode: 'posthog_http_503' });
      expect(await latest('events', '2026-09-13')).toMatchObject({ errorCode: 'posthog_invalid_response' });
      expect((await failing()).sort()).toEqual([
        ['events · 2026-09-13', 'invalid-report'],
        ['web-daily · 2026-09-13', 'provider'],
      ]);

      const posthog = posthogFetch();
      const next = await runPosthogDumps(env, { nowMs: DAY + 86_400_000, fetchImpl: posthog.fetchImpl, laneRegister: register() });
      expect(next.retried).toBe(2);
      expect(asked(posthog.calls).filter((ask) => ask.endsWith('2026-09-13'))).toEqual(['web-daily 2026-09-13', 'events 2026-09-13']);
      expect(await latest('web-daily', '2026-09-13')).toMatchObject({ status: 'success' });
      expect(await latest('events', '2026-09-13')).toMatchObject({ status: 'success' });
      // Answered, so nothing about 09-13 is left on the page.
      expect(await failing()).toEqual([]);
    } finally {
      await emptyTables(['config_documents']);
      forgetConfigCache();
    }
  });

  it('asks each such window once: the same answer twice stays, and a refused key is never asked again', async () => {
    const first = posthogFetch(
      answering(
        ['events', '2026-09-22', malformed],
        ['exceptions', '2026-09-22', serverError(500)],
        ['rageclicks', '2026-09-22', () => Response.json({ detail: 'API key missing required scope query:read' }, { status: 403 })],
      ),
    );
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl: first.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    // The 403 is the key's refusal for every window left that day.
    for (const family of ['rageclicks', 'web-vitals', 'funnels']) {
      expect(await latest(family, '2026-09-22')).toMatchObject({ errorCode: 'posthog_access_denied' });
    }

    // The next day PostHog gives the same two answers again.
    const again = posthogFetch(answering(['events', '2026-09-22', malformed], ['exceptions', '2026-09-22', serverError(500)]));
    const next = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: again.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(next.retried).toBe(2);
    expect(asked(again.calls).filter((ask) => ask.endsWith('2026-09-22'))).toEqual(['events 2026-09-22', 'exceptions 2026-09-22']);

    // Settled: neither is asked a third time, and the refused key never was.
    const third = posthogFetch();
    const after = await runPosthogDumps(env, { nowMs: NEXT_DAY + 86_400_000, fetchImpl: third.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(after.retried).toBe(0);
    expect(asked(third.calls)).toEqual(FAMILIES.map((family) => `${family} 2026-09-24`));
    expect(await latest('events', '2026-09-22')).toMatchObject({ errorCode: 'posthog_invalid_response' });
    expect(await latest('exceptions', '2026-09-22')).toMatchObject({ errorCode: 'posthog_http_500' });
    expect(await latest('rageclicks', '2026-09-22')).toMatchObject({ errorCode: 'posthog_access_denied' });
  });

  it('stops asking earlier windows for the day once PostHog’s servers fail one, and keeps the rest owed', async () => {
    const first = posthogFetch(answering(['web-daily', '2026-09-22', serverError(503)], ['events', '2026-09-22', serverError(503)]));
    await runPosthogDumps(env, { nowMs: NOW, fetchImpl: first.fetchImpl, rawKeys: KEYS, laneRegister: register() });

    // PostHog is still failing: the first re-ask meets it, and the next waits.
    const sick = posthogFetch(answering(['web-daily', '2026-09-22', serverError(503)]));
    const next = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: sick.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(next.retried).toBe(1);
    expect(asked(sick.calls).filter((ask) => ask.endsWith('2026-09-22'))).toEqual(['web-daily 2026-09-22']);

    const well = posthogFetch();
    const after = await runPosthogDumps(env, { nowMs: NEXT_DAY + 86_400_000, fetchImpl: well.fetchImpl, rawKeys: KEYS, laneRegister: register() });
    expect(after.retried).toBe(1);
    expect(asked(well.calls).filter((ask) => ask.endsWith('2026-09-22'))).toEqual(['events 2026-09-22']);
    expect(await latest('events', '2026-09-22')).toMatchObject({ status: 'success' });
    expect(await latest('web-daily', '2026-09-22')).toMatchObject({ errorCode: 'posthog_http_503' });
  });

  it('asks the next day every window a 429 stopped the run before asking, on every asset it never reached', async () => {
    const keys = JSON.stringify({ 'meadow.example': KEY, 'northwind.example': 'phx_nom_key' });
    const assets: LaneRegister = {
      assets: {
        'meadow.example': { posthog: { host: 'us', projectId: '424242', funnels: [CALCULATOR] } },
        'northwind.example': { posthog: { host: 'us', projectId: '700001' } },
      },
    };
    const NOM_FAMILIES = FAMILIES.filter((family) => family !== 'funnels');
    const project = (id: string) => (calls: Call[]) => asked(calls.filter((call) => call.url.includes(`/${id}/`)));
    // Both assets were collected the day before.
    await runPosthogDumps(env, { nowMs: NOW - 86_400_000, fetchImpl: posthogFetch().fetchImpl, rawKeys: keys, laneRegister: assets });

    // PostHog's budget runs out at meadow.example's exceptions: the rest of
    // meadow.example and all of northwind.example are skipped, with no row.
    const stopped = await runPosthogDumps(env, {
      nowMs: NOW,
      fetchImpl: posthogFetch((call) => (call.url.includes('/424242/') && call.family === 'exceptions' ? budgetSpent() : answerAll(call))).fetchImpl,
      rawKeys: keys,
      laneRegister: assets,
    });
    expect(stopped).toMatchObject({ budgetStopped: true, attempted: 3, failed: 1 });
    expect(stopped.skipped.filter((skip) => skip.reason === 'budget-exhausted').map((skip) => `${skip.asset} ${skip.family}`)).toEqual([
      ...['rageclicks', 'web-vitals', 'funnels'].map((family) => `meadow.example ${family}`),
      ...NOM_FAMILIES.map((family) => `northwind.example ${family}`),
    ]);

    const posthog = posthogFetch();
    const next = await runPosthogDumps(env, { nowMs: NEXT_DAY, fetchImpl: posthog.fetchImpl, rawKeys: keys, laneRegister: assets });
    // The refused window once more, and every window the stop never asked.
    expect(next.retried).toBe(4 + NOM_FAMILIES.length);
    expect(project('424242')(posthog.calls).filter((ask) => ask.endsWith('2026-09-22'))).toEqual(
      ['exceptions', 'rageclicks', 'web-vitals', 'funnels'].map((family) => `${family} 2026-09-22`),
    );
    expect(project('700001')(posthog.calls).filter((ask) => ask.endsWith('2026-09-22'))).toEqual(
      NOM_FAMILIES.map((family) => `${family} 2026-09-22`),
    );
    const collected = await pgAll<{ window: string }>(`SELECT asset || ' ' || report AS window FROM ${ARCHIVE_RUNS}
        WHERE integration = 'posthog' AND report_date = '2026-09-22' AND status = 'success' ORDER BY asset, report`);
    expect(collected.results.map((row) => row.window)).toEqual([
      ...[...FAMILIES].sort().map((family) => `meadow.example ${family}`),
      ...[...NOM_FAMILIES].sort().map((family) => `northwind.example ${family}`),
    ]);

    // Nothing is owed after that.
    const quiet = await runPosthogDumps(env, { nowMs: NEXT_DAY + 86_400_000, fetchImpl: posthogFetch().fetchImpl, rawKeys: keys, laneRegister: assets });
    expect(quiet.retried).toBe(0);
  });

  it('reproduces an explicit window and asks nothing else', async () => {
    await failedWindow('events', '2026-09-20', 'posthog_request_failed');
    const posthog = posthogFetch();
    const result = await runPosthogDumps(env, {
      nowMs: NEXT_DAY, fetchImpl: posthog.fetchImpl, rawKeys: KEYS, laneRegister: register(),
      scope: { asset: 'meadow.example', window: { start: '2026-09-08', end: '2026-09-22' } },
    });
    expect(result.retried).toBe(0);
    expect(new Set(asked(posthog.calls))).toEqual(new Set(FAMILIES.map((family) => `${family} 2026-09-22`)));
  });
});

describe('PostHog queries', () => {
  const window = { start: '2026-09-09', end: '2026-09-22' };

  it('aggregates server-side inside the window with an explicit bound on every family', () => {
    for (const family of ['web-daily', 'events', 'exceptions', 'rageclicks', 'web-vitals'] as const) {
      const query = posthogQuery(family, window);
      expect(query.text).toMatch(/^SELECT/);
      expect(query.text).toContain('FROM events');
      expect(query.text).toContain("timestamp >= toDateTime('2026-09-09 00:00:00') AND timestamp < toDateTime('2026-09-23 00:00:00')");
      expect(query.text).toContain('GROUP BY');
      expect(query.text).toMatch(/LIMIT \d+$/);
      // Never a raw event pull, never OFFSET (refused for personal keys).
      expect(query.text).not.toMatch(/SELECT \*/);
      expect(query.text).not.toMatch(/OFFSET/i);
    }
    expect(posthogQuery('exceptions', window).text).toContain("event = '$exception'");
    expect(posthogQuery('rageclicks', window).text).toContain("event = '$rageclick'");
    expect(posthogQuery('web-vitals', window).text).toContain("event = '$web_vitals'");
    expect(posthogQuery('web-vitals', window).text).toContain('LIMIT 20');
    expect(posthogQuery('web-daily', window).text).toContain("event = '$pageview'");
  });

  it('builds one ordered funnel query from the declared steps', () => {
    const second: PosthogFunnel = { id: 'save', name: 'Save a plan', steps: [{ event: 'calculation_complete' }, { event: 'plan_save' }] };
    const query = posthogQuery('funnels', { start: '2026-09-16', end: '2026-09-22' }, [CALCULATOR, second]);
    expect(query.columns).toEqual(['funnel_1_step_1', 'funnel_1_step_2', 'funnel_1_step_3', 'funnel_2_step_1', 'funnel_2_step_2']);
    expect(query.text).toContain(
      "windowFunnel(604800)(toDateTime(timestamp), event = '$pageview' AND toString(properties.$pathname) = '/calculator', event = 'form_start', event = 'calculation_complete') AS funnel_1",
    );
    expect(query.text).toContain("windowFunnel(604800)(toDateTime(timestamp), event = 'calculation_complete', event = 'plan_save') AS funnel_2");
    expect(query.text).toContain("event IN ('$pageview', 'calculation_complete', 'form_start', 'plan_save')");
    expect(query.text).toContain('countIf(funnel_2 >= 2) AS funnel_2_step_2');
    expect(query.text).toContain('GROUP BY person_id');
  });

  it('dates a daily window in the project timezone', () => {
    // 01:00 UTC on 09-23 is still 09-22 in New York: the last complete day
    // there is 09-21.
    expect(windowFor('events', 'America/New_York', undefined, Date.parse('2026-09-23T01:00:00Z'))).toEqual({ start: '2026-09-08', end: '2026-09-21' });
    expect(windowFor('events', null, undefined, Date.parse('2026-09-23T01:00:00Z'))).toEqual({ start: '2026-09-09', end: '2026-09-22' });
  });
});
