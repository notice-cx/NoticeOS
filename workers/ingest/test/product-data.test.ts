import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectProductData, productDataReports } from '../src/product-data.js';
import { runPullAdapter, type PullAssetConfig } from '../src/pull.js';
import { ARCHIVE_RUNS, pgCount, pgRows, reset } from './helpers.js';

beforeEach(reset);
const NOW = Date.parse('2026-07-05T12:00:00.000Z');
const generatedAt = '2026-07-04T23:00:00.000Z';
const url = 'https://meadow.example/api/internal/metrics/product';
const payload = () => ({ generatedAt, definitions: { firstResults: 'Within the first seven days.' },
  firstResults: [{ week: '2026-26', matured: 4, any_result: 2, plan: 2, recipe: 1, log: 0 }],
  headline: { signups: 4, activated: 1, activationPct: null, activationInstrumentedFrom: null, activationFirstWeek: null, instrumentedSignups: 0, instrumentedActivated: 0, maturedWeek2: 1, retainedWeek2: 0, week2RetentionPct: 0, maturedDay30: 0, retainedDay30: 0, day30RetentionPct: null },
  cohorts: [{ signup_week: '2026-26', signups: 4, activated_7d: 1, activation_pct: 25, activated_matured_for_week_2: 1, retained_week_2: 0, activated_matured_for_day_30: 0, retained_day_30_window: 0, activation_instrumented: 0 }],
  adoption: { accounts: 4, plan_savers: 2, food_loggers: 1, planners: 0, recipe_savers: 1, companion_weighers: 0, companion_dose_loggers: 0, push_users: 0 },
  weeklyActive: [{ week: '2026-26', weekly_active_users: 2, users_active_2plus_days: 1 }],
  firstLogWeeks: [{ week: '2026-26', signups: 4, first_loggers: 1, first_loggers_per_100_signups: 25, is_current_week: 0 }],
  trackerDaily: [{ day: '2026-07-04', event: 'tracker_log_saved', mobile: 1, desktop: 0, server: 0, total: 1 }],
  emailContactSync: { failed_adds_7d: 0, failed_adds_90d: 0, last_failure_day: null },
  firstResultsByIntent: null, newAccountsDaily: [{ day: '2026-07-04', intent: 'unrecorded', section: 'unrecorded', accounts: 0 }],
});

describe('product data acquisition', () => {
  it('uses the asset bearer and archives the source date, raw document and normalized reports', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-product-token');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(payload());
    });
    const results = await collectProductData(env, 'meadow.example', url, 'fixture-product-token', fetchImpl, NOW);
    expect(results).toHaveLength(13);
    expect(results.every(result => result.status === 'success')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const rows = await pgRows<{ report: string; reportDate: string }>(`SELECT report, report_date::text AS "reportDate" FROM noticeos.archive_runs WHERE integration='product-data'`);
    expect(rows.filter(row => row.report !== 'metrics-collection').every(row => row.reportDate === '2026-07-04')).toBe(true);
    const [raw] = await pgRows<{ objectKey: string }>(`SELECT object_key AS "objectKey" FROM ${ARCHIVE_RUNS} WHERE integration='product-data' AND report='metrics'`);
    const object = await env.RAW_SIGNALS.get(raw!.objectKey);
    const archived = await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).json() as { pages: { response: { document: unknown } }[] };
    expect(archived.pages[0]!.response.document).toEqual(payload());
    expect(JSON.stringify(archived)).not.toContain('fixture-product-token');
    const [metadataRow] = await pgRows<{ objectKey: string }>(`SELECT object_key AS "objectKey" FROM ${ARCHIVE_RUNS} WHERE integration='product-data' AND report='metrics-collection'`);
    const metadataObject = await env.RAW_SIGNALS.get(metadataRow!.objectKey);
    const metadata = await new Response(metadataObject!.body.pipeThrough(new DecompressionStream('gzip'))).json() as { pages: { response: { rows: { source_generated_at: string; availability_json: string; attempted_at: string }[] } }[] };
    const summary = metadata.pages[0]!.response.rows[0]!;
    expect(summary.source_generated_at).toBe(generatedAt);
    expect(summary.attempted_at).toBe(new Date(NOW).toISOString());
    expect(JSON.parse(summary.availability_json)).toEqual(expect.arrayContaining([{ block: 'firstResultsByIntent', state: 'null', row_count: null }]));
    expect(summary.availability_json).not.toContain('definitions');
  });

  it.each([401, 403, 503])('refuses HTTP %s without archiving an empty success', async status => {
    await expect(collectProductData(env, 'meadow.example', url, 'fixture-token', (async () => Response.json({ error: 'unavailable' }, { status })) as typeof fetch, NOW)).rejects.toThrow(String(status));
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.archive_runs WHERE integration='product-data' AND report <> 'metrics-collection' AND status='success'`)).toBe(0);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.archive_runs WHERE integration='product-data' AND status='error'`)).toBeGreaterThan(0);
  });

  it('refuses malformed JSON, oversized bodies and invalid timestamps', async () => {
    for (const response of [new Response('{'), new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }), Response.json({ generatedAt: 'wrong' })]) {
      await expect(collectProductData(env, 'meadow.example', url, 'fixture-token', (async () => response) as typeof fetch, NOW)).rejects.toThrow();
    }
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.archive_runs WHERE integration='product-data' AND report <> 'metrics-collection' AND status='success'`)).toBe(0);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.archive_runs WHERE integration='product-data' AND status='error'`)).toBeGreaterThan(0);
  });

  it('aborts a stalled acquisition and records its failed attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('fixture timeout')), { once: true });
      }));
      const pending = collectProductData(env, 'meadow.example', url, 'fixture-token', fetchImpl, NOW);
      const rejected = expect(pending).rejects.toThrow(/collection failed/);
      await vi.advanceTimersByTimeAsync(30_000);
      vi.useRealTimers();
      await rejected;
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(await pgCount(`SELECT count(*) AS n FROM noticeos.archive_runs WHERE integration='product-data' AND status='error'`)).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('records a failing collection after an archive write fails, retaining the earlier successful document', async () => {
    await collectProductData(env, 'meadow.example', url, 'fixture-token', (async () => Response.json(payload())) as typeof fetch, NOW);
    const put = vi.spyOn(env.RAW_SIGNALS, 'put').mockRejectedValueOnce(new Error('fixture archive failure'));
    try {
      await expect(collectProductData(env, 'meadow.example', url, 'fixture-token',
        (async () => Response.json({ ...payload(), generatedAt: '2026-07-05T23:00:00.000Z' })) as typeof fetch,
        NOW + 86_400_000)).rejects.toThrow();
    } finally { put.mockRestore(); }
    const [row] = await pgRows<{ objectKey: string }>(`SELECT object_key AS "objectKey" FROM ${ARCHIVE_RUNS}
      WHERE integration='product-data' AND report='metrics-collection' ORDER BY requested_at DESC LIMIT 1`);
    const object = await env.RAW_SIGNALS.get(row!.objectKey);
    const body = await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).json() as { pages: { response: { rows: { state: string }[] } }[] };
    expect(body.pages[0]!.response.rows[0]!.state).toBe('failing');
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.archive_runs WHERE integration='product-data' AND report='metrics' AND status='success'`)).toBe(1);
  });

  it('preserves primary metrics and flags supplemental acquisition failure', async () => {
    const entry: PullAssetConfig = { asset: 'meadow.example', url: 'https://meadow.example/report', format: 'envelope', enabled: true,
      additionalEndpoints: [{ url, format: 'product-data', enabled: true }] };
    const result = await runPullAdapter(env, { entries: [entry], nowMs: NOW, fetchImpl: (async input => String(input) === url
      ? Response.json({ error: 'unauthorized' }, { status: 401 })
      : Response.json({ asset: 'meadow.example', generatedAt: new Date(NOW).toISOString(), capabilities: ['signups'], metrics: { signups: { last24h: 3, avg7d: 3, total: 10 } } })) as typeof fetch });
    expect(result.failed).toBe(1);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.pulses WHERE asset_id='meadow.example'`)).toBe(1);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags WHERE asset_id='meadow.example' AND rule_id='asset-pull-failed'`)).toBe(1);
  });
});

describe('product data block availability', () => {
  it('distinguishes null, missing and available empty blocks in old and new payloads', () => {
    const parsed = productDataReports({ generatedAt, firstResults: [], firstResultsByIntent: null }, NOW);
    const availability = parsed.reports.find(report => report.report === 'metrics-availability')!.response.rows;
    expect(availability).toEqual(expect.arrayContaining([
      { block: 'firstResults', state: 'available', row_count: 0 },
      { block: 'firstResultsByIntent', state: 'null', row_count: null },
      { block: 'newAccountsDaily', state: 'missing', row_count: null },
    ]));
  });
  it('accepts recorded first-result intent counts without inventing a rate', () => {
    const body = { ...payload(), firstResultsByIntent: [{ intent: 'save-plan', matured: 3, any_result: 2, plan: 2, recipe: 0, log: 1 }] };
    const report = productDataReports(body, NOW).reports.find(item => item.report === 'metrics-first-results-by-intent');
    expect(report?.response.rows).toEqual(body.firstResultsByIntent);
  });
  it('keeps malformed rows from producing partial reports or fabricated zeros', () => {
    expect(() => productDataReports({ generatedAt, firstResults: [{ matured: -1 }] }, NOW)).toThrow();
    expect(() => productDataReports({ generatedAt, firstResults: [{ matured: {} }] }, NOW)).toThrow();
    expect(() => productDataReports({ generatedAt: '2026-07-06T00:00:00.000Z' }, NOW)).toThrow(/future/);
    expect(() => productDataReports({ generatedAt, firstResults: Array.from({ length: 20_001 }, () => ({ matured: 1 })) }, NOW)).toThrow(/row limit/);
  });
});
