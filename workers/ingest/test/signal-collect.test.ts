import { env } from 'cloudflare:test';
import { DATAFORSEO_BASE_REPORTS, SERP_PANEL_DEVICES } from '@noticeos/contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSignalCollect } from '../src/routes/signal-collect.js';
import { runPosthogDumps } from '../src/posthog-dumps.js';
import { dataForSeoFamiliesFor } from '../src/dataforseo-dumps.js';
import serpPanelConfig from './fixture-config/serp-panel.json';
import { OPERATOR_TOKEN } from './fixtures.js';
import { ARCHIVE_RUNS, call, pgAll, pgCount, pgFirst, reset, storeArchiveRun } from './helpers.js';

const NOW = Date.parse('2026-08-04T09:12:00.000Z');
const SERP_PATH = '/serp/google/organic/live/advanced';
/** northwind.example's own panel, from the suite's frozen copy of
 * config/serp-panel.json — never the checkout's own. Read as the keywords
 * alone: an entry may also carry the cluster it measures, and that rides in
 * the archive rather than in the provider call this suite counts. */
const NOM_QUERIES = (
  serpPanelConfig.assets['northwind.example']!.queries as (
    | string
    | { query: string; label?: string }
  )[]
).map((entry) => (typeof entry === 'string' ? entry : entry.query));
/** One call per tracked query per device: what the on-demand door buys when
 * somebody asks for the panel alone. The label is never transmitted, so only
 * the device multiplies this. */
const NOM_PANEL_CALLS = NOM_QUERIES.length * SERP_PANEL_DEVICES.length;
/** The single-call families northwind.example is due — derived from the shipped
 * registry, never counted by hand: the count is property-dependent, since
 * `keyword-ideas` is owed only where a tracked panel supplies its seeds. */
const DOMAIN_FAMILIES = dataForSeoFamiliesFor('northwind.example').filter(
  (family) => family !== 'serp-panel',
).length;
/** The same two retries the collector ships with, without the four seconds. */
const FAST_RETRY = [0, 0];

interface FetchCall {
  url: string;
  task: Record<string, unknown>;
}

/** A provider that answers everything, so the only thing under test is what
 * was asked for. `failPath`/`failTimes` reproduce a transient backlinks blip. */
function providerFetch({
  failPath = null,
  failTimes = Number.POSITIVE_INFINITY,
}: { failPath?: string | null; failTimes?: number } = {}): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let failures = 0;
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const task = (
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>[]) : []
    )[0] ?? {};
    calls.push({ url, task });
    if (failPath && url.endsWith(failPath) && failures < failTimes) {
      failures += 1;
      return Response.json(
        { status_code: 50000, status_message: 'Provider unavailable.', cost: 0, tasks: [] },
        { status: 503 },
      );
    }
    const panel = url.endsWith(SERP_PATH);
    return Response.json({
      status_code: 20000,
      status_message: 'Ok.',
      cost: panel ? 0.004 : 0.011,
      tasks: [
        {
          status_code: 20000,
          status_message: 'Ok.',
          cost: panel ? 0.004 : 0.011,
          result: [
            panel
              ? {
                  keyword: task.keyword,
                  items_count: 2,
                  items: [
                    { type: 'ai_overview', references: [{ domain: 'northwind.example' }] },
                    { type: 'organic', rank_group: 4, domain: 'northwind.example' },
                  ],
                }
              : { items_count: 1, items: [{ ok: true }] },
          ],
        },
      ],
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface CollectBody {
  collected?: boolean;
  asset?: string;
  families?: string[];
  attempted?: number;
  succeeded?: number;
  unchanged?: number;
  failed?: number;
  costUsd?: number;
  retried?: { report: string; status: string; retries: number; reportDate?: string; errorCode?: string | null }[];
  retryNotAsked?: number;
  outcomes?: {
    report: string;
    reportDate: string;
    status: string;
    providerRows: number;
    objectKey: string | null;
    costUsd: number;
    retries: number;
    errorCode: string | null;
  }[];
  error?: string;
  detail?: string;
  available?: string[];
  issues?: { path: string; code: string; message: string }[];
}

function collectRequest(body: unknown, token: string | null = OPERATOR_TOKEN): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('https://ingest.local/api/signal-collect', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The route with a mocked provider — the REAL collector, never the network. */
async function collect(
  body: unknown,
  options: Parameters<typeof handleSignalCollect>[2] = {},
): Promise<{ status: number; body: CollectBody }> {
  const res = await handleSignalCollect(collectRequest(body), env, {
    nowMs: NOW,
    login: 'operator-login',
    password: 'operator-password',
    ...options,
  });
  return { status: res.status, body: (await res.json()) as CollectBody };
}

/** Through the Worker's own router, for the paths that must never reach the
 * provider — a request that got as far as a fetch here would be a real call. */
async function refused(
  body: unknown,
  token: string | null = OPERATOR_TOKEN,
): Promise<{ status: number; body: CollectBody }> {
  const res = await call(collectRequest(body, token));
  return { status: res.status, body: (await res.json()) as CollectBody };
}

beforeEach(reset);

describe('POST /api/signal-collect — refusing before anything is billed', () => {
  it('is operator-authed, and wired into the router', async () => {
    expect((await refused({ asset: 'northwind.example' }, null)).status).toBe(401);
    expect((await refused({ asset: 'northwind.example' }, 'not-the-token')).status).toBe(401);
    // Not a 404: the route exists and the bearer is the only thing missing.
    expect(
      (await call(new Request('https://ingest.local/api/signal-collect', { method: 'GET' })))
        .status,
    ).toBe(404);
  });

  it('rejects an unparseable or non-object body', async () => {
    expect((await refused('{')).status).toBe(400);
    expect((await refused([{ asset: 'northwind.example' }])).status).toBe(400);
  });

  it('names every bad field at once rather than the first', async () => {
    const { status, body } = await refused({ asset: 'NOT VALID', families: ['ranked'] });
    expect(status).toBe(422);
    expect(body.error).toBe('validation');
    expect(body.issues?.map((issue) => issue.path).sort()).toEqual(['asset', 'families']);
    expect(body.issues?.find((issue) => issue.path === 'families')?.message).toContain(
      'serp-panel',
    );
  });

  it('rejects a repeated family instead of quietly billing it once', async () => {
    const { status, body } = await refused({
      asset: 'northwind.example',
      families: ['serp-panel', 'serp-panel'],
    });
    expect(status).toBe(422);
    expect(body.issues?.[0]?.message).toContain('must not repeat');
  });

  /** The collector has no roster: membership IS the store query. A property this
   * route refuses is one the Monday lane would not have collected either. */
  it('refuses a property the weekly lane does not collect, and says which kind', async () => {
    const unknown = await refused({ asset: 'not-a-property' });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ error: 'unknown_asset' });
    expect(unknown.body.detail).toBe('not-a-property is not a property in the store.');

    // Seeded, but pre-launch: a different mistake, and a different sentence.
    expect((await refused({ asset: 'ferns.example' })).body.detail).toBe(
      'ferns.example is pre-launch; the DataForSEO lane collects launched properties only.',
    );
    expect((await refused({ asset: 'root-os' })).body.detail).toBe(
      'root-os is the OS itself and has no public search surface.',
    );
    expect(
      await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`),
    ).toBe(0);
  });

  /** Asking for a panel a property has no config for is a 422 pointing at the
   * file, not a run that attempts nothing and reports a $0.00 success.
   * `appliesTo` would have filtered it silently — right for a portfolio sweep
   * and wrong for a request somebody typed. */
  it('refuses a panel family for a property config/serp-panel.json does not name', async () => {
    const { status, body } = await refused({
      asset: 'pebble.example',
      families: ['serp-panel'],
    });
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: 'family_unavailable', families: ['serp-panel'] });
    expect(body.detail).toContain('config/serp-panel.json');
    // The route offers exactly the families this property can be asked for —
    // the weekly set plus any periodic family it is due, panel excluded because
    // config/serp-panel.json does not name it. `keyword-ideas` is absent for the
    // same reason: it seeds from that panel. Derived, so a new family shows up
    // here as coverage rather than as a red test.
    expect(body.available).toEqual(
      dataForSeoFamiliesFor('pebble.example'),
    );
    expect(body.available).toContain('serp-competitors');
    expect(body.available).not.toContain('keyword-ideas');
    expect(
      await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`),
    ).toBe(0);
  });
});

describe('POST /api/signal-collect — one property, on the day it launched', () => {
  it('bills the named property alone', async () => {
    const { fetchImpl, calls } = providerFetch();
    const { status, body } = await collect({ asset: 'northwind.example' }, { fetchImpl });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      collected: true,
      asset: 'northwind.example',
      attempted: DOMAIN_FAMILIES + 1,
      succeeded: DOMAIN_FAMILIES + 1,
      unchanged: 0,
      failed: 0,
      retried: [],
    });
    // Every provider call names northwind.example — no other property's calls exist.
    expect(calls).toHaveLength(DOMAIN_FAMILIES + NOM_PANEL_CALLS);
    expect(
      calls.every((c) => String(c.task.tag ?? '').startsWith('northwind.example:')),
    ).toBe(true);
    expect(body.costUsd).toBeCloseTo(DOMAIN_FAMILIES * 0.011 + NOM_PANEL_CALLS * 0.004);

    const rows = (
      await pgAll<{ asset: string; n: number }>(`SELECT asset, count(*)::int AS n FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' GROUP BY asset`)
    ).results;
    expect(rows).toEqual([{ asset: 'northwind.example', n: DOMAIN_FAMILIES + 1 }]);
  });

  it('collects one family when one family is what was asked for', async () => {
    const { fetchImpl, calls } = providerFetch();
    const { body } = await collect(
      { asset: 'northwind.example', families: ['serp-panel'] },
      { fetchImpl },
    );

    expect(body).toMatchObject({
      families: ['serp-panel'],
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
    // Nothing but the panel was asked of the provider — every tracked term,
    // once per device, devices inner.
    expect(calls).toHaveLength(NOM_PANEL_CALLS);
    expect(calls.every((c) => c.url.endsWith(SERP_PATH))).toBe(true);
    expect(calls.map((c) => c.task.keyword)).toEqual(
      NOM_QUERIES.flatMap((keyword) => SERP_PANEL_DEVICES.map(() => keyword)),
    );
    expect(calls.map((c) => c.task.device)).toEqual(
      NOM_QUERIES.flatMap(() => [...SERP_PANEL_DEVICES]),
    );
    expect(body.outcomes).toHaveLength(1);
    expect(body.outcomes?.[0]).toMatchObject({
      report: 'serp-panel',
      reportDate: '2026-08-04',
      status: 'success',
      retries: 0,
      errorCode: null,
    });
    expect(body.outcomes?.[0]?.costUsd).toBeCloseTo(NOM_PANEL_CALLS * 0.004);
    expect(
      await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`),
    ).toBe(1);
  });

  /** The cap is fail-closed and the on-demand door is not a hole in it: the
   * gate reserves $0.25 per family against `monthly_caps.data_usd` before the
   * call, exactly as the sweep does. */
  it('refuses at the monthly cap without calling the provider, and says so', async () => {
    const { fetchImpl, calls } = providerFetch();
    const { status, body } = await collect(
      { asset: 'northwind.example', families: ['serp-panel'] },
      { fetchImpl, monthlyCapUsd: 0.24 },
    );

    expect(status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(body).toMatchObject({ attempted: 1, succeeded: 0, failed: 1, costUsd: 0 });
    expect(body.outcomes?.[0]).toMatchObject({
      report: 'serp-panel',
      status: 'error',
      errorCode: 'budget_exhausted',
    });
    // And the refusal is a manifest row, like every other refusal: the lane
    // evidence must never have to infer a run that did not happen.
    expect(
      await pgCount(
        `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND error_code = 'budget_exhausted'`,
      ),
    ).toBe(1);
  });

  /** Inherited, not re-implemented: the retry budget lives in `collectReport`,
   * which is the same code the Monday lane runs. */
  it('inherits the family retry budget and discloses what it spent', async () => {
    const { fetchImpl, calls } = providerFetch({
      failPath: '/backlinks/summary/live',
      failTimes: 1,
    });
    const { body } = await collect(
      { asset: 'northwind.example', families: ['backlinks-summary'] },
      { fetchImpl, retryBackoffMs: FAST_RETRY },
    );

    expect(calls).toHaveLength(2);
    expect(body).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      retried: [{ report: 'backlinks-summary', status: 'success', retries: 1 }],
    });
  });

  it('gives up where the sweep gives up, and the row says how many attempts', async () => {
    const { fetchImpl, calls } = providerFetch({ failPath: '/backlinks/summary/live' });
    const { body } = await collect(
      { asset: 'northwind.example', families: ['backlinks-summary'] },
      { fetchImpl, retryBackoffMs: FAST_RETRY },
    );

    expect(calls).toHaveLength(3);
    expect(body.outcomes?.[0]).toMatchObject({
      status: 'error',
      errorCode: 'dataforseo_http_503',
      retries: 2,
    });
    const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'backlinks-summary'`);
    expect(stored?.errorMessage).toBe('Provider unavailable. Gave up after 3 attempts.');
  });

  /** Re-firing the same day costs the provider call but does not duplicate the
   * archive — `archiveCollectedDump` stores identical content as `unchanged`. */
  it('reports a same-day re-fire as unchanged rather than a second archive', async () => {
    const { fetchImpl } = providerFetch();
    await collect({ asset: 'northwind.example', families: ['ranked-keywords'] }, { fetchImpl });
    const { body } = await collect(
      { asset: 'northwind.example', families: ['ranked-keywords'] },
      { fetchImpl },
    );

    expect(body).toMatchObject({ attempted: 1, succeeded: 0, unchanged: 1, failed: 0 });
    expect(body.costUsd).toBeCloseTo(0.011);
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PostHog on demand: `families: ["posthog-*"]` routes to the PostHog collector,
// optionally with a fixed start/end window.
// ---------------------------------------------------------------------------

const PH_KEYS = JSON.stringify({ 'meadow.example': 'phx_route_test_key' });
const PH_REGISTER = {
  assets: {
    'meadow.example': {
      posthog: {
        host: 'us',
        projectId: '424242',
        funnels: [{ id: 'calculator', name: 'Calculator', steps: [{ event: '$pageview', path: '/calculator' }, { event: 'form_start' }] }],
      },
    },
  },
};

function posthogProvider(): { fetchImpl: typeof fetch; queries: string[] } {
  const queries: string[] = [];
  const columns: Record<string, string[]> = {
    'web-daily': ['date', 'pageviews', 'people', 'sessions'],
    events: ['event', 'count', 'people', 'first_seen', 'last_seen'],
    exceptions: ['exception_type', 'exception_message', 'occurrences', 'people', 'sessions', 'max_per_session', 'has_source_file', 'top_path', 'top_browser'],
    rageclicks: ['path', 'tag', 'text', 'attr', 'clicks', 'people', 'desktop_clicks', 'mobile_clicks', 'tablet_clicks', 'page_people'],
    'web-vitals': ['path', 'device', 'os', 'lcp_p75', 'inp_p75', 'cls_p75', 'fcp_p75', 'measurements'],
    funnels: ['funnel_1_step_1', 'funnel_1_step_2'],
  };
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method !== 'POST') return Response.json({ id: 424242, timezone: 'America/New_York' });
    const body = JSON.parse(String(init.body)) as { name: string; query: { query: string } };
    queries.push(body.query.query);
    const family = body.name.slice('noticeos:posthog-'.length);
    return Response.json({ results: family === 'funnels' ? [[18826, 15864]] : [], columns: columns[family] });
  }) as typeof fetch;
  return { fetchImpl, queries };
}

/** `posthogProvider`, recording EVERY request (the project read too) and
 * answering none until `open()`; `started` resolves on the first request, once
 * the run holds the asset's lease. */
function gatedPosthogProvider() {
  const inner = posthogProvider();
  const calls: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : input instanceof URL ? input.href : input.url}`);
    reached();
    await gate;
    return inner.fetchImpl(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls, started, open };
}

describe('POST /api/signal-collect — PostHog families', () => {
  it('collects every PostHog family for one asset over a fixed window', async () => {
    const { fetchImpl, queries } = posthogProvider();
    const { status, body } = await collect(
      { asset: 'meadow.example', families: ['posthog-*'], start: '2026-09-08', end: '2026-09-22' },
      { posthog: { fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs: Date.parse('2026-09-23T12:30:00Z') } },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      collected: true,
      asset: 'meadow.example',
      families: ['posthog-web-daily', 'posthog-events', 'posthog-exceptions', 'posthog-rageclicks', 'posthog-web-vitals', 'posthog-funnels'],
      attempted: 6,
      succeeded: 6,
      failed: 0,
      costUsd: 0,
    });
    expect(body.outcomes?.map((outcome) => [outcome.report, outcome.reportDate])).toContainEqual(['posthog-funnels', '2026-09-22']);
    expect(queries.every((query) => query.includes("toDateTime('2026-09-08 00:00:00')"))).toBe(true);
  });

  it('collects only the named PostHog families, and DataForSEO is never asked', async () => {
    const { fetchImpl, queries } = posthogProvider();
    const { status, body } = await collect(
      { asset: 'meadow.example', families: ['posthog-events', 'posthog-funnels'] },
      { posthog: { fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs: Date.parse('2026-09-23T12:30:00Z') } },
    );
    expect(status).toBe(200);
    expect(body.attempted).toBe(2);
    expect(queries).toHaveLength(2);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`)).toBe(0);
  });

  it('refuses mixed providers, bad windows and repeats before any request', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ asset: 'meadow.example', families: ['posthog-events', 'serp-panel'] }, 'one provider per request'],
      [{ asset: 'meadow.example', families: ['posthog-*', 'posthog-events'] }, 'name it alone'],
      [{ asset: 'meadow.example', families: ['posthog-nope'] }, 'posthog-web-daily'],
      [{ asset: 'meadow.example', families: ['posthog-events', 'posthog-events'] }, 'must not repeat'],
      [{ asset: 'meadow.example', families: ['posthog-*'], start: '2026-09-08' }, 'together'],
      [{ asset: 'meadow.example', families: ['posthog-*'], start: '2026-09-22', end: '2026-09-08' }, 'not be after'],
      [{ asset: 'meadow.example', families: ['posthog-*'], start: '2026-08-01', end: '2026-09-22' }, 'at most 28 days'],
      [{ asset: 'meadow.example', families: ['posthog-*'], start: '2999-01-01', end: '2999-01-02' }, 'not be in the future'],
      [{ asset: 'northwind.example', families: ['ranked-keywords'], start: '2026-09-08', end: '2026-09-22' }, 'PostHog families only'],
    ];
    for (const [request, message] of cases) {
      const { status, body } = await refused(request);
      expect(status, JSON.stringify(request)).toBe(422);
      expect(body.issues?.map((issue) => issue.message).join(' '), JSON.stringify(request)).toContain(message);
    }
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(0);
  });

  // One PostHog run per asset, whichever door it came through.
  it('runs one of two on-demand requests for the same asset and refuses the other with a plain 409', async () => {
    const nowMs = Date.parse('2026-09-23T12:30:00Z');
    const first = gatedPosthogProvider();
    const firstRun = collect(
      { asset: 'meadow.example', families: ['posthog-*'] },
      { posthog: { fetchImpl: first.fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs } },
    );
    await first.started;

    const second = gatedPosthogProvider();
    second.open();
    const res = await handleSignalCollect(collectRequest({ asset: 'meadow.example', families: ['posthog-events'] }), env, {
      posthog: { fetchImpl: second.fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs },
    });
    const text = await res.text();
    expect(res.status).toBe(409);
    const body = JSON.parse(text) as CollectBody & { inFlight?: { startedAt: string; leaseExpiresAt: string } };
    expect(body).toMatchObject({ error: 'collection_in_flight', asset: 'meadow.example', families: ['posthog-events'] });
    // One line: what runs, that nothing was asked, when it frees.
    expect(body.detail).toMatch(/^Already running for meadow\.example · started \d+s ago · nothing asked · /);
    expect(body.detail).toContain(`free at ${body.inFlight?.leaseExpiresAt}`);
    // `pnpm signals:collect` prints the first 400 characters of the body: the
    // whole sentence must be in them.
    expect(text.slice(0, 400)).toContain(body.detail);
    expect(second.calls).toHaveLength(0);

    first.open();
    const done = await firstRun;
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ attempted: 6, succeeded: 6 });
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog'`)).toBe(6);

    // Released: the next request runs.
    const third = gatedPosthogProvider();
    third.open();
    const again = await collect(
      { asset: 'meadow.example', families: ['posthog-events'] },
      { posthog: { fetchImpl: third.fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs } },
    );
    expect(again.status).toBe(200);
  });

  it('refuses an on-demand request while the daily run holds the asset, and the daily run finishes', async () => {
    const nowMs = Date.parse('2026-09-23T12:30:00Z');
    const daily = gatedPosthogProvider();
    // The 12:30 UTC cron's call: no scope.
    const dailyRun = runPosthogDumps(env, { fetchImpl: daily.fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs });
    await daily.started;
    const onDemand = gatedPosthogProvider();
    onDemand.open();
    const { status, body } = await collect(
      { asset: 'meadow.example', families: ['posthog-*'] },
      { posthog: { fetchImpl: onDemand.fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs } },
    );
    expect(status).toBe(409);
    expect(body.error).toBe('collection_in_flight');
    expect(onDemand.calls).toHaveLength(0);
    daily.open();
    expect(await dailyRun).toMatchObject({ attempted: 6, succeeded: 6 });
  });

  it('reports the earlier windows it asked again, as the daily run counts them', async () => {
    // A window PostHog never answered the day before: owed a re-collection.
    await storeArchiveRun({
      id: 'owed-events', asset: 'meadow.example', integration: 'posthog', report: 'events', credential_ref: 'POSTHOG_KEYS',
      property_ref: 'us:424242', report_date: '2026-09-21', finished_at: '2026-09-22T12:30:00.000Z', status: 'error',
      error_code: 'posthog_request_failed', error_message: 'fixture',
    });
    const log = vi.spyOn(console, 'log');
    try {
      const { fetchImpl, queries } = posthogProvider();
      const { status, body } = await collect(
        { asset: 'meadow.example', families: ['posthog-*'] },
        { posthog: { fetchImpl, rawKeys: PH_KEYS, laneRegister: PH_REGISTER, nowMs: Date.parse('2026-09-23T12:30:00Z') } },
      );
      expect(status).toBe(200);
      expect(queries).toHaveLength(7);
      expect(body).toMatchObject({ attempted: 7, succeeded: 7, failed: 0, retryNotAsked: 0 });
      expect(body.retried).toEqual([
        { report: 'posthog-events', reportDate: '2026-09-21', status: 'success', retries: 1, errorCode: null },
      ]);
      // The re-collected window is marked among the outcomes; today's are not.
      expect(body.outcomes?.filter((outcome) => outcome.retries > 0).map((outcome) => [outcome.report, outcome.reportDate])).toEqual([
        ['posthog-events', '2026-09-21'],
      ]);
      // The run's own summary line, the one the daily run writes, says the same.
      const summary = log.mock.calls
        .map(([line]) => (typeof line === 'string' && line.includes('"posthog_dumps_complete"') ? (JSON.parse(line) as Record<string, unknown>) : null))
        .find((line) => line !== null);
      expect(summary).toMatchObject({ retried: body.retried?.length, retryNotAsked: body.retryNotAsked });
    } finally {
      log.mockRestore();
    }
  });

  it('says why an asset collected nothing instead of reporting an empty success', async () => {
    const { fetchImpl, queries } = posthogProvider();
    const { status, body } = await collect(
      { asset: 'meadow.example', families: ['posthog-*'] },
      { posthog: { fetchImpl, rawKeys: '', laneRegister: PH_REGISTER } },
    );
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: 'posthog_not_collected' });
    expect(body.detail).toContain('no PostHog key');
    expect(queries).toHaveLength(0);
  });
});
