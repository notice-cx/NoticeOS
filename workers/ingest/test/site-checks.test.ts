// The two daily site readings beside the served-layer guards: which security
// headers the home page sends (`security-headers`, in the nightly sweep) and
// the site's page speed from the Chrome UX Report (`crux-vitals`, its own job).

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putCredential } from '../src/credentials.js';
import { CRUX_CHECK_ID, parseCruxRecord, runCruxVitals } from '../src/crux.js';
import {
  readSecurityHeaders,
  runHygieneChecks,
  SECURITY_HEADERS,
  SECURITY_HEADERS_RULE_ID,
  type HygieneAsset,
} from '../src/hygiene.js';
import { flagRows, pgCount, reset } from './helpers.js';

beforeEach(reset);
afterEach(() => {
  vi.restoreAllMocks();
});

const DOMAIN = 'meadow.example';
const SITES: HygieneAsset[] = [{ asset: 'meadow.example', domain: DOMAIN }];
const NOW = Date.parse('2026-07-20T04:00:00.000Z');
const DAY_MS = 86_400_000;
const day = (n: number) => new Date(NOW + n * DAY_MS).toISOString().slice(0, 10);

type Reading = { status: string; value_num: number | null; detail_json: string };

async function readingFor(check: string, on: string): Promise<Reading | null> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<Reading>(
      `SELECT status, value_num, detail::text AS detail_json FROM noticeos.hygiene_checks
        WHERE asset_id = 'meadow.example' AND check_id = $1 AND observed_on = $2::date`,
      [check, on],
    ),
  );
  return row ?? null;
}

const detailOf = (row: Reading | null): Record<string, unknown> =>
  row ? (JSON.parse(row.detail_json) as Record<string, unknown>) : {};

async function openFlags(ruleId: string): Promise<number> {
  return pgCount(
    `SELECT count(*) AS n FROM noticeos.current_flags WHERE rule_id = $1 AND resolved_at IS NULL`,
    [ruleId],
  );
}

// --- security headers ----------------------------------------------------------

/** The site answering its home page with `headers`, and a plain robots.txt and
 * empty sitemap so the sweep's other checks have answers too. */
function siteServing(headers: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === `https://${DOMAIN}/`) {
      return new Response('<!doctype html><html><body><p>words here</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', ...headers },
      });
    }
    if (url === `https://${DOMAIN}/robots.txt`) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (url === `https://${DOMAIN}/sitemap.xml`) {
      return new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

const HSTS = { 'strict-transport-security': 'max-age=63072000; includeSubDomains' };
const CSP = { 'content-security-policy': "default-src 'self'" };
const NOSNIFF = { 'x-content-type-options': 'nosniff' };

async function sweep(headers: Record<string, string>, night: number) {
  return runHygieneChecks(env, { assets: SITES, fetchImpl: siteServing(headers), nowMs: NOW + night * DAY_MS, confirmWaitMs: 0 });
}

describe('security-headers', () => {
  it('records which of the six headers the home page sends, one reading a day', async () => {
    const result = await sweep({ ...HSTS, ...CSP, ...NOSNIFF }, 0);

    const outcome = result.outcomes.find((entry) => entry.check === 'security-headers');
    expect(outcome).toMatchObject({ status: 'ok', value: 3, fired: 0 });
    const row = await readingFor('security-headers', day(0));
    expect(row).toMatchObject({ status: 'ok', value_num: 3 });
    expect(detailOf(row)).toMatchObject({
      present: 3,
      of: 6,
      http_status: 200,
      headers: {
        'strict-transport-security': 'max-age=63072000; includeSubDomains',
        'content-security-policy': "default-src 'self'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': null,
        'referrer-policy': null,
        'permissions-policy': null,
      },
    });
  });

  it('never fires on absence alone: an asset that never sent a header is not flagged', async () => {
    await sweep({}, 0);
    await sweep({}, 1);
    await sweep({ ...NOSNIFF }, 2);

    expect(await openFlags(SECURITY_HEADERS_RULE_ID)).toBe(0);
    expect(await readingFor('security-headers', day(1))).toMatchObject({ status: 'ok', value_num: 0 });
    expect(await readingFor('security-headers', day(2))).toMatchObject({ status: 'ok', value_num: 1 });
  });

  it('fires when a header it sent is gone, holds while it stays gone, and resolves when it returns', async () => {
    await sweep({ ...HSTS, ...CSP }, 0);

    const lost = await sweep({ ...HSTS }, 1);
    expect(lost.outcomes.find((entry) => entry.check === 'security-headers')).toMatchObject({ status: 'warn', fired: 1 });
    expect(await readingFor('security-headers', day(1))).toMatchObject({ status: 'warn', value_num: 1 });
    const [flag] = await flagRows(`rule_id = $1`, [SECURITY_HEADERS_RULE_ID]);
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'security-headers' });
    expect(flag!.message).toBe('home page stopped sending content-security-policy');
    expect(JSON.parse(flag!.rule_inputs!)).toMatchObject({
      missing_headers: ['content-security-policy'],
      previous_headers: { 'content-security-policy': "default-src 'self'" },
      previous_observed_on: day(0),
    });

    // Night three: the previous reading already lacked it, so only the open
    // flag keeps the condition, and it is refreshed rather than resolved.
    const still = await sweep({ ...HSTS }, 2);
    expect(still.outcomes.find((entry) => entry.check === 'security-headers')).toMatchObject({ status: 'warn', fired: 0, refreshed: 1 });
    expect(await openFlags(SECURITY_HEADERS_RULE_ID)).toBe(1);

    const back = await sweep({ ...HSTS, ...CSP }, 3);
    expect(back.outcomes.find((entry) => entry.check === 'security-headers')).toMatchObject({ status: 'ok', resolved: 1 });
    expect(await openFlags(SECURITY_HEADERS_RULE_ID)).toBe(0);
  });

  it('judges only a 200: an error page records no headers and neither fires nor resolves', async () => {
    await sweep({ ...HSTS }, 0);
    await sweep({}, 1);
    expect(await openFlags(SECURITY_HEADERS_RULE_ID)).toBe(1);

    const failing = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === `https://${DOMAIN}/`) return new Response('down', { status: 503 });
      return siteServing({})(input);
    }) as typeof fetch;
    await runHygieneChecks(env, { assets: SITES, fetchImpl: failing, nowMs: NOW + 2 * DAY_MS, confirmWaitMs: 0 });

    const row = await readingFor('security-headers', day(2));
    expect(row).toMatchObject({ status: 'error', value_num: null });
    expect(detailOf(row)).not.toHaveProperty('headers');
    expect(await openFlags(SECURITY_HEADERS_RULE_ID)).toBe(1);

    // The next judged night compares against the last judged one, not the 503.
    await sweep({ ...HSTS }, 3);
    expect(await openFlags(SECURITY_HEADERS_RULE_ID)).toBe(0);
  });

  it('keeps each header value short', () => {
    const map = readSecurityHeaders(new Headers({ 'content-security-policy': `default-src ${'x'.repeat(1000)}` }));
    expect(map['content-security-policy']).toHaveLength(300);
    expect(Object.keys(map)).toEqual([...SECURITY_HEADERS]);
  });
});

// --- Chrome UX Report ------------------------------------------------------------

const CRUX_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const KEY = 'test-crux-key';

function record(lcp: number, inp: number, cls: string) {
  return {
    record: {
      key: { origin: `https://${DOMAIN}` },
      metrics: {
        largest_contentful_paint: { percentiles: { p75: lcp } },
        interaction_to_next_paint: { percentiles: { p75: inp } },
        cumulative_layout_shift: { percentiles: { p75: cls } },
      },
      collectionPeriod: {
        firstDate: { year: 2026, month: 6, day: 21 },
        lastDate: { year: 2026, month: 7, day: 18 },
      },
    },
  };
}

interface CruxCall {
  url: string;
  key: string | null;
  origin: string;
  formFactor: string | null;
}

/** CrUX answering `answer(origin, formFactor)`; every call is recorded. */
function crux(answer: (origin: string, formFactor: string | null) => Response): { fetchImpl: typeof fetch; calls: CruxCall[] } {
  const calls: CruxCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url !== CRUX_URL) throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body)) as { origin: string; formFactor?: string };
    calls.push({ url, key: new Headers(init?.headers).get('x-goog-api-key'), origin: body.origin, formFactor: body.formFactor ?? null });
    return answer(body.origin, body.formFactor ?? null);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json({ error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } }, 404);

async function connect(): Promise<void> {
  expect(await putCredential(env, { provider: 'crux', fields: { CRUX_API_KEY: KEY } })).toMatchObject({ ok: true });
}

describe('crux-vitals', () => {
  it('stores one reading per asset with the p75 of LCP, INP and CLS for phones and desktops', async () => {
    await connect();
    const { fetchImpl, calls } = crux((_origin, formFactor) =>
      formFactor === 'PHONE' ? json(record(2900, 240, '0.12')) : json(record(1800, 90, '0.03')));

    const result = await runCruxVitals(env, { sites: SITES, fetchImpl, nowMs: NOW });

    expect(result).toMatchObject({ connected: true, attempted: 1, succeeded: 1, failed: 0 });
    // The key rides a header: no URL the run fetched carries it.
    expect(calls.map((call) => [call.formFactor, call.key])).toEqual([['PHONE', KEY], ['DESKTOP', KEY]]);
    expect(calls.every((call) => !call.url.includes(KEY))).toBe(true);

    const row = await readingFor(CRUX_CHECK_ID, day(0));
    expect(row).toMatchObject({ status: 'ok', value_num: 2900 });
    expect(detailOf(row)).toEqual({
      origin: `https://${DOMAIN}`,
      lcp: 2900,
      inp: 240,
      cls: 0.12,
      formFactor: 'PHONE',
      collectionPeriod: { firstDate: '2026-06-21', lastDate: '2026-07-18' },
      formFactors: {
        PHONE: { lcp: 2900, inp: 240, cls: 0.12, collectionPeriod: { firstDate: '2026-06-21', lastDate: '2026-07-18' } },
        DESKTOP: { lcp: 1800, inp: 90, cls: 0.03, collectionPeriod: { firstDate: '2026-06-21', lastDate: '2026-07-18' } },
      },
    });
  });

  it('asks at www. when CrUX does not know the bare domain, and records "no data" when neither has any', async () => {
    await connect();
    const www = crux((origin) => (origin === `https://www.${DOMAIN}` ? json(record(2100, 150, '0.05')) : notFound()));
    await runCruxVitals(env, { sites: SITES, fetchImpl: www.fetchImpl, nowMs: NOW });
    expect(detailOf(await readingFor(CRUX_CHECK_ID, day(0)))).toMatchObject({ origin: `https://www.${DOMAIN}`, lcp: 2100 });

    const none = crux(() => notFound());
    const result = await runCruxVitals(env, { sites: SITES, fetchImpl: none.fetchImpl, nowMs: NOW + DAY_MS });
    expect(result.outcomes).toEqual([{ asset: 'meadow.example', status: 'no-data', lcp: null, errorCode: null }]);
    const row = await readingFor(CRUX_CHECK_ID, day(1));
    expect(row).toMatchObject({ status: 'ok', value_num: null });
    expect(detailOf(row)).toMatchObject({ no_data: true, formFactor: null, lcp: null });
  });

  it('records "not connected" and asks nothing when no key is connected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { fetchImpl, calls } = crux(() => json(record(1, 1, '0')));

    const result = await runCruxVitals(env, { sites: SITES, fetchImpl, nowMs: NOW });

    expect(result).toMatchObject({ connected: false, attempted: 0, failed: 0, outcomes: [] });
    expect(calls).toHaveLength(0);
    expect(await readingFor(CRUX_CHECK_ID, day(0))).toBeNull();
    expect(log.mock.calls.map(([line]) => String(line))).toContain(JSON.stringify({ event: 'crux_not_connected' }));
  });

  it('stops at a refused key: every asset fails, nothing is stored, and the key is not shown', async () => {
    await connect();
    const sites: HygieneAsset[] = [...SITES, { asset: 'northwind.example', domain: 'northwind.example' }];
    const { fetchImpl, calls } = crux(() => json({ error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }, 400));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runCruxVitals(env, { sites, fetchImpl, nowMs: NOW });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ attempted: 2, succeeded: 0, failed: 2 });
    expect(result.outcomes.map((outcome) => outcome.errorCode)).toEqual(['crux_http_400', 'crux_http_400']);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.hygiene_checks WHERE check_id = $1`, [CRUX_CHECK_ID])).toBe(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });
});

describe('parseCruxRecord', () => {
  it('reads CLS from its string form and leaves a missing metric null', () => {
    const body = record(2000, 100, '0.08');
    delete (body.record.metrics as Record<string, unknown>).interaction_to_next_paint;
    expect(parseCruxRecord(body)).toEqual({
      lcp: 2000,
      inp: null,
      cls: 0.08,
      collectionPeriod: { firstDate: '2026-06-21', lastDate: '2026-07-18' },
    });
    expect(parseCruxRecord({ error: {} })).toBeNull();
  });
});
