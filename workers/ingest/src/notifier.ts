// THE THING THAT ACTUALLY TELLS THE OPERATOR (bead `ro-vu8d.23`, doc 15 flow E,
// doc 11's Discord row).
//
// WHAT WAS MISSING. Bead `ro-vu8d.18` gave Discord a provider catalog row, a
// card on `/integrations`, a store-first credential and a probe that proves
// delivery. What it could not give it was a SENDER: the only thing that had ever
// written to that webhook was a connection test, so every alert, every stopped
// collector and every decision waiting on the operator reached them only if they
// opened the Tower.
//
// THE DESIGN QUESTION IS *WHAT*, NOT *HOW*. Alert fatigue is doc 11's own named
// failure mode for this channel, so a notifier that forwarded every alert would
// be worse than none — it would be `/alerts` again, at 3am, unreadable, and the
// operator would learn to ignore the channel that is supposed to interrupt them.
// So what qualifies is a WRITTEN RULE, declared once in `packages/contract`
// (`NOTIFIED_CONDITIONS`) and rendered on the card that asks for the credential,
// so the promise and the delivery cannot drift:
//
//   * a NEW OPEN ERROR alert — error only; `warn` is what the desk is for;
//   * a DATA SOURCE THAT TURNED FAILING — the state the Integrations card leads
//     with, read through the contract's own `connectionState` so "failing" means
//     one thing in both places.
//
// ONCE PER CONDITION, AND THAT NEEDS A MEMORY. This lane runs hourly, so without
// a record of what it already said it would re-send every open error every hour.
// The record is `noticeos.notifications` on Postgres (bead ro-ujb9.76.5.2),
// written ONLY on a successful delivery. Two consequences are deliberate: a
// failed send is retried next tick rather than lost, and the Alerts row can say
// an alert was notified because the row means a message actually landed. An
// alert is named there by its workspace's number, the one the Tower shows.
//
// WHERE THE MEMORY CANNOT BE READ, NOTHING IS SENT. A notifier that sent
// without being able to record would deliver the same alert every hour, which
// is the failure mode it exists to avoid.
//
// NO SECRET EVER LEAVES THIS FILE. The webhook url IS the credential; it never
// appears in a log line, a result, or an error — the same rule the probe next
// door keeps — and Discord's own response body is never reflected anywhere.

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

/** The provider that CARRIES the notifications, as opposed to one they are
 * about. Named once because two rules ask about it. */
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
  /** What makes this the SAME thing twice rather than a new one — see
   * db/0031. Empty for an alert. */
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
 * One tick of the notifier: gather, dedupe, send once, record.
 *
 * ONE MESSAGE PER TICK, not one per condition. A channel that pings six times in
 * a second is a channel somebody mutes, and the operator reads these as a list
 * anyway.
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
    // thing every hour, so the lane stands down and the card says why.
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

  // A probe is not evidence, but a real delivery is: this is the same stamp the
  // collectors leave, so the card's verdict reflects what the channel actually
  // did rather than only what a button proved (bead `ro-vu8d.23`).
  if (credential.source === 'store') {
    await recordCredentialOutcome(env, NOTIFICATION_PROVIDER, {
      ok: delivered.ok,
      error: delivered.ok ? null : delivered.reason,
      at: now.toISOString(),
    });
  }

  if (!delivered.ok) {
    // Nothing is recorded, so the next tick tries again — and the operator sees
    // the failure on the card rather than in a log they never open.
    log({ event: 'notifier_delivery_failed', fresh: fresh.length });
    return {
      found: candidates.length,
      fresh: fresh.length,
      sent: 0,
      skipped: 'delivery-failed',
      ...(!monitoringAvailable ? { monitoringAvailable: false } : {}),
    };
  }

  // EVERY fresh candidate is recorded, not only the ones that fitted: the
  // message said how many more there were, so they were told — collectively —
  // and re-sending them next hour is the fatigue the cap exists to prevent.
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
 * A NEW OPEN ERROR ALERT.
 *
 * Open is `resolved_at IS NULL AND disposition IS NULL` — the strictest reading,
 * because a row the operator has already acknowledged, snoozed or tuned is one
 * they have SEEN, and interrupting them about it would be arguing.
 *
 * The horizon (`NOTIFY_WINDOW_HOURS`) is what stops the first tick after this
 * ships — or after a broken webhook is fixed — delivering every error the store
 * has ever held. An error from three weeks ago is not news; `/alerts` has been
 * showing it the whole time.
 */
async function openErrorAlerts(env: IngestEnv, nowMs: number): Promise<Candidate[]> {
  const since = new Date(nowMs - NOTIFY_WINDOW_HOURS * 3_600_000).toISOString();
  // On Postgres (bead ro-ujb9.76.5.2): each alert as its newest reading
  // states it, and known by its workspace's number, which is what the Tower
  // shows and what the record of having told the operator names.
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
    // A flag id already identifies one firing, so there is no second key.
    occurrence: '',
    // The site by the name the Tower shows, and the OS by the product's name
    // (bead `ro-ujb9.77.10`); an alert on an unknown id is named by its id.
    line: `${row.displayName === null ? row.asset : assetDisplayName(row.isOs === true ? 1 : 0, row.displayName)} — ${row.metric ?? row.ruleId}: ${row.message ?? row.ruleId}`,
  }));
}

/**
 * A DATA SOURCE THAT STOPPED WORKING.
 *
 * The state is `connectionState`'s, imported rather than re-derived, so the
 * message and the Integrations card cannot disagree about what *Failing* means.
 * Only providers that get a card are asked: the Google OAuth app is a
 * prerequisite the Google card carries in place, and a message about it would
 * name a thing the operator cannot find a card for.
 *
 * The occurrence key is the failing call's own timestamp, so a provider that
 * breaks, is fixed and breaks again is two messages while a provider that is
 * still broken is one.
 */
async function failingDataSources(env: IngestEnv): Promise<Candidate[]> {
  const state = await listCredentialSummaries(env);
  const carded = new Set(integrationProviderCards().map((provider) => provider.id));
  return state.summaries
    .filter(
      (summary) =>
        carded.has(summary.provider) &&
        // NEVER THE CHANNEL ITSELF. A message reading "the channel you are
        // reading this in stopped working" is nonsense on arrival: if it
        // arrived, it did not stop. A failed delivery is reported where it can
        // be acted on — the credential's own verdict on the Integrations card —
        // and the next tick retries.
        summary.provider !== NOTIFICATION_PROVIDER &&
        connectionState(summary) === 'failing',
    )
    .map((summary) => ({
      condition: 'source-failing' as const,
      subject: 'data-source' as const,
      subjectRef: summary.provider,
      occurrence: summary.lastUsedAt ?? '',
      // The stored sentence, which is the ingest's own words and never the
      // provider's response body (see credential-probes.ts).
      line: `${summary.provider} stopped working — ${summary.lastError ?? 'no reason recorded'}`,
    }));
}

/** The three columns that identify one thing already said, as one string.
 *
 * The separator is an explicit `\u0000` escape rather than the byte itself: a
 * NUL in source makes grep treat the whole file as binary, so a search for a
 * symbol defined here would read as "never implemented" (bead `ro-20n`). It is
 * still the right separator — no asset id, provider id or timestamp can contain
 * one, so two different keys can never collide. */
function dedupeKey(candidate: Candidate): string {
  return [candidate.subject, candidate.subjectRef, candidate.occurrence].join(KEY_SEP);
}

/**
 * Which of these has the operator already been told about.
 *
 * THROWS when the table is not there, on purpose: the caller has to tell
 * "nothing new to say" apart from "no memory to say it with", because they mean
 * opposite things and only one of them is safe to send through.
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
      // one condition would otherwise fail the write, and the unique key is
      // already the answer to "have we said this".
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
 * The message, in the operator's own channel.
 *
 * It leads with what this is, because somebody reading an alert channel sees
 * the first few words before they see anything else — the same rule the
 * connection test's line follows. Past the cap it says how many more there were
 * rather than truncating silently: doc 15's own note is that if more than ten
 * things need attention, the volume IS the finding — and the head already says
 * the whole count, so the last line is the number and nothing else.
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
 * What a Discord webhook's answer to a post means — ONE reading, shared by
 * the card's connection test (`probeDiscord`) and a real delivery here, so a
 * dead webhook reads the same on the card whichever of the two found it
 * (bead `ro-ujb9.96.6.25`): `Refused · HTTP 404` and the Replace press, not a
 * sentence about the server's settings. 401/403/404 is Discord no longer
 * knowing the webhook (deleted in the server's settings): a new one is the fix.
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
 * error body is never reflected back — it is provider-controlled text. The
 * reason is the answer as the card's one short line (`probeLine`). */
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

/** Every line this lane logs. Nothing here has ever held a url — the fields are
 * counts and declared condition ids. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

/** The declared conditions, re-exported so a reader of this file does not have
 * to go looking for what it will and will not send. */
export { NOTIFIED_CONDITIONS };
