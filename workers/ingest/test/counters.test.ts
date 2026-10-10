import { env } from 'cloudflare:test';
import { javascriptInstant } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCountersScrape, type CountersConfig } from '../src/counters.js';
import { pgCount, promBody, reset, stubFetch } from './helpers.js';

beforeEach(reset);

// A fixed clock: every reading this lane writes is stamped with the run's own
// time, so the assertions below name it exactly.
const NOW = Date.parse('2026-07-05T09:15:00.000Z');
const LATER = NOW + 15 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const MEALS_URL = 'https://meals.example/api/internal/metrics';
const NOM_URL = 'https://nosh.example/api/internal/metrics';

const MEALS_CARDS = [
  { metric: 'signups', counter: 'profiles', label: 'Users' },
  { metric: 'leads', counter: 'leads', label: 'Leads' },
];

/** The shipped shape: one fast-lane property with two cards. */
const CONFIG: CountersConfig = {
  assets: {
    'meals.example': {
      source: { kind: 'prometheus', url: MEALS_URL, enabled: true },
      cards: MEALS_CARDS,
    },
  },
};

/** meals.example's scrape body — the two configured counters plus unrelated tables. */
function mealsBody(profiles: number, leads: number): string {
  return promBody({
    profiles: { total: profiles, h24: 12, d7: 80 },
    leads: { total: leads, h24: 3, d7: 20 },
    saved_recipes: { total: 900, h24: 2, d7: 15 },
  });
}

interface Reading {
  metric: string;
  value: number;
  observed_at: string;
}

/** Every stored reading for an asset, metric-ordered so assertions are stable:
 * read on Postgres, the value as a number and the instant as the lane wrote it. */
async function readings(asset: string): Promise<Reading[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ metric: string; value: bigint; observed_at: string }>(
      `SELECT metric, value, observed_at FROM noticeos.counter_readings WHERE asset_id = $1 ORDER BY metric COLLATE "C"`,
      [asset],
    ),
  );
  return rows.map((row) => ({ metric: row.metric, value: Number(row.value), observed_at: javascriptInstant(row.observed_at) }));
}

/** How many readings the store holds, for every site. */
async function readingCount(): Promise<number> {
  const [row] = await env.STORE.read((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM noticeos.counter_readings'));
  return row?.n ?? 0;
}

describe('counters lane — a successful read', () => {
  it('writes one row per configured card, valued from d1_row_count', async () => {
    const result = await runCountersScrape(env, {
      config: CONFIG,
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEALS_URL]: () => new Response(mealsBody(5000, 620), { status: 200 }) }),
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({ asset: 'meals.example', ok: true, written: 2 });

    // the ENVELOPE metric name is the key, not the source counter ("profiles")
    expect(await readings('meals.example')).toEqual([
      { metric: 'leads', value: 620, observed_at: iso(NOW) },
      { metric: 'signups', value: 5000, observed_at: iso(NOW) },
    ]);
  });

  it('updates in place — one row per (asset,metric), with the newer clock', async () => {
    await runCountersScrape(env, {
      config: CONFIG,
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEALS_URL]: () => new Response(mealsBody(5000, 620), { status: 200 }) }),
    });
    await runCountersScrape(env, {
      config: CONFIG,
      nowMs: LATER,
      fetchImpl: stubFetch({ [MEALS_URL]: () => new Response(mealsBody(5007, 621), { status: 200 }) }),
    });

    // current state, not history: the second read REPLACED the first
    expect(await readings('meals.example')).toEqual([
      { metric: 'leads', value: 621, observed_at: iso(LATER) },
      { metric: 'signups', value: 5007, observed_at: iso(LATER) },
    ]);
  });

  // The lane's hard boundary: it is a cache refresh, not a report. A 15-minute
  // lane that wrote pulses would forge 96 nightly reports a day; one that wrote
  // flags would alert 96 times per outage.
  it('writes counter_readings and nothing else — no pulses, no flags', async () => {
    await runCountersScrape(env, {
      config: CONFIG,
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEALS_URL]: () => new Response(mealsBody(5000, 620), { status: 200 }) }),
    });

    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.pulses`)).toBe(0);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags`)).toBe(0);
  });
});

describe('counters lane — failure leaves the prior reading alone', () => {
  // The load-bearing honesty test. The card's age badge is the ONLY staleness
  // signal, so a failed read must not re-stamp observed_at — a stale number
  // wearing a fresh timestamp is the one thing an operator cannot detect.
  it('leaves value AND observed_at untouched when the endpoint 500s', async () => {
    await runCountersScrape(env, {
      config: CONFIG,
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEALS_URL]: () => new Response(mealsBody(5000, 620), { status: 200 }) }),
    });

    const result = await runCountersScrape(env, {
      config: CONFIG,
      nowMs: LATER,
      fetchImpl: stubFetch({ [MEALS_URL]: () => new Response('nope', { status: 500 }) }),
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(result.outcomes[0]).toMatchObject({ ok: false, status: 500, written: 0 });
    // the FIRST run's values and the FIRST run's clock — a stale number must
    // never wear a fresh timestamp
    expect(await readings('meals.example')).toEqual([
      { metric: 'leads', value: 620, observed_at: iso(NOW) },
      { metric: 'signups', value: 5000, observed_at: iso(NOW) },
    ]);
    // and still no alert lane of its own — the nightly pull owns that
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags`)).toBe(0);
  });

  it('fails the WHOLE property on one missing counter, without touching another property', async () => {
    const twoAssets: CountersConfig = {
      assets: {
        // the failing property first, so a thrown failure would abort the other
        'meals.example': CONFIG.assets['meals.example']!,
        'nosh.example': {
          source: { kind: 'prometheus', url: NOM_URL, enabled: true },
          cards: [{ metric: 'receiptsHosted', counter: 'receipts', label: 'Receipts' }],
        },
      },
    };

    const result = await runCountersScrape(env, {
      config: twoAssets,
      nowMs: NOW,
      fetchImpl: stubFetch({
        // `profiles` is readable, `leads` is absent — the readable card must NOT
        // be written on its own (no half-refreshed card set under one badge).
        [MEALS_URL]: () =>
          new Response(promBody({ profiles: { total: 5000, h24: 12, d7: 80 } }), { status: 200 }),
        [NOM_URL]: () =>
          new Response(promBody({ receipts: { total: 13084, h24: 41, d7: 300 } }), { status: 200 }),
      }),
    });

    expect(result).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
    expect(result.outcomes[0]).toMatchObject({ asset: 'meals.example', ok: false, written: 0 });
    expect(result.outcomes[0]?.error).toContain('no d1_row_count for table "leads"');

    expect(await readings('meals.example')).toEqual([]);
    expect(await readings('nosh.example')).toEqual([
      { metric: 'receiptsHosted', value: 13084, observed_at: iso(NOW) },
    ]);
  });

  it('fails on a non-integer total rather than coercing it', async () => {
    const result = await runCountersScrape(env, {
      config: CONFIG,
      nowMs: NOW,
      fetchImpl: stubFetch({
        [MEALS_URL]: () =>
          new Response(promBody({ profiles: { total: 5000.5, h24: 12, d7: 80 }, leads: { total: 620, h24: 3, d7: 20 } }), {
            status: 200,
          }),
      }),
    });

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.outcomes[0]?.error).toContain('not a row count');
    expect(await readings('meals.example')).toEqual([]);
  });

  it('reports a missing pull token as a clean outcome error, writing nothing', async () => {
    // areas.example is a seeded asset with no ASSET_TOKENS entry.
    const result = await runCountersScrape(env, {
      config: {
        assets: {
          'areas.example': {
            source: { kind: 'prometheus', url: 'https://areas.example/api/internal/metrics', enabled: true },
            cards: [{ metric: 'signups', counter: 'profiles', label: 'Users' }],
          },
        },
      },
      nowMs: NOW,
      // throws if a fetch is attempted — the token is checked before the request
      fetchImpl: stubFetch({}),
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(result.outcomes[0]).toMatchObject({ ok: false, status: null, written: 0 });
    expect(result.outcomes[0]?.error).toContain('no pull token');
    expect(await readings('areas.example')).toEqual([]);
  });
});

describe('counters lane — what it skips', () => {
  it('never fetches a property with no source or a paused lane', async () => {
    const result = await runCountersScrape(env, {
      config: {
        assets: {
          // no source: these cards ride the nightly report instead
          'nosh.example': { cards: [{ metric: 'receiptsHosted', label: 'Receipts' }] },
          // paused: the cards stand, fed by the nightly report again
          'meals.example': {
            source: { kind: 'prometheus', url: MEALS_URL, enabled: false },
            cards: MEALS_CARDS,
          },
        },
      },
      nowMs: NOW,
      // throws on ANY fetch, so a skipped property proves it was never attempted
      fetchImpl: stubFetch({}),
    });

    expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0, outcomes: [] });
    expect(await readingCount()).toBe(0);
  });
});
