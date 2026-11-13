// Source transactions persist delivery intent. Delivery claims a bounded batch,
// rechecks current conditions, sends once, then marks the events as sent.
// A provider acceptance followed by a process crash can still be delivered twice.
import {
  DAILY_MEDIAVINE_REVENUE, NOTIFICATION_CHANNEL, NOTIFIED_CONDITIONS, NOTIFY_BATCH_CAP, NOTIFY_WINDOW_HOURS,
  type NotifiedCondition, type ProbeResult, assetDisplayName, connectionState, integrationProviderCards, probeLine,
} from '@noticeos/contract';
import { listCredentialSummaries, recordCredentialOutcome, resolveCredential } from './credentials.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { javascriptInstant } from '@noticeos/postgres';
import { MEDIAVINE_NOTIFICATIONS_ENABLED, projectMediavineMonth, type MediavineRevenueNotification } from './mediavine-notifications.js';
import { DISCORD_WEBHOOK_FIELD, discordWebhookAnswer, postDiscordWebhook, type DiscordMessage } from './discord-webhook.js';

const NOTIFICATION_PROVIDER = 'discord';
const POST_TIMEOUT_MS = 10_000;

type Candidate = { eventId: string; attempts: number; sourceRef: string } & (
  | { type: 'open-error' | 'source-failing'; line: string }
  | { type: typeof DAILY_MEDIAVINE_REVENUE; revenue: MediavineRevenueNotification }
);
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
const ELIGIBLE = `(q.notification_type = 'open-error' AND EXISTS (
  SELECT 1 FROM noticeos.current_flags f WHERE f.flag_number::text = q.source_ref
    AND f.severity = 'error' AND f.disposition IS NULL AND f.resolved_at IS NULL
)) OR (q.notification_type = 'source-failing' AND EXISTS (
  SELECT 1 FROM noticeos.integration_connections c WHERE c.connection_id = q.connection_id
    AND c.provider = q.source_ref AND c.provider <> 'discord' AND c.last_error IS NOT NULL
    AND (c.last_ok_at IS NULL OR c.last_ok_at < q.occurred_at)
)) OR (q.notification_type = '${DAILY_MEDIAVINE_REVENUE}' AND ${MEDIAVINE_NOTIFICATIONS_ENABLED})`;

const DISCORD_EVENTS = `channel = '${NOTIFICATION_CHANNEL}'
  AND notification_type IN ('open-error', 'source-failing', '${DAILY_MEDIAVINE_REVENUE}')`;

async function claim(env: IngestEnv, now: string, lease: string): Promise<Candidate[]> {
  const cutoff = new Date(Date.parse(now) - NOTIFY_WINDOW_HOURS * 3_600_000).toISOString();
  return env.STORE.write(async tx => {
    await tx.execute(`UPDATE noticeos.notification_events q SET state = 'cancelled', finished_at = $1::timestamptz,
      lease_id = NULL, lease_until = NULL WHERE q.state = 'pending'
        AND ${DISCORD_EVENTS}
        AND (q.lease_until IS NULL OR q.lease_until <= $1::timestamptz)
        AND (q.occurred_at < $2::timestamptz OR NOT (${ELIGIBLE}))`, [now, cutoff]);
    const rows = await tx.query<{
      eventId: string; type: NotifiedCondition; sourceRef: string; occurrence: string; attempts: number;
      collectedAt: string; revenueMinor: bigint | null; previousRevenueMinor: bigint | null;
      monthMinor: string | null; monthReportedDays: number | null;
      asset: string | null; displayName: string | null; isOs: boolean | null;
      metric: string | null; message: string | null; ruleId: string | null; error: string | null;
    }>(`WITH due AS (
      SELECT event_id FROM noticeos.notification_events WHERE state = 'pending' AND ${DISCORD_EVENTS}
        AND next_attempt_at <= $1::timestamptz AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
      ORDER BY next_attempt_at, event_id FOR UPDATE SKIP LOCKED LIMIT $3
    ), claimed AS (
      UPDATE noticeos.notification_events q SET lease_id = $2::uuid,
        lease_until = $1::timestamptz + interval '2 minutes', attempts = attempts + 1
      FROM due WHERE q.event_id = due.event_id RETURNING q.*
    ) SELECT q.event_id::text AS "eventId", q.notification_type AS type, q.source_ref AS "sourceRef", q.occurrence, q.attempts,
      q.occurred_at AS "collectedAt", (q.payload ->> 'amount_minor')::bigint AS "revenueMinor",
      (q.payload ->> 'previous_minor')::bigint AS "previousRevenueMinor",
      q.payload ->> 'month_minor' AS "monthMinor", (q.payload ->> 'month_reported_days')::integer AS "monthReportedDays",
      a.asset_id AS asset, a.display_name AS "displayName", a.is_os AS "isOs",
      f.metric, f.message, f.rule_id AS "ruleId", c.last_error AS error
      FROM claimed q
      LEFT JOIN noticeos.current_flags f ON q.notification_type = 'open-error' AND f.flag_number::text = q.source_ref
      LEFT JOIN noticeos.assets a ON a.workspace_id = q.workspace_id
        AND a.asset_id = CASE WHEN q.notification_type = '${DAILY_MEDIAVINE_REVENUE}' THEN q.source_ref ELSE f.asset_id END
      LEFT JOIN noticeos.integration_connections c ON q.notification_type = 'source-failing' AND c.connection_id = q.connection_id`,
      [now, lease, NOTIFY_BATCH_CAP]);
    return rows.map((row): Candidate => {
      const asset = row.displayName === null ? row.asset : assetDisplayName(row.isOs === true ? 1 : 0, row.displayName);
      if (row.type === 'open-error') return { ...row, type: row.type,
        line: `${asset} — ${row.metric ?? row.ruleId}: ${row.message ?? row.ruleId}` };
      if (row.type === 'source-failing') return { ...row, type: row.type,
        line: `${row.sourceRef} stopped working — ${row.error ?? 'no reason recorded'}` };
      if (row.revenueMinor === null || row.monthMinor === null || row.monthReportedDays === null) {
        throw new Error('Mediavine notification is missing its revenue figures.');
      }
      const monthMinor = BigInt(row.monthMinor);
      return { ...row, type: row.type, revenue: {
        asset: asset ?? row.sourceRef, date: row.occurrence, collectedAt: row.collectedAt,
        amountMinor: row.revenueMinor, previousMinor: row.previousRevenueMinor, monthMinor,
        projectedMinor: projectMediavineMonth(row.occurrence, monthMinor, row.monthReportedDays),
      } };
    });
  });
}

/** Recover missed events without replaying successful deliveries. */
async function recoverIntents(env: IngestEnv, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - NOTIFY_WINDOW_HOURS * 3_600_000).toISOString();
  await env.STORE.write(async tx => {
    await tx.execute(`INSERT INTO noticeos.notification_events
      (workspace_id, notification_type, source_kind, source_ref, occurrence, occurred_at, next_attempt_at)
      SELECT f.workspace_id, 'open-error', 'alert', f.flag_number::text, '', coalesce(e.observed_at, f.fired_at), $1::timestamptz
      FROM noticeos.current_flags f LEFT JOIN LATERAL (
        SELECT observed_at FROM noticeos.flag_evidence WHERE flag_id = f.flag_id ORDER BY observed_at DESC LIMIT 1
      ) e ON true WHERE f.severity = 'error' AND f.disposition IS NULL AND f.resolved_at IS NULL
        AND coalesce(e.observed_at, f.fired_at) >= $2::timestamptz
      ON CONFLICT DO NOTHING`, [now, cutoff]);
    // Source row locks serialize repair with transitions and another repair;
    // the following statement observes their committed intent before inserting.
    await tx.query(`SELECT connection_id FROM noticeos.integration_connections
      WHERE provider <> 'discord' AND last_error IS NOT NULL ORDER BY connection_id FOR UPDATE`);
    await tx.execute(`INSERT INTO noticeos.notification_events
      (workspace_id, notification_type, source_kind, source_ref, occurrence, connection_id, occurred_at, next_attempt_at)
      SELECT c.workspace_id, 'source-failing', 'integration', c.provider, gen_random_uuid()::text, c.connection_id, c.last_used_at, $1::timestamptz
      FROM noticeos.integration_connections c WHERE c.provider <> 'discord' AND c.last_error IS NOT NULL
        AND c.last_used_at >= $2::timestamptz AND (c.last_ok_at IS NULL OR c.last_ok_at < c.last_used_at)
        AND NOT EXISTS (
          SELECT 1 FROM noticeos.notification_events n WHERE n.notification_type = 'source-failing'
            AND n.channel = '${NOTIFICATION_CHANNEL}' AND n.source_ref = c.provider AND (
              (n.connection_id = c.connection_id AND (c.last_ok_at IS NULL OR n.occurred_at > c.last_ok_at))
              OR (n.state = 'sent' AND n.finished_at >= coalesce(c.last_ok_at, c.created_at))
            )
        )`, [now, cutoff]);
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
    if (candidates.some(candidate => candidate.type === 'source-failing')) {
      const carded = new Set(integrationProviderCards().map(provider => provider.id));
      const summaries = await listCredentialSummaries(env);
      const failing = new Set(summaries.summaries.filter(summary => carded.has(summary.provider)
        && connectionState(summary) === 'failing').map(summary => String(summary.provider)));
      const excluded = candidates.filter(candidate => candidate.type === 'source-failing' && !failing.has(candidate.sourceRef));
      if (excluded.length) await env.STORE.write(tx => tx.execute(`UPDATE noticeos.notification_events
        SET state = 'cancelled', finished_at = $2::timestamptz, lease_id = NULL, lease_until = NULL
        WHERE lease_id = $1::uuid AND event_id = ANY($3::uuid[])`, [lease, now, excluded.map(candidate => candidate.eventId)]));
      candidates = candidates.filter(candidate => !excluded.includes(candidate));
    }
  }
  catch { return { found: 0, fresh: 0, sent: 0, skipped: 'store-unavailable' }; }
  let count = candidates.length;
  if (!count) return { found: 0, fresh: 0, sent: 0, skipped: 'nothing-to-say' };
  const retry = async (delayMs: number, disconnected = false) => env.STORE.write(tx => tx.execute(
    `UPDATE noticeos.notification_events SET lease_id = NULL, lease_until = NULL,
       attempts = attempts - CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       next_attempt_at = $2::timestamptz WHERE lease_id = $1::uuid AND state = 'pending'`,
    [lease, new Date(nowMs + Date.now() - beganAt + delayMs).toISOString(), disconnected]));
  const credential = await resolveCredential(env, NOTIFICATION_PROVIDER);
  const webhook = credential.fields[DISCORD_WEBHOOK_FIELD];
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
      await tx.execute(`UPDATE noticeos.notification_events q SET state = 'cancelled',
        finished_at = $2::timestamptz, lease_id = NULL, lease_until = NULL
        WHERE q.lease_id = $1::uuid AND NOT (${ELIGIBLE})`, [lease, sendingAt]);
      return tx.query<{ id: string }>(`UPDATE noticeos.notification_events SET
        lease_until = $2::timestamptz + interval '2 minutes'
        WHERE lease_id = $1::uuid AND state = 'pending' AND lease_until > $2::timestamptz
        RETURNING event_id::text AS id`, [lease, sendingAt]);
    });
    const ids = new Set(held.map(row => row.id));
    candidates = candidates.filter(candidate => ids.has(candidate.eventId));
    count = candidates.length;
  } catch { return { found: count, fresh: count, sent: 0, skipped: 'store-unavailable' }; }
  if (!count) return { found: 0, fresh: 0, sent: 0, skipped: 'nothing-to-say' };
  const delivered = await post(webhook, discordMessage(candidates), options.fetchImpl ?? fetch);
  // A failed health update cannot erase a successful delivery.
  if (delivered.ok) {
    await env.STORE.write(async tx => {
      const sent = await tx.query<{ event_id: string }>(`UPDATE noticeos.notification_events
        SET state = 'sent', finished_at = $2::timestamptz, lease_id = NULL, lease_until = NULL
        WHERE lease_id = $1::uuid AND state = 'pending' RETURNING event_id::text`, [lease, now]);
      if (sent.length !== count) throw new Error('Notification delivery lease was lost.');
    });
  } else {
    const attempt = Math.max(...candidates.map(candidate => candidate.attempts));
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
export function composeMessage(fresh: readonly { line: string }[], carried: readonly { line: string }[] = fresh): string {
  const head = `NoticeOS — ${fresh.length} new ${fresh.length === 1 ? 'alert' : 'alerts'}`;
  const lines = carried.map(candidate => {
    const line = candidate.line.replace(/[\r\n]+/g, ' ');
    return `• ${line.length > 170 ? `${line.slice(0, 169)}…` : line}`;
  });
  if (fresh.length > carried.length) lines.push(`• …and ${fresh.length - carried.length} more`);
  return [head, ...lines].join('\n');
}

function discordMessage(candidates: readonly Candidate[]): DiscordMessage {
  const alerts = candidates.filter(candidate => candidate.type !== DAILY_MEDIAVINE_REVENUE);
  const revenue = candidates.filter(candidate => candidate.type === DAILY_MEDIAVINE_REVENUE);
  if (revenue.length === 0) return { content: composeMessage(alerts) };
  return {
    content: alerts.length > 0 ? composeMessage(alerts) : '**NoticeOS · Mediavine revenue**',
    embeds: revenue.map(candidate => discordRevenue(candidate.revenue)),
  };
}

const wholeDollars = new Intl.NumberFormat('en-US');
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' });

function usd(minor: bigint): string {
  const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '-' : ''}$${wholeDollars.format(absolute / 100n)}.${String(absolute % 100n).padStart(2, '0')}`;
}

function weekOverWeek(amount: bigint, previous: bigint | null): string {
  if (previous === null) return '⚪ No figure last week';
  const direction = amount > previous ? '📈' : amount < previous ? '📉' : '➖';
  if (previous === 0n) return `${direction} $0 last week`;
  return `${direction} ${percent.format(Number(amount - previous) / Math.abs(Number(previous)))} vs last week`;
}

function discordRevenue(revenue: MediavineRevenueNotification): NonNullable<DiscordMessage['embeds']>[number] {
  const { asset, date, collectedAt, amountMinor, previousMinor, monthMinor, projectedMinor } = revenue;
  const collected = Math.floor(Date.parse(javascriptInstant(collectedAt)) / 1000);
  const projection = projectedMinor === null ? 'Pending' : usd(projectedMinor);
  return {
    title: asset.replace(/[\r\n]+/g, ' ').slice(0, 200),
    description: `${date} · **${usd(amountMinor)}** · ${weekOverWeek(amountMinor, previousMinor)} · Collected <t:${collected}:f>\n`
      + `Month to date **${usd(monthMinor)}** · Projected at current pace **${projection}**`,
  };
}

/** The monitoring code a failed delivery is recorded under. */
function deliveryCode(result: ProbeResult): string {
  if (result.outcome === 'refused' || result.outcome === 'invalid') return 'access';
  if (result.outcome === 'rate-limited') return 'rate-limit';
  return 'provider';
}

/** POST the message. The url never appears in the result, and Discord's own
 * error body is never reflected back. */
async function post(
  webhook: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch,
): Promise<{ ok: true } | { ok: false; reason: string; code: string; retryAfterMs?: number }> {
  let status: number | null;
  let retryAfterMs = 0;
  try {
    const response = await postDiscordWebhook(webhook, { ...message, allowed_mentions: { parse: [] } }, POST_TIMEOUT_MS, fetchImpl);
    const retrySeconds = Number(response?.headers.get('retry-after'));
    if (Number.isFinite(retrySeconds) && retrySeconds > 0) retryAfterMs = Math.min(3_600_000, retrySeconds * 1000);
    await response?.body?.cancel();
    status = response?.status ?? null;
  } catch {
    return { ok: false, code: 'network', reason: probeLine({ outcome: 'unreachable' }) };
  }
  const answer = discordWebhookAnswer(status);
  if (answer.ok) return { ok: true };
  return { ok: false, code: deliveryCode(answer.result), reason: probeLine(answer.result), retryAfterMs };
}

/** The declared conditions, re-exported for readers of this file. */
export { NOTIFIED_CONDITIONS };
