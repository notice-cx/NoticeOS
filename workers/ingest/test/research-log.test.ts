import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadMeteredDataSpend } from '@noticeos/contract';
import {
  RESEARCH_REUSE_WINDOW_DAYS,
  canonicalJson,
  findPriorResearch,
  recordResearch,
  researchParamsHash,
} from '../src/research-log.js';
import {
  handleResearchLogLookup,
  handleResearchLogRecord,
} from '../src/routes/research-log.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { RESEARCH_LOG, pgCount, pgRows, reset, storeArchiveRun } from './helpers.js';

beforeEach(reset);

const NOW = Date.parse('2026-09-15T10:00:00.000Z');
const MS_PER_DAY = 86_400_000;

const KEYWORD_OVERVIEW = {
  provider: 'dataforseo' as const,
  endpoint: 'dataforseo_labs/google/keyword_overview/live',
};

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    ...KEYWORD_OVERVIEW,
    asset: 'meals.example',
    params: { keywords: ['dri calculator'], location_code: 2840 },
    question: 'keyword overview, 1 term, US/en',
    costUsd: 0.02,
    objectKey: 'raw/dataforseo/meals.example/2026-09-15/keyword-overview.json.gz',
    actor: 'claude-opus-5',
    ...overrides,
  };
}

describe('the research log — never buy the same answer twice', () => {
  it('answers a repeat question with the archive key instead of nothing', async () => {
    await recordResearch(env.STORE, purchase(), NOW);
    const prior = await findPriorResearch(env.STORE, {
      ...KEYWORD_OVERVIEW,
      params: { keywords: ['dri calculator'], location_code: 2840 },
      nowMs: NOW + 9 * MS_PER_DAY,
    });
    expect(prior).toMatchObject({
      asset: 'meals.example',
      objectKey:
        'raw/dataforseo/meals.example/2026-09-15/keyword-overview.json.gz',
      actor: 'claude-opus-5',
      ageDays: 9,
    });
  });

  it('is silent about a question nobody asked', async () => {
    await recordResearch(env.STORE, purchase(), NOW);
    expect(
      await findPriorResearch(env.STORE, {
        ...KEYWORD_OVERVIEW,
        // A different keyword is a different question, however similar.
        params: { keywords: ['ffmi calculator'], location_code: 2840 },
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it('stops reusing once the window has passed', async () => {
    await recordResearch(env.STORE, purchase(), NOW);
    const params = { keywords: ['dri calculator'], location_code: 2840 };
    expect(
      await findPriorResearch(env.STORE, {
        ...KEYWORD_OVERVIEW,
        params,
        nowMs: NOW + (RESEARCH_REUSE_WINDOW_DAYS - 1) * MS_PER_DAY,
      }),
    ).not.toBeNull();
    expect(
      await findPriorResearch(env.STORE, {
        ...KEYWORD_OVERVIEW,
        params,
        nowMs: NOW + (RESEARCH_REUSE_WINDOW_DAYS + 1) * MS_PER_DAY,
      }),
    ).toBeNull();
  });

  it('lets a caller name a shorter window for a volatile question', async () => {
    await recordResearch(env.STORE, purchase(), NOW);
    const params = { keywords: ['dri calculator'], location_code: 2840 };
    // A live SERP changes hourly; two days old is already stale for it, even
    // though the default window would happily reuse it.
    expect(
      await findPriorResearch(env.STORE, {
        ...KEYWORD_OVERVIEW,
        params,
        nowMs: NOW + 3 * MS_PER_DAY,
        windowDays: 1,
      }),
    ).toBeNull();
  });

  it('returns the newest purchase when a question was bought twice', async () => {
    await recordResearch(env.STORE, purchase({ actor: 'first' }), NOW);
    await recordResearch(
      env.STORE,
      purchase({ actor: 'second' }),
      NOW + 2 * MS_PER_DAY,
    );
    expect(
      await findPriorResearch(env.STORE, {
        ...KEYWORD_OVERVIEW,
        params: { keywords: ['dri calculator'], location_code: 2840 },
        nowMs: NOW + 3 * MS_PER_DAY,
      }),
    ).toMatchObject({ actor: 'second', ageDays: 1 });
  });

  /**
   * The invariant the whole table turns on: two spellings of one request must
   * collide, or each spelling quietly buys its own copy and the log records the
   * duplication instead of preventing it.
   */
  describe('canonical hashing', () => {
    it('ignores key order at every depth', async () => {
      const a = { b: 2, a: 1, nested: { y: 'two', x: 'one' } };
      const b = { a: 1, nested: { x: 'one', y: 'two' }, b: 2 };
      expect(await researchParamsHash(a)).toBe(await researchParamsHash(b));
    });

    it('treats an absent key and an undefined one as the same question', async () => {
      expect(await researchParamsHash({ a: 1 })).toBe(
        await researchParamsHash({ a: 1, b: undefined }),
      );
    });

    /**
     * Arrays are NOT sorted, and that is the point. `['volume,desc']` and
     * `['volume,asc']` are different questions, and so are two keyword lists in
     * different orders — order is meaning in a provider request body. A
     * canonicaliser that sorted arrays would collide questions that genuinely
     * differ and hand back the wrong answer.
     */
    it('keeps array order significant', async () => {
      expect(await researchParamsHash({ order_by: ['volume,desc'] })).not.toBe(
        await researchParamsHash({ order_by: ['volume,asc'] }),
      );
      expect(await researchParamsHash({ k: ['a', 'b'] })).not.toBe(
        await researchParamsHash({ k: ['b', 'a'] }),
      );
    });

    it('distinguishes a number from its string spelling', async () => {
      expect(canonicalJson({ n: 1 })).not.toBe(canonicalJson({ n: '1' }));
    });
  });

  /** Month-to-date spend must count the ad-hoc research as well as the
   * collected reports, or spend the gate cannot see is spend it cannot stop.
   * The sum the gate reads is the same body every desk meter reads
   * (`loadMeteredDataSpend`), so the number that fails the portfolio closed is
   * the number the operator is shown. */
  describe('month-to-date spend', () => {
    const AT = '2026-09-15T10:00:00.000Z';

    /** A collected report, the half the report runs have always carried. */
    async function insertReport(
      id: string,
      asset: string,
      requestedAt: string,
      costUsd: number,
    ): Promise<void> {
      await storeArchiveRun({
        id, asset, integration: 'dataforseo', report: 'ranked-keywords', credential_ref: 'test-cred',
        report_date: requestedAt.slice(0, 10), finished_at: requestedAt, provider_rows: 10, request_count: 1,
        object_key: `signals/${id}`, object_bytes: 100, provider_cost_usd: costUsd,
      });
    }

    it('counts BOTH halves of the account — collected reports and ad-hoc research', async () => {
      await insertReport('dfs-mp', 'meals.example', '2026-09-01T12:45:00.000Z', 1.1);
      await insertReport('dfs-nom', 'nosh.example', '2026-09-03T12:45:00.000Z', 0.4);
      await recordResearch(env.STORE, purchase({ costUsd: 0.24 }), NOW);
      // Portfolio-level research names no property; the store keeps that NULL
      // rather than inventing an asset id, so the money is stated separately.
      await recordResearch(
        env.STORE,
        purchase({ asset: null, costUsd: 0.06, params: { keywords: ['glp-1'] } }),
        NOW,
      );

      const spend = await loadMeteredDataSpend(env.STORE, AT);
      expect(spend.spentUsd).toBeCloseTo(1.8, 10);
      expect(spend.byAsset).toEqual([
        // The collected report and the research about the same property are one
        // asset's bill, not two.
        { asset: 'meals.example', spentUsd: 1.34, unknownPrices: 0 },
        { asset: 'nosh.example', spentUsd: 0.4, unknownPrices: 0 },
      ]);
      expect(spend.unattributedUsd).toBeCloseTo(0.06, 10);
      // The headline is the split plus the unattributed, never a second sum.
      expect(
        spend.byAsset.reduce((total, row) => total + row.spentUsd, 0) +
          spend.unattributedUsd,
      ).toBeCloseTo(spend.spentUsd, 10);
    });

    it('excludes the collector, whose spend its report runs already carry', async () => {
      await insertReport('dfs-mp', 'meals.example', '2026-09-01T12:45:00.000Z', 0.24);
      await recordResearch(
        env.STORE,
        purchase({ costUsd: 0.24, actor: 'collector' }),
        NOW,
      );
      // Summing both would double-bill the portfolio into a false cap breach.
      expect((await loadMeteredDataSpend(env.STORE, AT)).spentUsd).toBeCloseTo(0.24);
    });

    it('does not carry last month’s spend into this one', async () => {
      await insertReport('dfs-aug', 'meals.example', '2026-08-20T12:45:00.000Z', 9);
      await recordResearch(
        env.STORE,
        purchase({ costUsd: 0.5 }),
        Date.parse('2026-08-20T10:00:00.000Z'),
      );
      expect((await loadMeteredDataSpend(env.STORE, AT)).spentUsd).toBe(0);
    });

    it('windows research to the day the Wall states a pace against', async () => {
      await recordResearch(
        env.STORE,
        purchase({ costUsd: 0.24 }),
        Date.parse('2026-09-15T01:00:00.000Z'),
      );
      await recordResearch(
        env.STORE,
        purchase({ costUsd: 0.5, params: { keywords: ['yesterday'] } }),
        Date.parse('2026-09-14T23:59:59.000Z'),
      );
      expect((await loadMeteredDataSpend(env.STORE, AT, 'day')).spentUsd).toBeCloseTo(0.24);
      expect((await loadMeteredDataSpend(env.STORE, AT)).spentUsd).toBeCloseTo(0.74);
    });

    it('keeps a purchase whose price could not be read as an unknown price that adds nothing', async () => {
      await recordResearch(env.STORE, purchase({ costUsd: Number.NaN }), NOW);
      await recordResearch(env.STORE, purchase({ costUsd: 0.24, params: { keywords: ['b'] } }), NOW);
      const rows = await pgRows<{ id: number; cost_usd: number; cost_state: string }>(
        `SELECT id, cost_usd, cost_state FROM ${RESEARCH_LOG} ORDER BY id`,
      );
      // Each purchase is numbered in its workspace, one after the other.
      expect(rows.map((row) => row.id - rows[0]!.id)).toEqual([0, 1]);
      expect(rows.map(({ cost_usd, cost_state }) => ({ cost_usd, cost_state }))).toEqual([
        { cost_usd: 0, cost_state: 'unknown' },
        { cost_usd: 0.24, cost_state: 'reported' },
      ]);
      expect((await loadMeteredDataSpend(env.STORE, AT)).spentUsd).toBeCloseTo(0.24, 10);
      expect((await loadMeteredDataSpend(env.STORE, AT)).unknownPrices).toBe(1);
    });

    it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])('stores an unreadable price %s as null, never reported zero', async (costUsd) => {
      await recordResearch(env.STORE, purchase({ costUsd }), NOW);
      const rows = await env.STORE.read((tx) => tx.query<{ cost_usd: string | null; cost_state: string }>(
        'SELECT cost_usd, cost_state FROM noticeos.research_log',
      ));
      expect(rows).toEqual([{ cost_usd: null, cost_state: 'unknown' }]);
    });
  });

  it('stores no response body — a pointer, never a second archive', async () => {
    await recordResearch(env.STORE, purchase(), NOW);
    const columns = (
      await pgRows<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = 'noticeos' AND table_name = 'research_log'`,
      )
    ).map((row) => row.name);
    for (const forbidden of ['response', 'body', 'result', 'rows_json']) {
      expect(columns).not.toContain(forbidden);
    }
    expect(columns).toContain('object_key');
  });
});

describe('/api/research-log', () => {
  const post = (path: string, body: unknown, token = OPERATOR_TOKEN) =>
    new Request(`https://ingest.local${path}`, {
      method: 'POST',
      headers: token
        ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rejects an unauthenticated caller on both verbs', async () => {
    expect(
      (
        await handleResearchLogLookup(
          post('/api/research-log/lookup', {}, ''),
          env,
          NOW,
        )
      ).status,
    ).toBe(401);
    expect(
      (await handleResearchLogRecord(post('/api/research-log', {}, ''), env, NOW))
        .status,
    ).toBe(401);
  });

  it('records a purchase and then finds it', async () => {
    const recorded = await handleResearchLogRecord(
      post('/api/research-log', purchase()),
      env,
      NOW,
    );
    expect(recorded.status).toBe(201);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.research_log`)).toBe(1);

    const looked = await handleResearchLogLookup(
      post('/api/research-log/lookup', {
        ...KEYWORD_OVERVIEW,
        params: { keywords: ['dri calculator'], location_code: 2840 },
      }),
      env,
      NOW + MS_PER_DAY,
    );
    expect(await looked.json()).toMatchObject({
      found: true,
      windowDays: RESEARCH_REUSE_WINDOW_DAYS,
      prior: { ageDays: 1, actor: 'claude-opus-5' },
    });
  });

  /**
   * Defaulting `params` to `{}` would make every caller who omitted it collide
   * on one hash, and the second would "reuse" an answer to a question it never
   * asked. Refusing is the only safe reading of an absent key.
   */
  it('refuses a lookup with no params rather than guessing the question', async () => {
    const res = await handleResearchLogLookup(
      post('/api/research-log/lookup', KEYWORD_OVERVIEW),
      env,
      NOW,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses a purchase against a property that does not exist', async () => {
    const res = await handleResearchLogRecord(
      post('/api/research-log', purchase({ asset: 'not-a-property.com' })),
      env,
      NOW,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'unknown_asset' });
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.research_log`)).toBe(0);
  });

  it('accepts portfolio-level research with no property at all', async () => {
    const res = await handleResearchLogRecord(
      post(
        '/api/research-log',
        purchase({ asset: undefined, question: 'market scan, meal-kit space' }),
      ),
      env,
      NOW,
    );
    expect(res.status).toBe(201);
    const [row] = await pgRows<{ asset: string | null }>(`SELECT asset_id AS asset FROM noticeos.research_log`);
    expect(row?.asset).toBeNull();
  });

  it('refuses a purchase that names nobody as the spender', async () => {
    const res = await handleResearchLogRecord(
      post('/api/research-log', purchase({ actor: '   ' })),
      env,
      NOW,
    );
    expect(res.status).toBe(422);
  });
});
