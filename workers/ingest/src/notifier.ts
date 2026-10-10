// The notifier: what the operator is told without opening the Tower. A
// notifier that forwarded every alert would be `/alerts` again at 3am, so what
// qualifies is a written rule, declared once in `packages/contract`
// (`NOTIFIED_CONDITIONS`) and rendered on the card that asks for the
// credential: a new open error alert, and a data source that turned failing.
//
// Once per condition, which needs a memory: `noticeos.notifications`, written
// only on a successful delivery, so a failed send is retried next tick and the
// Alerts row can say an alert was notified because a message landed. Where the
// memory cannot be read, nothing is sent. The webhook url is the credential
// and never appears in a log line, a result or an error; Discord's own
// response body is never reflected.

import {
  NOTIFICATION_CHANNEL,
  NOTIFIED_CONDITIONS,
  NOTIFY_BATCH_CAP,
  NOTIFY_WINDOW_HOURS,
  type NotifiedCondition,
  type ProbeResult,
  assetDisplayName,
  connectionState,
  integrationProviderCards,
  probeLine,
} from '@noticeos/contract';
import {
  listCredentialSummaries,
  recordCredentialOutcome,
  resolveCredential,
} from './credentials.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';

/** The provider that carries the notifications, as opposed to one they are about. */
const NOTIFICATION_PROVIDER = 'discord';
/** See `dedupeKey`. Written as an escape so the source stays greppable. */
const KEY_SEP = '\u0000';
const WEBHOOK_FIELD = 'DISCORD_WEBHOOK_URL';
const POST_TIMEOUT_MS = 10_000;

/** One thing worth telling the operator, before it is known whether they have
 * already been told. */
interface Candidate {
  condition: NotifiedCondition;
  /** `alert` (a `flags` row) or `data-source` (a provider credential). */
  subject: 'alert' | 'data-source';
  /** The flag id as text, or the provider id. */
  subjectRef: string;
  /** What makes this the same thing twice rather than a new one. Empty for an alert. */
  occurrence: string;
  /** The line the message carries. Never a secret, never a url. */
  line: string;
}

export interface NotifierResult {
  monitoringAvailable?: boolean;
  /** How many candidates the rules produced before dedupe. */
  found: number;
  /** How many were new — the size of the message, before the cap. */
  fresh: number;
  /** How many lines the message actually carried. */
  sent: number;
  /** Why nothing was sent, when nothing was. Never carries a credential. */
  skipped:
    | null
    | 'nothing-to-say'
    | 'no-credential'
    | 'store-unavailable'
    | 'delivery-failed';
}

export interface NotifierOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * One tick of the notifier: gather, dedupe, send once, record. One message per
 * tick, not one per condition: a channel that pings six times in a second is a
 * channel somebody mutes.
 */
export async function runNotifier(
  env: IngestEnv,
  options: NotifierOptions = {},
): Promise<NotifierResult> {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs);

  const candidates = [
    ...(await openErrorAlerts(env, nowMs)),
    ...(await failingDataSources(env)),
  ];
  if (candidates.length === 0) {
    return { found: 0, fresh: 0, sent: 0, skipped: 'nothing-to-say' };
  }

  let already: Set<string>;
  try {
    already = await alreadyNotified(env, candidates);
  } catch {
    // The memory cannot be read. Sending anyway would mean sending the same
    // thing every hour, so the lane stands down.
    log({ event: 'notifier_store_unavailable', found: candidates.length });
    return { found: candidates.length, fresh: 0, sent: 0, skipped: 'store-unavailable' };
  }

  const fresh = candidates.filter((c) => !already.has(dedupeKey(c)));
  if (fresh.length === 0) {
    return { found: candidates.length, fresh: 0, sent: 0, skipped: 'nothing-to-say' };
  }

  const credential = await resolveCredential(env, NOTIFICATION_PROVIDER);
  const webhook = credential.fields[WEBHOOK_FIELD];
  if (webhook === undefined || webhook.trim() === '') {
    log({ event: 'notifier_no_credential', fresh: fresh.length });
    return { found: candidates.length, fresh: fresh.length, sent: 0, skipped: 'no-credential' };
  }

  const carried = fresh.slice(0, NOTIFY_BATCH_CAP);
  const health = await tryHealthConnection(env, 'discord', credential);
  const deliveryAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const delivered = await post(
    webhook,
    composeMessage(fresh, carried),
    options.fetchImpl ?? fetch,
  );
  const monitoringAvailable = await observeIntegration(env, health, { capability: 'discord-delivery', target: webhook, observedAt: deliveryAt,
    ok: delivered.ok, code: delivered.ok ? undefined : delivered.code, evidenceSource: 'delivery' });

  // A real delivery is evidence, the same stamp the collectors leave.
  if (credential.source === 'store') {
    await recordCredentialOutcome(env, NOTIFICATION_PROVIDER, {
      ok: delivered.ok,
      error: delivered.ok ? null : delivered.reason,
      at: now.toISOString(),
    });
  }

  if (!delivered.ok) {
    // Nothing is recorded, so the next tick tries again.
    log({ event: 'notifier_delivery_failed', fresh: fresh.length });
    return {
      found: candidates.length,
      fresh: fresh.length,
      sent: 0,
      skipped: 'delivery-failed',
      ...(!monitoringAvailable ? { monitoringAvailable: false } : {}),
    };
  }

  // Every fresh candidate is recorded, not only the ones that fitted: the
  // message said how many more there were, so they were told collectively.
  await recordSends(env, fresh, now.toISOString());
  log({
    event: 'notifier_sent',
    found: candidates.length,
    fresh: fresh.length,
    carried: carried.length,
    conditions: [...new Set(fresh.map((c) => c.condition))],
  });
  return { found: candidates.length, fresh: fresh.length, sent: carried.length, skipped: null, ...(!monitoringAvailable ? { monitoringAvailable: false } : {}) };
}

/**
 * A new open error alert. Open is `resolved_at IS NULL AND disposition IS
 * NULL`: a row the operator has acknowledged, snoozed or tuned is one they have
 * seen. The horizon (`NOTIFY_WINDOW_HOURS`) stops the first tick after a
 * broken webhook is fixed from delivering every error the store has ever held.
 */
async function openErrorAlerts(env: IngestEnv, nowMs: number): Promise<Candidate[]> {
  const since = new Date(nowMs - NOTIFY_WINDOW_HOURS * 3_600_000).toISOString();
  // Each alert as its newest reading states it, known by its workspace's
  // number, which is what the Tower shows.
  const rows = await env.STORE.read((tx) =>
    tx.query<{
      id: number;
      asset: string;
      displayName: string | null;
      isOs: boolean | null;
      metric: string | null;
      message: string | null;
      ruleId: string;
    }>(
      `SELECT f.flag_number::int AS id, f.asset_id AS asset, a.display_name AS "displayName", a.is_os AS "isOs",
              f.metric, f.message, f.rule_id AS "ruleId"
         FROM noticeos.current_flags f
         LEFT JOIN noticeos.assets a ON a.workspace_id = f.workspace_id AND a.asset_id = f.asset_id
        WHERE f.severity = 'error'
          AND f.resolved_at IS NULL
          AND f.disposition IS NULL
          AND f.fired_at >= $1::timestamptz
        ORDER BY f.fired_at, f.flag_id`,
      [since],
    ),
  );
  return rows.map((row) => ({
    condition: 'open-error' as const,
    subject: 'alert' as const,
    subjectRef: String(row.id),
    // A flag id already identifies one firing.
    occurrence: '',
    // The site by the name the Tower shows, and the OS by the product's name.
    line: `${row.displayName === null ? row.asset : assetDisplayName(row.isOs === true ? 1 : 0, row.displayName)} — ${row.metric ?? row.ruleId}: ${row.message ?? row.ruleId}`,
  }));
}

/**
 * A data source that stopped working. The state is `connectionState`'s,
 * imported rather than re-derived, so the message and the card cannot
 * disagree. Only providers that get a card are asked. The occurrence key is
 * the failing call's own timestamp, so a provider that breaks, is fixed and
 * breaks again is two messages while one still broken is one.
 */
async function failingDataSources(env: IngestEnv): Promise<Candidate[]> {
  const state = await listCredentialSummaries(env);
  const carded = new Set(integrationProviderCards().map((provider) => provider.id));
  return state.summaries
    .filter(
      (summary) =>
        carded.has(summary.provider) &&
        // Never the channel itself: "the channel you are reading this in
        // stopped working" is nonsense on arrival. A failed delivery is reported
        // on the credential's own card, and the next tick retries.
        summary.provider !== NOTIFICATION_PROVIDER &&
        connectionState(summary) === 'failing',
    )
    .map((summary) => ({
      condition: 'source-failing' as const,
      subject: 'data-source' as const,
      subjectRef: summary.provider,
      occurrence: summary.lastUsedAt ?? '',
      // The stored sentence: the ingest's own words, never the provider's body.
      line: `${summary.provider} stopped working — ${summary.lastError ?? 'no reason recorded'}`,
    }));
}

/** The three columns that identify one thing already said, as one string. The
 * separator is an explicit `\u0000` escape rather than the byte itself: a NUL
 * in source makes grep treat the whole file as binary. */
function dedupeKey(candidate: Candidate): string {
  return [candidate.subject, candidate.subjectRef, candidate.occurrence].join(KEY_SEP);
}

/**
 * Which of these has the operator already been told about. Throws when the
 * table is not there: "nothing new to say" and "no memory to say it with" mean
 * opposite things, and only one is safe to send through.
 */
async function alreadyNotified(
  env: IngestEnv,
  candidates: readonly Candidate[],
): Promise<Set<string>> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ subject: string; subjectRef: string; occurrence: string }>(
      `SELECT subject, subject_ref AS "subjectRef", occurrence
         FROM noticeos.notifications
        WHERE channel = $1`,
      [NOTIFICATION_CHANNEL],
    ),
  );
  const seen = new Set(
    rows.map((row) => [row.subject, row.subjectRef, row.occurrence].join(KEY_SEP)),
  );
  return new Set([...candidates.map(dedupeKey)].filter((key) => seen.has(key)));
}

async function recordSends(
  env: IngestEnv,
  candidates: readonly Candidate[],
  sentAt: string,
): Promise<void> {
  await env.STORE.write(async (tx) => {
    for (const candidate of candidates) {
      // `ON CONFLICT DO NOTHING` rather than a second read: two ticks racing on
      // one condition would otherwise fail the write.
      await tx.execute(
        `INSERT INTO noticeos.notifications
           (workspace_id, channel, subject, subject_ref, occurrence, condition, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT DO NOTHING`,
        [
          tx.workspaceId,
          NOTIFICATION_CHANNEL,
          candidate.subject,
          candidate.subjectRef,
          candidate.occurrence,
          candidate.condition,
          sentAt,
        ],
      );
    }
  });
}

/**
 * The message. It leads with what this is, because somebody reading an alert
 * channel sees the first few words first. Past the cap it says how many more
 * there were rather than truncating silently: the volume is the finding.
 */
export function composeMessage(
  fresh: readonly Candidate[],
  carried: readonly Candidate[],
): string {
  const head =
    fresh.length === 1
      ? 'NoticeOS — 1 new alert'
      : `NoticeOS — ${fresh.length} new alerts`;
  const lines = carried.map((candidate) => `• ${candidate.line}`);
  const overflow = fresh.length - carried.length;
  if (overflow > 0) lines.push(`• …and ${overflow} more`);
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
): Promise<{ ok: true } | { ok: false; reason: string; code: string }> {
  let status: number;
  try {
    const response = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    status = response.status;
  } catch {
    return { ok: false, code: 'network', reason: probeLine({ outcome: 'unreachable' }) };
  }
  const answer = discordWebhookAnswer(status);
  if (answer.ok) return { ok: true };
  return { ok: false, code: deliveryCode(answer.result), reason: probeLine(answer.result) };
}

/** Every line this lane logs: counts and declared condition ids, never a url. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

/** The declared conditions, re-exported for readers of this file. */
export { NOTIFIED_CONDITIONS };
