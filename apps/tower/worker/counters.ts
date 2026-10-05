// Counters resolution — which number each of an asset's total cards actually
// shows, and how old that number is. Split out of the payload builders because
// the resolution is a rule, not a query: freshest lane wins, in config order.
// The Wall and Overview share the rule, pure over injected rows.

import {
  SCHEDULED_JOBS,
  cronIntervalMinutes,
  scheduleFor,
  type ScheduleOverrides,
} from "../../../scripts/scheduled-jobs.mjs";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import type { CounterCard, WallCounters } from "../shared/wall";
import { humanizeMetric } from "../shared/alert-language";

/** config/counters.json as the Tower reads it — a local, looser mirror of the
 * file carrying only what the payload needs. The scrape half (`source`, and each
 * card's `counter`) is the ingest lane's business; the Tower reads it for nothing
 * and so types it loosely. An asset with no entry here declares no cards. */
export interface CountersConfigCard {
  /** Envelope metric name — the key a counter reading and the pulse share. */
  metric: string;
  counter?: string;
  label: string;
}

export interface CountersConfigEntry {
  source?: { kind: string; url: string; enabled: boolean };
  /** Human-readable grain shared by this asset's configured cards. */
  heading?: string;
  cards: CountersConfigCard[];
}

export interface CountersConfig {
  assets: Record<string, CountersConfigEntry>;
}

/** One `counter_readings` row (the 15-minute fast lane's current state). */
export interface CounterReading {
  metric: string;
  value: number;
  observedAt: string;
}

/** The nightly fallback's raw material: the asset's LATEST report envelope
 * `metrics` map and that report's received_at (the age such a card carries). */
export interface NightlyTotals {
  metrics: Record<string, { total?: unknown } | undefined>;
  receivedAt: string | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const COUNTERS_JOB = SCHEDULED_JOBS.find((job) => job.id === "counters")!;

/** EFFECTIVE cadence the age badges amber against: the longest wait between two
 * runs of the counters job as it is scheduled — its saved schedule, else its
 * default (bead ro-ujb9.222). The schedule is the one place the cadence is
 * written, so a schedule changed in Settings moves the badges with it. */
export function countersCadenceHours(schedules: ScheduleOverrides | null): number {
  return (cronIntervalMinutes(scheduleFor(COUNTERS_JOB, schedules ?? {}).cron) ?? cronIntervalMinutes(COUNTERS_JOB.cron)!) / 60;
}

/** A `counter_readings` row as Postgres returns it: `value` is int8. */
type CounterRow = {
  asset: string;
  metric: string;
  value: bigint;
  observedAt: string;
};

/** Every counter reading in the store, grouped asset → metric → row. One query
 * for the whole portfolio: the table is current-state (one row per asset+metric),
 * so it is bounded by the config, not by time. `asset` narrows the same query to
 * one site (its Overview, bead `ro-trai.21`). Read on Postgres
 * (`noticeos.counter_readings`, bead ro-ujb9.76.5.1): a value is a count, exact
 * as a number far past any site's total, and a reading's instant leaves in the
 * form the ingest wrote it. */
export async function readCounterReadings(
  store: WorkspaceStore,
  asset?: string,
): Promise<Map<string, Map<string, CounterReading>>> {
  const query = `SELECT asset_id AS asset, metric, value, observed_at AS "observedAt" FROM noticeos.counter_readings`;
  const rows = await store.read((tx) =>
    asset === undefined
      ? tx.query<CounterRow>(query)
      : tx.query<CounterRow>(`${query} WHERE asset_id = $1`, [asset]),
  );

  const byAsset = new Map<string, Map<string, CounterReading>>();
  for (const r of rows) {
    const forAsset = byAsset.get(r.asset) ?? new Map<string, CounterReading>();
    forAsset.set(r.metric, { metric: r.metric, value: Number(r.value), observedAt: javascriptInstant(r.observedAt) });
    byAsset.set(r.asset, forAsset);
  }
  return byAsset;
}

/** One index seek per asset, one portfolio round trip. The newest report DATE
 * and its current revision match Overview; a late backfill is not a new total.
 * No prior envelope is read to fill a metric missing from the latest report. */
export const LATEST_COUNTER_TOTALS_SQL = `SELECT a.asset_id AS asset,
       p.received_at AS "receivedAt", p.envelope::text AS envelope
  FROM noticeos.assets a
  JOIN LATERAL (
    SELECT p.received_at, p.envelope FROM noticeos.current_pulses p
     WHERE p.workspace_id = a.workspace_id AND p.asset_id = a.asset_id
     ORDER BY p.pulse_date DESC LIMIT 1
  ) p ON true`;

export async function readLatestCounterTotals(store: WorkspaceStore): Promise<Map<string, NightlyTotals>> {
  const rows = await store.read((tx) => tx.query<{ asset: string; receivedAt: string; envelope: string }>(LATEST_COUNTER_TOTALS_SQL));
  return new Map(rows.map((row) => {
    let metrics: NightlyTotals["metrics"] = {};
    try {
      const envelope = JSON.parse(row.envelope) as { metrics?: unknown } | null;
      if (envelope?.metrics && typeof envelope.metrics === "object" && !Array.isArray(envelope.metrics)) {
        metrics = envelope.metrics as NightlyTotals["metrics"];
      }
    } catch {
      // A malformed historical envelope supplies no totals.
    }
    return [row.asset, { metrics, receivedAt: javascriptInstant(row.receivedAt) }];
  }));
}

/** Discover only observed count totals, never daily values or provider data.
 * Saved labels/order remain authoritative; extra choices have no default. */
export function resolveWallCounters(
  configured: CountersConfigEntry | undefined,
  readings: Map<string, CounterReading> | undefined,
  nightly: NightlyTotals,
  cadenceHours: number,
): WallCounters {
  const cards = configured?.cards ?? [];
  const selected = new Set(cards.map((card) => card.metric));
  const count = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
  const available = new Set<string>();
  for (const [metric, reading] of readings ?? []) if (count(reading.value)) available.add(metric);
  for (const [metric, entry] of Object.entries(nightly.metrics)) if (count(entry?.total)) available.add(metric);
  const discovered = [...available].filter((metric) => !selected.has(metric)).sort().map((metric) => {
    const words = humanizeMetric(metric);
    return { metric, label: words.charAt(0).toUpperCase() + words.slice(1) };
  });
  return {
    heading: configured?.heading?.trim() || "All-time totals",
    cadenceHours,
    cards: resolveCounterCards([...cards, ...discovered], readings, nightly),
    defaultMetrics: cards.map((card) => card.metric),
  };
}

/** Milliseconds for a stored stamp, or null when it cannot be read as a time —
 * an unreadable stamp proves nothing about freshness and must not win a lane. */
function timeOf(at: string | null): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

/** Resolve one asset's configured cards, IN CONFIG ORDER, against the freshest
 * lane that carries each metric: a `counter_readings` row (the 15-minute fast
 * lane) or the latest nightly report's own `metrics[metric].total`. When both
 * lanes carry the metric the NEWER stamp owns the card, so a nightly report
 * collected after the last successful scrape is not shadowed by a stale reading;
 * ties go to the fast lane. Freshness decides, never magnitude — last night's
 * larger total is still last night's number.
 *
 * A lane only enters that comparison when its number can actually be READ. An
 * unparseable `counter_readings` value is an absent reading, not a fresh one, so
 * the nightly total keeps the card and only that one metric degrades (ro-kvk).
 * The store's column is a non-negative bigint, so such a value does not come
 * from the store — but the rows arrive injected, and `num()` here already
 * conceded the possibility before the comparison respected it.
 *
 * Returns [] when the asset declares no cards; the card then simply has no
 * totals row (see AssetCard.counters). */
export function resolveCounterCards(
  configured: CountersConfigCard[] | undefined,
  readings: Map<string, CounterReading> | undefined,
  nightly: NightlyTotals,
): CounterCard[] {
  // Tolerates a stubbed entry with no `cards` key at all: a malformed line in a
  // hand-edited config must not break the whole portfolio payload.
  if (!configured || configured.length === 0) return [];

  return configured.map(({ metric, label }): CounterCard => {
    const stored = readings?.get(metric);
    const scraped = stored ? num(stored.value) : null;
    // A reading whose value does not parse is an ABSENT reading for this metric,
    // not a fresher one, so it is dropped BEFORE the freshness comparison below.
    // Freshness decides between two readable lanes; letting an unreadable row
    // win the lane blanked a card the nightly report could still fill (ro-kvk).
    // The metric is resolved alone, so this degrades that one reading and never
    // touches the asset's other cards.
    const fast = stored && scraped !== null ? { value: scraped, observedAt: stored.observedAt } : null;
    const total = num(nightly.metrics[metric]?.total);
    const nightlyAt = total !== null ? nightly.receivedAt : null;

    const fromCounters = (r: { value: number; observedAt: string }): CounterCard => ({
      metric,
      label,
      value: r.value,
      observedAt: r.observedAt,
      source: "counters",
    });
    const fromNightly = (value: number, at: string): CounterCard => ({
      metric,
      label,
      value,
      observedAt: at,
      source: "nightly",
    });

    if (fast && total !== null && nightlyAt) {
      // -Infinity for an unreadable stamp: the lane that can prove its age wins,
      // and two unreadable stamps fall back to the fast lane.
      return (timeOf(fast.observedAt) ?? -Infinity) >= (timeOf(nightlyAt) ?? -Infinity)
        ? fromCounters(fast)
        : fromNightly(total, nightlyAt);
    }
    if (fast) return fromCounters(fast);
    if (total !== null && nightlyAt) return fromNightly(total, nightlyAt);
    // Nothing readable in either lane: the card states its own absence — no
    // number, no age, no source — rather than showing a figure it cannot back.
    return { metric, label, value: null, observedAt: null, source: null };
  });
}
