// The COUNTERS lane — the 15-minute fast read of a property's own totals
// (config/counters.json, table `noticeos.counter_readings` on Postgres, bead
// ro-ujb9.76.5.1; docs/06 "Where config lives").
//
// The nightly pull already carries every metric's all-time `total` once a day.
// This lane exists only to make the handful of totals an operator watches on the
// property page *fresh*, so it does the smallest possible thing:
//
//   INVARIANT — it writes `counter_readings` and NOTHING else. It never writes
//   `pulses` and never writes `flags`. The nightly report stays the single
//   durable record of a day's numbers, and a 15-minute lane that could raise
//   alerts would raise them 96×/day.
//
//   INVARIANT — it is not an alerting lane. A failed scrape leaves the previous
//   reading ENTIRELY untouched (value AND observed_at), so the card's age badge
//   ambers on its own at 2× the interval: staleness is the signal, and it is a
//   fact the reader can re-derive from the clock rather than an assertion the OS
//   has to keep true. A persistent endpoint outage is still alerted within 24h
//   by the nightly pull's `asset-pull-failed` flag — same endpoint, same token,
//   so there is nothing this lane would catch that that one misses.
//
//   INVARIANT — writes are all-or-nothing per property per run. One unreadable
//   counter fails that property's whole refresh; a half-refreshed card set would
//   put two different moments under one age badge. Other properties are
//   unaffected (per-entry try/catch, like the nightly pull's `pullOne`).

import { fetchScrape, parsePrometheus, tokenFor, totalFor } from './pull.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import countersConfigJson from '../../../config/counters.json';

/** One big-number card: which envelope metric, and where its total is read from. */
export interface CounterCardConfig {
  /** envelope metric name — the join key, not the source counter's name. */
  metric: string;
  /** source counter (the Prometheus `table` label); required for a prometheus source. */
  counter?: string;
  /** operator copy, rendered verbatim on the card. */
  label: string;
}

/** A Prometheus text endpoint exposing `d1_row_count{table="<counter>"}`. */
export interface PrometheusCounterSource {
  kind: 'prometheus';
  url: string;
  enabled: boolean;
}

/** One property's counters config. No `source` = its cards ride the nightly report. */
export interface CounterAssetConfig {
  source?: PrometheusCounterSource;
  cards: CounterCardConfig[];
}

export interface CountersConfig {
  /** How often the lane reads is the counters job's schedule
   * (scripts/scheduled-jobs.mts), not this file. */
  assets: Record<string, CounterAssetConfig>;
}

const COUNTERS_CONFIG = countersConfigJson as CountersConfig;

export interface CounterAssetOutcome {
  asset: string;
  ok: boolean;
  status: number | null;
  /** rows upserted this run — 0 on any failure, since writes are all-or-nothing. */
  written: number;
  error?: string;
}

export interface CountersScrapeResult {
  attempted: number;
  succeeded: number;
  failed: number;
  /** the one moment this run stamps on every row it writes. */
  observedAt: string;
  outcomes: CounterAssetOutcome[];
}

export interface CountersOptions {
  /** Override the built-in config/counters.json (tests inject their own). */
  config?: CountersConfig;
  /** Override the outbound fetcher (tests stub the scrape responses). */
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** Where this run's config came from, per file — resolved once per cron fire
   * in dispatch.ts and reported on the completion line below (`ro-syok.7`). */
  configSources?: ConfigSourceMap;
}

/** A property this run will actually fetch: it has an enabled source and cards. */
interface ScrapableAsset {
  asset: string;
  source: PrometheusCounterSource;
  cards: CounterCardConfig[];
}

/**
 * Read one property's counters and upsert its readings; never throws. Every card
 * is resolved to a value BEFORE anything is written, so a failure anywhere in
 * the set leaves the property's stored readings exactly as they were.
 */
async function scrapeAsset(
  env: IngestEnv,
  { asset, cards, source }: ScrapableAsset,
  observedAt: string,
  fetchImpl: typeof fetch,
): Promise<CounterAssetOutcome> {
  let status: number | null = null;
  try {
    const token = tokenFor(env.ASSET_TOKENS, asset);
    if (!token) throw new Error('no pull token configured for asset');

    const res = await fetchScrape(fetchImpl, source.url, token, 'text/plain');
    status = res.status;
    if (res.status !== 200) throw new Error(`non-200 response (${res.status})`);

    const samples = parsePrometheus(await res.text());
    const readings: Array<{ metric: string; value: number }> = [];
    for (const card of cards) {
      if (!card.counter) throw new Error(`card "${card.metric}" has no source counter`);
      const total = totalFor(samples, card.counter);
      if (total === undefined) throw new Error(`no d1_row_count for table "${card.counter}"`);
      // Number.isInteger also rejects NaN/Infinity. A fractional or negative
      // value means the wrong series is being read, so it fails here in words
      // naming the counter, rather than as a type or CHECK error out of the store.
      if (!Number.isInteger(total) || total < 0) {
        throw new Error(`d1_row_count for table "${card.counter}" is not a row count: ${total}`);
      }
      readings.push({ metric: card.metric, value: total });
    }

    // One transaction for the property's whole set (the all-or-nothing
    // invariant above), one statement per card in config order, as the D1
    // batch ran them: a card listed twice is written twice and the later wins.
    await env.STORE.write(async (tx) => {
      for (const r of readings) {
        await tx.execute(
          `INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz)
           ON CONFLICT (workspace_id, asset_id, metric) DO UPDATE SET
             value       = excluded.value,
             observed_at = excluded.observed_at`,
          [tx.workspaceId, asset, r.metric, r.value, observedAt],
        );
      }
    });
    return { asset, ok: true, status, written: readings.length };
  } catch (err) {
    return {
      asset,
      ok: false,
      status,
      written: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// The quarter-hourly counters cron (COUNTERS_CRON in src/index.ts). Reads every
// property whose fast lane is configured and enabled, independently: one
// property's failure is recorded in its outcome and never touches another's
// readings.
export async function runCountersScrape(
  env: IngestEnv,
  opts: CountersOptions = {},
): Promise<CountersScrapeResult> {
  const config = opts.config ?? COUNTERS_CONFIG;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // One timestamp for the whole run: the readings it writes are one observation
  // of the portfolio, and the Tower ages them all against the same interval.
  const observedAt = new Date(opts.nowMs ?? Date.now()).toISOString();

  // Skipped, never fetched: a property with no `source` (its cards are fed by
  // its nightly report instead), a paused lane, or nothing to read.
  const scrapable = Object.entries(config.assets).flatMap(([asset, entry]) =>
    entry.source?.enabled === true && entry.cards.length > 0
      ? [{ asset, source: entry.source, cards: entry.cards }]
      : [],
  );

  const outcomes: CounterAssetOutcome[] = [];
  for (const entry of scrapable) {
    outcomes.push(await scrapeAsset(env, entry, observedAt, fetchImpl));
  }
  const succeeded = outcomes.filter((o) => o.ok).length;
  const result = {
    attempted: scrapable.length,
    succeeded,
    failed: outcomes.length - succeeded,
    observedAt,
    outcomes,
  };
  // ONE COMPLETION LINE, and the reason it exists is `configSource` (bead
  // `ro-syok.7`): which totals each property's cards show moved into the store,
  // and a run that cannot say which of the two it read leaves an operator to
  // infer it from behaviour. Counts and asset ids only.
  console.log(
    JSON.stringify({
      event: 'counters_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
      ...configSourceLine(opts.configSources, ['config/counters.json']),
      errors: outcomes
        .filter((outcome) => !outcome.ok)
        .map(({ asset, status }) => ({ asset, status })),
    }),
  );
  return result;
}
