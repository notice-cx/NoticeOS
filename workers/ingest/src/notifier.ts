// Source transactions persist delivery intent. Delivery claims a bounded batch,
// rechecks current conditions, sends once, then commits receipts and completion.
// A provider acceptance followed by a process crash can still be delivered twice.
import {
  NOTIFICATION_CHANNEL, NOTIFIED_CONDITIONS, NOTIFY_BATCH_CAP, NOTIFY_WINDOW_HOURS,
  type NotifiedCondition, type ProbeResult, assetDisplayName, connectionState, integrationProviderCards, probeLine,
} from '@noticeos/contract';
import { listCredentialSummaries, recordCredentialOutcome, resolveCredential } from './credentials.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';

const NOTIFICATION_PROVIDER = 'discord';
const WEBHOOK_FIELD = 'DISCORD_WEBHOOK_URL';
const POST_TIMEOUT_MS = 10_000;

interface Candidate {
  eventId?: string;
  attempts?: number;
  condition: NotifiedCondition;
  subject: 'alert' | 'data-source';
  subjectRef: string;
  occurrence: string;
  line: string;
}
export interface NotifierResult {
  monitoringAvailable?: boolean;
  found: number;
  fresh: number;
  sent: number;
  skipped: null | 'nothing-to-say' | 'no-credential' | 'store-unavailable' | 'delivery-failed' | 'paused';
}
export interface NotifierOptions { nowMs?: number; fetchImpl?: typeof fetch; recover?: boolean }

// The same eligibility predicate cancels stale intent and chooses what to send.
// A later successful call closes a connection episode even if it failed again.
const ELIGIBLE = `(q.subject = 'alert' AND EXISTS (
  SELECT 1 FROM noticeos.current_flags f WHERE f.flag_number::text = q.subject_ref
    AND f.severity = 'error' AND f.disposition IS NULL AND f.resolved_at IS NULL
)) OR (q.subject = 'data-source' AND EXISTS (
  SELECT 1 FROM noticeos.integration_connections c WHERE c.connection_id = q.connection_id
    AND c.provider = q.subject_ref AND c.provider <> 'discord' AND c.last_error IS NOT NULL
    AND (c.last_ok_at IS NULL OR c.last_ok_at < q.occurred_at)
))`;

async function claim(env: IngestEnv, now: string, lease: string): Promise<Candidate[]> {
  const cutoff = new Date(Date.parse(now) - NOTIFY_WINDOW_HOURS * 3_600_000).toISOString();
  return env.STORE.write(async tx => {
    // A receipt written by the previous release also suppresses delivery.
    await tx.execute(`UPDATE noticeos.notification_outbox q SET state = 'sent', finished_at = n.sent_at,
      lease_id = NULL, lease_until = NULL FROM noticeos.notifications n
      WHERE q.state = 'pending' AND (q.lease_until IS NULL OR q.lease_until <= $1::timestamptz)
        AND n.channel = q.channel AND n.subject = q.subject
        AND n.subject_ref = q.subject_ref AND (n.occurrence = q.occurrence OR (
          q.subject = 'data-source' AND n.occurrence ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          AND n.sent_at >= q.occurred_at AND EXISTS (
            SELECT 1 FROM noticeos.integration_connections c WHERE c.connection_id = q.connection_id
              AND n.sent_at >= c.created_at)))`, [now]);
    await tx.execute(`UPDATE noticeos.notification_outbox q SET state = 'cancelled', finished_at = $1::timestamptz,
      lease_id = NULL, lease_until = NULL WHERE q.state = 'pending'
        AND (q.lease_until IS NULL OR q.lease_until <= $1::timestamptz)
        AND (q.occurred_at < $2::timestamptz OR NOT (${ELIGIBLE}))`, [now, cutoff]);
    const rows = await tx.query<{
      eventId: string; subject: 'alert' | 'data-source'; subjectRef: string; occurrence: string; attempts: number;
      asset: string | null; displayName: string | null; isOs: boolean | null;
      metric: string | null; message: string | null; ruleId: string | null; error: string | null;
    }>(`WITH due AS (
      SELECT event_id FROM noticeos.notification_outbox WHERE state = 'pending'
        AND next_attempt_at <= $1::timestamptz AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
      ORDER BY next_attempt_at, event_id FOR UPDATE SKIP LOCKED LIMIT $3
    ), claimed AS (
      UPDATE noticeos.notification_outbox q SET lease_id = $2::uuid,
        lease_until = $1::timestamptz + interval '2 minutes', attempts = attempts + 1
      FROM due WHERE q.event_id = due.event_id RETURNING q.*
    ) SELECT q.event_id::text AS "eventId", q.subject, q.subject_ref AS "subjectRef", q.occurrence, q.attempts,
      f.asset_id AS asset, a.display_name AS "displayName", a.is_os AS "isOs",
      f.metric, f.message, f.rule_id AS "ruleId", c.last_error AS error
      FROM claimed q
      LEFT JOIN noticeos.current_flags f ON q.subject = 'alert' AND f.flag_number::text = q.subject_ref
      LEFT JOIN noticeos.assets a ON a.asset_id = f.asset_id
      LEFT JOIN noticeos.integration_connections c ON q.subject = 'data-source' AND c.connection_id = q.connection_id`,
      [now, lease, NOTIFY_BATCH_CAP]);
    return rows.map(row => ({ ...row,
      condition: row.subject === 'alert' ? 'open-error' : 'source-failing',
      line: row.subject === 'alert'
        ? `${row.displayName === null ? row.asset : assetDisplayName(row.isOs === true ? 1 : 0, row.displayName)} — ${row.metric ?? row.ruleId}: ${row.message ?? row.ruleId}`
        : `${row.subjectRef} stopped working — ${row.error ?? 'no reason recorded'}`,
    }));
  });
}

/** Recovery repairs cutover or missed enqueue obligations without replaying receipts. */
async function recoverIntents(env: IngestEnv, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - NOTIFY_WINDOW_HOURS * 3_600_000).toISOString();
  await env.STORE.write(async tx => {
    await tx.execute(`INSERT INTO noticeos.notification_outbox
      (workspace_id, subject, subject_ref, occurrence, occurred_at, next_attempt_at)
      SELECT f.workspace_id, 'alert', f.flag_number::text, '', coalesce(e.observed_at, f.fired_at), $1::timestamptz
      FROM noticeos.current_flags f LEFT JOIN LATERAL (
        SELECT observed_at FROM noticeos.flag_evidence WHERE flag_id = f.flag_id ORDER BY observed_at DESC LIMIT 1
      ) e ON true WHERE f.severity = 'error' AND f.disposition IS NULL AND f.resolved_at IS NULL
        AND coalesce(e.observed_at, f.fired_at) >= $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM noticeos.notifications n WHERE n.channel = 'discord'
          AND n.subject = 'alert' AND n.subject_ref = f.flag_number::text AND n.occurrence = '')
      ON CONFLICT DO NOTHING`, [now, cutoff]);
    // Source row locks serialize repair with transitions and another repair;
    // the following statement observes their committed intent before inserting.
    await tx.query(`SELECT connection_id FROM noticeos.integration_connections
      WHERE provider <> 'discord' AND last_error IS NOT NULL ORDER BY connection_id FOR UPDATE`);
    await tx.execute(`INSERT INTO noticeos.notification_outbox
      (workspace_id, subject, subject_ref, occurrence, connection_id, occurred_at, next_attempt_at)
      SELECT c.workspace_id, 'data-source', c.provider, gen_random_uuid()::text, c.connection_id, c.last_used_at, $1::timestamptz
      FROM noticeos.integration_connections c WHERE c.provider <> 'discord' AND c.last_error IS NOT NULL
        AND c.last_used_at >= $2::timestamptz AND (c.last_ok_at IS NULL OR c.last_ok_at < c.last_used_at)
        AND NOT EXISTS (SELECT 1 FROM noticeos.notification_outbox q WHERE q.connection_id = c.connection_id
          AND (c.last_ok_at IS NULL OR q.occurred_at > c.last_ok_at))
        AND NOT EXISTS (SELECT 1 FROM noticeos.notifications n WHERE n.subject = 'data-source'
          AND n.channel = 'discord' AND n.subject_ref = c.provider
          AND n.sent_at >= coalesce(c.last_ok_at, c.created_at))`, [now, cutoff]);
  });
}

/** One leased batch. A second consumer cannot send these events concurrently. */
export async function runNotifier(env: IngestEnv, options: NotifierOptions = {}): Promise<NotifierResult> {
  const beganAt = Date.now();
  const nowMs = options.nowMs ?? beganAt;
  const now = new Date(nowMs).toISOString();
  const lease = crypto.randomUUID();
  let candidates: Candidate[];
  try {
    if (options.recover) await recoverIntents(env, now);
    candidates = await claim(env, now, lease);
    if (candidates.some(candidate => candidate.subject === 'data-source')) {
      const carded = new Set(integrationProviderCards().map(provider => provider.id));
      const summaries = await listCredentialSummaries(env);
      const failing = new Set(summaries.summaries.filter(summary => carded.has(summary.provider)
        && connectionState(summary) === 'failing').map(summary => String(summary.provider)));
      const excluded = candidates.filter(candidate => candidate.subject === 'data-source' && !failing.has(candidate.subjectRef));
      if (excluded.length) await env.STORE.write(tx => tx.execute(`UPDATE noticeos.notification_outbox
        SET state = 'cancelled', finished_at = $2::timestamptz, lease_id = NULL, lease_until = NULL
        WHERE lease_id = $1::uuid AND event_id = ANY($3::uuid[])`, [lease, now, excluded.map(candidate => candidate.eventId!)]));
      candidates = candidates.filter(candidate => !excluded.includes(candidate));
    }
  }
  catch { return { found: 0, fresh: 0, sent: 0, skipped: 'store-unavailable' }; }
  let count = candidates.length;
  if (!count) return { found: 0, fresh: 0, sent: 0, skipped: 'nothing-to-say' };
  const retry = async (delayMs: number, disconnected = false) => env.STORE.write(tx => tx.execute(
    `UPDATE noticeos.notification_outbox SET lease_id = NULL, lease_until = NULL,
       attempts = attempts - CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       next_attempt_at = $2::timestamptz WHERE lease_id = $1::uuid AND state = 'pending'`,
    [lease, new Date(nowMs + Date.now() - beganAt + delayMs).toISOString(), disconnected]));
  const credential = await resolveCredential(env, NOTIFICATION_PROVIDER);
  const webhook = credential.fields[WEBHOOK_FIELD];
  if (webhook === undefined || webhook.trim() === '') {
    await retry(60_000, true);
    return { found: count, fresh: count, sent: 0, skipped: 'no-credential' };
  }
  const health = await tryHealthConnection(env, 'discord', credential);
  // Credentials and monitoring can take time. Revalidate immediately before
  // sending, and renew only a lease this consumer still owns and has not lost.
  const sendingAt = new Date(nowMs + Date.now() - beganAt).toISOString();
  try {
    const held = await env.STORE.write(async tx => {
      await tx.execute(`UPDATE noticeos.notification_outbox q SET state = 'cancelled',
        finished_at = $2::timestamptz, lease_id = NULL, lease_until = NULL
        WHERE q.lease_id = $1::uuid AND NOT (${ELIGIBLE})`, [lease, sendingAt]);
      return tx.query<{ id: string }>(`UPDATE noticeos.notification_outbox SET
        lease_until = $2::timestamptz + interval '2 minutes'
        WHERE lease_id = $1::uuid AND state = 'pending' AND lease_until > $2::timestamptz
        RETURNING event_id::text AS id`, [lease, sendingAt]);
    });
    const ids = new Set(held.map(row => row.id));
    candidates = candidates.filter(candidate => ids.has(candidate.eventId!));
    count = candidates.length;
  } catch { return { found: count, fresh: count, sent: 0, skipped: 'store-unavailable' }; }
  if (!count) return { found: 0, fresh: 0, sent: 0, skipped: 'nothing-to-say' };
  const delivered = await post(webhook, composeMessage(candidates), options.fetchImpl ?? fetch);
  // Receipts precede optional health bookkeeping. Nothing omitted by the batch
  // limit is marked sent, and a failed bookkeeping write cannot erase delivery.
  if (delivered.ok) {
    await env.STORE.write(async tx => {
      const held = await tx.query<{ event_id: string }>(
        `SELECT event_id::text FROM noticeos.notification_outbox
          WHERE lease_id = $1::uuid AND state = 'pending' FOR UPDATE`, [lease]);
      if (held.length !== count) throw new Error('Notification delivery lease was lost.');
      for (const candidate of candidates) await tx.execute(
        `INSERT INTO noticeos.notifications (workspace_id, channel, subject, subject_ref, occurrence, condition, sent_at)
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz) ON CONFLICT DO NOTHING`,
        [tx.workspaceId, NOTIFICATION_CHANNEL, candidate.subject, candidate.subjectRef, candidate.occurrence, candidate.condition, now]);
      await tx.execute(`UPDATE noticeos.notification_outbox SET state = 'sent', finished_at = $2::timestamptz,
        lease_id = NULL, lease_until = NULL WHERE lease_id = $1::uuid`, [lease, now]);
    });
  } else {
    const attempt = Math.max(...candidates.map(candidate => candidate.attempts ?? 1));
    await retry(Math.max(delivered.retryAfterMs ?? 0, Math.min(900_000, 30_000 * 2 ** Math.min(attempt - 1, 5))));
  }
  const monitoringAvailable = await observeIntegration(env, health, { capability: 'discord-delivery', target: webhook,
    observedAt: now, ok: delivered.ok, code: delivered.ok ? undefined : delivered.code, evidenceSource: 'delivery' });
  if (credential.source === 'store') await recordCredentialOutcome(env, NOTIFICATION_PROVIDER,
    { ok: delivered.ok, error: delivered.ok ? null : delivered.reason, at: now });
  return { found: count, fresh: count, sent: delivered.ok ? count : 0,
    skipped: delivered.ok ? null : 'delivery-failed', ...(!monitoringAvailable ? { monitoringAvailable: false } : {}) };
}

/** Discord limits content to 2,000 characters; keep every claimed item visible. */
export function composeMessage(fresh: readonly Candidate[], carried: readonly Candidate[] = fresh): string {
  const head = `NoticeOS — ${fresh.length} new ${fresh.length === 1 ? 'alert' : 'alerts'}`;
  const lines = carried.map(candidate => {
    const line = candidate.line.replace(/[\r\n]+/g, ' ');
    return `• ${line.length > 170 ? `${line.slice(0, 169)}…` : line}`;
  });
  if (fresh.length > carried.length) lines.push(`• …and ${fresh.length - carried.length} more`);
  return [head, ...lines].join('\n');
}

/**
 * What a Discord webhook's answer to a post means: one reading, shared by the
 * card's connection test and a real delivery, so a dead webhook reads the same
 * whichever found it. 401/403/404 is Discord no longer knowing the webhook.
 */
export function discordWebhookAnswer(status: number): { ok: boolean; result: ProbeResult } {
  // A webhook post answers 204 No Content.
  if (status >= 200 && status < 300) return { ok: true, result: { outcome: 'answered' } };
  if (status === 401 || status === 403 || status === 404) {
    return { ok: false, result: { outcome: 'refused', status, fix: { kind: 'replace' } } };
  }
  if (status === 429) return { ok: false, result: { outcome: 'rate-limited', status, fix: { kind: 'wait' } } };
  return { ok: false, result: { outcome: 'unreachable', status } };
}

/** The monitoring code a failed delivery is recorded under. */
function deliveryCode(result: ProbeResult): string {
  if (result.outcome === 'refused') return 'access';
  if (result.outcome === 'rate-limited') return 'rate-limit';
  return 'provider';
}

/** POST the message. The url never appears in the result, and Discord's own
 * error body is never reflected back. */
async function post(
  webhook: string,
  content: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true } | { ok: false; reason: string; code: string; retryAfterMs?: number }> {
  let status: number;
  let retryAfterMs = 0;
  try {
    const response = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const retrySeconds = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retrySeconds) && retrySeconds > 0) retryAfterMs = Math.min(3_600_000, retrySeconds * 1000);
    await response.body?.cancel();
    status = response.status;
  } catch {
    return { ok: false, code: 'network', reason: probeLine({ outcome: 'unreachable' }) };
  }
  const answer = discordWebhookAnswer(status);
  if (answer.ok) return { ok: true };
  return { ok: false, code: deliveryCode(answer.result), reason: probeLine(answer.result), retryAfterMs };
}

/** The declared conditions, re-exported for readers of this file. */
export { NOTIFIED_CONDITIONS };
