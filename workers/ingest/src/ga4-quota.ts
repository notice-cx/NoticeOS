// GA4 Data API quota, on the lanes that spend it. The Data API meters every
// request in tokens, per property, per day and per hour, so a call count
// never answers "how close are we to the ceiling"; `returnPropertyQuota: true`
// on the request body does. Not a meter of its own: it reports what the
// provider said about the call just made, and raises one flag when the
// remaining share of a bucket crosses a line.

import type { Ga4PropertyQuota, Ga4QuotaStatus } from '@noticeos/contract';
import { appendReadingToOpen, holdCondition, raiseAlertUnlessOpen, readOpenAlert, resolveOpen } from './alert-store.js';
import { asRecord } from './shared.js';

/**
 * The flag a quota crunch raises, on the property whose budget is thin, because
 * the budget is per property.
 */
export const GA4_QUOTA_RULE_ID = 'ga4-quota-pressure';

/**
 * The error code a quota-exhausted response gets, instead of the generic 429
 * a rate limit produces, so a manifest tells "we ran out of budget" from
 * "Google was busy".
 */
export const GA4_QUOTA_EXHAUSTED_CODE = 'ga4_quota_exhausted';

/**
 * Below this share of a bucket still remaining, the lane raises the flag. A
 * working margin, not a cliff: at 15-minute cadence a property has roughly
 * three hours of collection left at 20% of a daily bucket. The flag exists to
 * be seen before the failures.
 */
export const QUOTA_PRESSURE_RATIO = 0.2;

/** Which lane spent the tokens, carried into the flag so the fix is obvious. */
export type Ga4QuotaLane = 'signal-dumps' | 'google-signals';

/**
 * The buckets a request reports back. A missing or unusable field stays
 * `null` rather than a reassuring zero: "the provider did not say" and
 * "nothing is left" are opposite facts.
 */
export function parseGa4PropertyQuota(record: unknown): Ga4PropertyQuota | null {
  const quota = asRecord(asRecord(record)?.propertyQuota);
  if (!quota) return null;
  const tokensPerDay = parseQuotaStatus(quota.tokensPerDay);
  const tokensPerHour = parseQuotaStatus(quota.tokensPerHour);
  if (!tokensPerDay && !tokensPerHour) return null;
  return { tokensPerDay, tokensPerHour };
}

function parseQuotaStatus(value: unknown): Ga4QuotaStatus | null {
  const status = asRecord(value);
  if (!status) return null;
  const consumed = quotaCount(status.consumed);
  const remaining = quotaCount(status.remaining);
  return consumed === null && remaining === null ? null : { consumed, remaining };
}

function quotaCount(value: unknown): number | null {
  // The Data API serializes these int32 buckets as JSON numbers.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** One bucket's headroom, as the flag and the log report it. */
export interface QuotaBucketPressure {
  bucket: 'tokensPerDay' | 'tokensPerHour';
  consumed: number;
  remaining: number;
  /** `remaining / (consumed + remaining)`, rounded to three places. */
  share: number;
}

/**
 * The buckets whose remaining share has crossed {@link QUOTA_PRESSURE_RATIO}. A
 * bucket reported only partially is skipped: the share would be a number we
 * made up. An empty result means "nothing we could measure is under pressure".
 */
export function quotaPressure(quota: Ga4PropertyQuota | null): QuotaBucketPressure[] {
  if (!quota) return [];
  const pressured: QuotaBucketPressure[] = [];
  for (const bucket of ['tokensPerDay', 'tokensPerHour'] as const) {
    const status = quota[bucket];
    if (!status || status.consumed === null || status.remaining === null) continue;
    const total = status.consumed + status.remaining;
    if (total <= 0) continue;
    const share = Math.round((status.remaining / total) * 1000) / 1000;
    if (share <= QUOTA_PRESSURE_RATIO) {
      pressured.push({ bucket, consumed: status.consumed, remaining: status.remaining, share });
    }
  }
  return pressured;
}

/**
 * Did the provider refuse this call because the property is out of tokens? A
 * 429 alone is not enough: the Data API also returns it for concurrent-request
 * limits, which recover on their own. `RESOURCE_EXHAUSTED`, or an explicit
 * quota mention in the message, distinguishes the two.
 */
export function isQuotaExhausted(status: number, body: unknown): boolean {
  if (status !== 429) return false;
  const error = asRecord(asRecord(body)?.error);
  const providerStatus = typeof error?.status === 'string' ? error.status : '';
  if (providerStatus === 'RESOURCE_EXHAUSTED') return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /quota|token/i.test(message);
}

export interface Ga4QuotaRecord {
  asset: string;
  lane: Ga4QuotaLane;
  propertyRef: string;
  quota: Ga4PropertyQuota | null;
  /** ISO instant of the run this quota came back with. */
  at: string;
}

export interface Ga4QuotaWrite {
  fired: number;
  refreshed: number;
  resolved: number;
}

/**
 * Record what a run cost: always a structured log line, and a flag while a
 * bucket is under pressure. The flag is an ongoing condition: the first
 * observation inserts, every later one becomes the open alert's newest reading
 * so an operator reads the current headroom, while `fired_at` keeps dating the
 * onset. A reading back above the line resolves it, because buckets refill. A
 * run that reported no usable quota resolves nothing: silence is not recovery.
 */
export async function recordGa4Quota(
  env: IngestEnv,
  input: Ga4QuotaRecord,
): Promise<Ga4QuotaWrite> {
  const { asset, lane, propertyRef, quota, at } = input;
  const pressured = quotaPressure(quota);

  console.log(
    JSON.stringify({
      event: 'ga4_quota',
      lane,
      asset,
      propertyRef,
      measured: quota !== null,
      tokensPerDay: quota?.tokensPerDay ?? null,
      tokensPerHour: quota?.tokensPerHour ?? null,
      pressured: pressured.map((entry) => entry.bucket),
    }),
  );

  if (pressured.length === 0) {
    // Only a measured healthy reading retracts.
    if (quota === null) return { fired: 0, refreshed: 0, resolved: 0 };
    const resolved = await env.STORE.write((tx) => resolveOpen(tx, asset, GA4_QUOTA_RULE_ID, at));
    return { fired: 0, refreshed: 0, resolved };
  }

  const tightest = pressured.reduce((low, entry) => (entry.share < low.share ? entry : low));
  // The headline with its values; the inputs below carry the rest.
  const message =
    `GA4 ${tightest.bucket === 'tokensPerHour' ? 'hourly' : 'daily'} quota at ` +
    `${Math.round(tightest.share * 100)}% for ${propertyRef}`;

  // One transaction holds the condition: read the open alert as its newest
  // reading states it, then raise one or append this reading.
  return env.STORE.write(async (tx) => {
    await holdCondition(tx, asset, GA4_QUOTA_RULE_ID);
    const open = await readOpenAlert(tx, asset, GA4_QUOTA_RULE_ID);

    const inputs = JSON.stringify({
      rule: GA4_QUOTA_RULE_ID,
      lane,
      propertyRef,
      observations: priorObservations(open?.ruleInputs) + 1,
      lastObservedAt: at,
      threshold_ratio: QUOTA_PRESSURE_RATIO,
      tokensPerDay: quota?.tokensPerDay ?? null,
      tokensPerHour: quota?.tokensPerHour ?? null,
      pressured,
    });

    if (open) {
      const refreshed = await appendReadingToOpen(tx, asset, GA4_QUOTA_RULE_ID, {
        observedAt: null,
        severity: 'warn',
        message,
        ruleInputs: inputs,
      });
      return { fired: 0, refreshed, resolved: 0 };
    }

    const flagId = await raiseAlertUnlessOpen(tx, {
      asset,
      firedAt: at,
      severity: 'warn',
      kind: 'anomaly',
      metric: 'ga4-quota',
      message,
      ruleId: GA4_QUOTA_RULE_ID,
      ruleInputs: inputs,
    });
    return { fired: flagId === null ? 0 : 1, refreshed: 0, resolved: 0 };
  });
}

function priorObservations(ruleInputs: string | null | undefined): number {
  if (!ruleInputs) return 0;
  try {
    const previous = JSON.parse(ruleInputs) as { observations?: unknown };
    return typeof previous.observations === 'number' && Number.isFinite(previous.observations)
      ? previous.observations
      : 0;
  } catch {
    return 0;
  }
}
