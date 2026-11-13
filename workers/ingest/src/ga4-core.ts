import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import { ga4RateLimitKind, ga4RetryAfter } from './ga4-read-errors.js';
import { asRecord, stringField } from './shared.js';
import { boundedResponseJson, normalizeSignalError, SignalError } from './signal-store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const QUOTA_DAY_OFFSET = 8 * HOUR;
const leaseKey = (property: string) => `ga4-core-quota:${property}`;

export const GA4_CORE_BACKOFF_CODE = 'ga4_core_quota_backoff';

export class Ga4CoreDeferred extends SignalError {
  constructor(readonly nextAttemptAt: string) {
    super(GA4_CORE_BACKOFF_CODE, 'GA4 reporting is paused after a quota refusal for this property.');
  }
}

export async function ga4CoreCooldown(store: WorkspaceStore, property: string, nowMs: number): Promise<string | null> {
  const [row] = await store.read(tx => tx.query<{ cooldown_until: string }>(
    'SELECT cooldown_until FROM noticeos.integration_leases WHERE lease_key = $1 AND cooldown_until > $2::timestamptz',
    [leaseKey(property), new Date(nowMs)]));
  return row ? javascriptInstant(row.cooldown_until) : null;
}

export async function readGa4CoreReport(store: WorkspaceStore, property: string, fetchImpl: typeof fetch,
  init: RequestInit, options: { lane: string; maxBytes: number; clock: () => number }): Promise<{ response: Response; body: unknown }> {
  const { lane, maxBytes, clock } = options;
  const cooling = await ga4CoreCooldown(store, property, clock());
  if (cooling) throw new Ga4CoreDeferred(cooling);
  const startedAt = clock();
  let response: Response | undefined;
  let body: unknown;
  try {
    response = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`, init);
    body = await boundedResponseJson(response, 'Google', maxBytes, { refusalMayBeText: true });
  } catch (error) {
    if (normalizeSignalError(error, '').code === 'request_timeout') {
      console.warn(JSON.stringify({ event: 'ga4_core_timeout', lane, property,
        stage: response ? 'response_body' : 'response_headers', status: response?.status, elapsedMs: clock() - startedAt }));
    }
    // The status is still evidence when reading the refusal's body times out.
    if (response?.status === 429) await recordCooldown(store, property, response, null, clock(), lane);
    throw error;
  }
  if (response.status === 429) await recordCooldown(store, property, response, body, clock(), lane);
  return { response, body };
}

async function recordCooldown(store: WorkspaceStore, property: string, response: Response, body: unknown, now: number, lane: string): Promise<void> {
  const kind = ga4RateLimitKind(stringField(asRecord(asRecord(body)?.error), 'message') ?? '');
  // Daily GA4 quotas reset at midnight PST. Hourly quotas refill within an hour.
  const fallback = kind === 'daily-tokens' || kind === 'daily-requests'
    ? (Math.floor((now - QUOTA_DAY_OFFSET) / DAY) + 1) * DAY + QUOTA_DAY_OFFSET
    : now + (kind === 'concurrency' || kind === 'requests-per-minute' || kind === 'requests-per-second' ? 5 * 60_000 : HOUR);
  const until = new Date(ga4RetryAfter(response, now) ?? fallback);
  await store.write(tx => tx.execute(
    `INSERT INTO noticeos.integration_leases AS l (workspace_id, lease_key, owner, expires_at, cooldown_until, last_error)
      VALUES ($1::uuid, $2, 'ga4-core', 'epoch', $3::timestamptz, $4)
      ON CONFLICT (workspace_id, lease_key) DO UPDATE SET cooldown_until = excluded.cooldown_until, last_error = excluded.last_error
      WHERE l.cooldown_until IS NULL OR l.cooldown_until < excluded.cooldown_until`,
    [tx.workspaceId, leaseKey(property), until, kind]));
  console.warn(JSON.stringify({ event: 'ga4_core_backoff', lane, property, kind, nextAttemptAt: until.toISOString() }));
}
