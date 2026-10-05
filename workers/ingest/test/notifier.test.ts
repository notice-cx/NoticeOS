// THE OPERATOR NOTIFICATION LANE (bead `ro-vu8d.23`).
//
// Every test here injects its own `fetchImpl` and its own webhook. That is a
// SAFETY RULE, not a convenience: a suite that let this lane reach real
// `fetch` with the operator's webhook would deliver test alerts into the
// operator's own channel. The pool no longer reads the checkout's `.dev.vars`
// (bead ro-ujb9.182, test/test-env.test.ts), and `vitest.config.ts` still
// binds `DISCORD_WEBHOOK_URL` to the empty string, so
// the only webhook any test can reach is one it stored itself — and the ones
// below store `https://discord.test/...`, which resolves nowhere.
//
// What is pinned is the DESIGN rather than the plumbing: what qualifies, what
// does not, that a recurring condition is said once, and that the record only
// ever claims a message that actually landed.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { composeMessage, runNotifier } from '../src/notifier.js';
import { putCredential } from '../src/credentials.js';
import { credentialVerdict, forgetCredentials, insertFlag as storeFlag, insertPulse, pgRows, refuseHealthStates, reset, setConnection } from './helpers.js';
import { changeSites, storeSites } from './sites';

const NOW = Date.parse('2026-09-05T13:05:00.000Z');
const HOUR = 3_600_000;
const WEBHOOK = 'https://discord.test/api/webhooks/1/notifier-suite';

interface Posted {
  fetchImpl: typeof fetch;
  posts: { url: string; content: string }[];
}

function discordFetch(status = 204): Posted {
  const posts: { url: string; content: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    posts.push({ url, content: JSON.parse(String(init?.body)).content as string });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, posts };
}

async function connectDiscord(): Promise<void> {
  await putCredential(env, {
    provider: 'discord',
    fields: { DISCORD_WEBHOOK_URL: WEBHOOK },
  });
}

async function insertFlag(over: {
  asset?: string;
  severity?: string;
  firedAt?: string;
  metric?: string;
  message?: string;
  disposition?: string | null;
  resolvedAt?: string | null;
}): Promise<number> {
  return storeFlag({
    asset: over.asset ?? 'meals.example',
    firedAt: over.firedAt ?? new Date(NOW - HOUR).toISOString(),
    severity: over.severity ?? 'error',
    kind: 'anomaly',
    metric: over.metric ?? 'pulse',
    message: over.message ?? 'no report received in 26h',
    ruleId: 'ingest-freshness',
    ruleInputs: '{}',
    disposition: over.disposition ?? null,
    resolvedAt: over.resolvedAt ?? null,
  });
}

async function notified(): Promise<{ subject: string; ref: string; condition: string }[]> {
  return pgRows<{ subject: string; ref: string; condition: string }>(
    `SELECT subject, subject_ref AS ref, condition FROM noticeos.notifications ORDER BY notification_id`,
  );
}

// `reset` empties the alerts and what was said about them (Postgres).
beforeEach(reset);
beforeEach(async () => {
  await forgetCredentials();
});

describe('what the OS interrupts the operator about', () => {
  it('sends a new open error alert, once, through the stored credential', async () => {
    await connectDiscord();
    const id = await insertFlag({ message: 'no report received in 26h' });
    const discord = discordFetch();

    const first = await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    expect(first).toMatchObject({ found: 1, fresh: 1, sent: 1, skipped: null });
    expect(discord.posts).toHaveLength(1);
    expect(discord.posts[0]!.url).toBe(WEBHOOK);
    // The site by the name the Tower shows (db/0002 seeds it).
    expect(discord.posts[0]!.content).toContain('Meal Planner — pulse: no report received in 26h');
    expect(await notified()).toEqual([
      { subject: 'alert', ref: String(id), condition: 'open-error' },
    ]);

    // THE DEDUPE, which is the whole reason the table exists: the lane runs
    // hourly, and a condition that is still open must not be re-sent every hour.
    const again = await runNotifier(env, {
      nowMs: NOW + HOUR,
      fetchImpl: discord.fetchImpl,
    });
    expect(again).toMatchObject({ fresh: 0, sent: 0, skipped: 'nothing-to-say' });
    expect(discord.posts).toHaveLength(1);
  });

  // Bead ro-ujb9.76.5.2: an alert a same-day report retry replaced stays in
  // the store, where D1 deleted it, and is nothing to tell the operator.
  it('says nothing about an alert a same-day report retry replaced', async () => {
    await connectDiscord();
    const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
    const first = await insertPulse({ asset: 'meals.example', date: at(2).slice(0, 10), receivedAt: at(2) });
    const retry = await insertPulse({ asset: 'meals.example', date: at(2).slice(0, 10), receivedAt: at(1) });
    await storeFlag({
      asset: 'meals.example', firedAt: at(2), severity: 'error', kind: 'anomaly', metric: 'signups',
      message: 'replaced by the retry', ruleId: 'flow-poisson-low', pulseId: first, replacedByPulseId: retry,
    });
    const discord = discordFetch();

    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ found: 0, sent: 0 });
    expect(discord.posts).toEqual([]);
    expect(await notified()).toEqual([]);
  });

  it("names an alert on the OS's own row NoticeOS, whatever the row stores (ro-ujb9.77.10)", async () => {
    await connectDiscord();
    // The notifier names a flag's site from the site list, joined to its
    // alerts (both on Postgres).
    const row = (await storeSites()).find((site) => site.is_os === 1);
    expect(row).toBeDefined();
    const storedName = 'LegacyOS';
    await changeSites([row!.id], { displayName: storedName });
    try {
      await insertFlag({ asset: row!.id, message: 'the runner stopped' });
      const discord = discordFetch();
      await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
      expect(discord.posts[0]!.content).toContain('NoticeOS — pulse: the runner stopped');
      expect(discord.posts[0]!.content).not.toContain(storedName);
      expect(discord.posts[0]!.content).not.toContain(row!.id);
    } finally {
      await changeSites([row!.id], { displayName: row!.display_name });
    }
  });

  it('stamps the credential from a real delivery, so the card is not only a button', async () => {
    await connectDiscord();
    await insertFlag({});
    await runNotifier(env, { nowMs: NOW, fetchImpl: discordFetch().fetchImpl });
    const stamped = await credentialVerdict('discord');
    expect(stamped?.lastOkAt).toBe(new Date(NOW).toISOString());
    expect(stamped?.lastError).toBeNull();
  });

  it('never sends a warning, an alert the operator has answered, or a resolved one', async () => {
    await connectDiscord();
    await insertFlag({ severity: 'warn', metric: 'signups' });
    await insertFlag({ severity: 'error', metric: 'orders', disposition: 'ack' });
    await insertFlag({
      severity: 'error',
      metric: 'sessions',
      resolvedAt: new Date(NOW).toISOString(),
    });
    const discord = discordFetch();
    const result = await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    // A warning is what the desk is for; an answered or closed alert is one the
    // operator has already seen, and interrupting them about it would be arguing.
    expect(result).toMatchObject({ found: 0, sent: 0, skipped: 'nothing-to-say' });
    expect(discord.posts).toHaveLength(0);
  });

  it('does not replay a backlog: only conditions from the last 24 hours', async () => {
    await connectDiscord();
    await insertFlag({ firedAt: new Date(NOW - 30 * HOUR).toISOString(), metric: 'stale' });
    const recent = await insertFlag({ firedAt: new Date(NOW - 2 * HOUR).toISOString() });
    const discord = discordFetch();

    const result = await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    expect(result).toMatchObject({ found: 1, sent: 1 });
    expect((await notified()).map((row) => row.ref)).toEqual([String(recent)]);
  });

  it('tells the operator a data source stopped working, once per failure', async () => {
    await connectDiscord();
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: 'a-key-that-will-be-rejected' },
    });
    const failedAt = new Date(NOW - HOUR).toISOString();
    await setConnection('bing-webmaster', { last_used_at: failedAt, last_error: 'The API key was rejected.' });

    const discord = discordFetch();
    const result = await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    expect(result).toMatchObject({ found: 1, sent: 1 });
    expect(discord.posts[0]!.content).toContain('bing-webmaster');
    expect(discord.posts[0]!.content).toContain('The API key was rejected.');
    // The credential is not the secret, and neither is the message.
    expect(discord.posts[0]!.content).not.toContain('a-key-that-will-be-rejected');
    expect(await notified()).toEqual([
      { subject: 'data-source', ref: 'bing-webmaster', condition: 'source-failing' },
    ]);

    // Still broken next hour is the SAME failure, not a second one.
    await runNotifier(env, { nowMs: NOW + HOUR, fetchImpl: discord.fetchImpl });
    expect(await notified()).toHaveLength(1);

    // A NEW failing call is a new failure, and worth saying again.
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW + 2 * HOUR).toISOString() });
    await runNotifier(env, { nowMs: NOW + 3 * HOUR, fetchImpl: discord.fetchImpl });
    expect(await notified()).toHaveLength(2);
  });

  it('records nothing when the delivery fails, so the next tick tries again', async () => {
    await connectDiscord();
    await insertFlag({});
    const rejected = discordFetch(404);
    const first = await runNotifier(env, { nowMs: NOW, fetchImpl: rejected.fetchImpl });
    expect(first).toMatchObject({ fresh: 1, sent: 0, skipped: 'delivery-failed' });
    // The mark on an Alerts row means a message LANDED, so nothing is written.
    expect(await notified()).toEqual([]);
    // And the operator hears about it where they can act: the card's verdict.
    const stamped = await credentialVerdict('discord');
    // The same short line the card's connection test stamps for a dead
    // webhook (bead ro-ujb9.96.6.25): the outcome and the status, not a
    // sentence about the server's settings.
    expect(stamped?.lastError).toBe('Refused · HTTP 404');
    expect(stamped?.lastError).not.toContain(WEBHOOK);

    const retried = discordFetch();
    const second = await runNotifier(env, { nowMs: NOW + HOUR, fetchImpl: retried.fetchImpl });
    expect(second).toMatchObject({ sent: 1 });
    expect(await notified()).toHaveLength(1);
  });

  it('never reports the notification channel itself as a broken data source', async () => {
    // A message reading "the channel you are reading this in stopped working"
    // is nonsense on arrival. The failed delivery above leaves Discord's own
    // credential Failing, and the retry must carry the ALERT and nothing else.
    await connectDiscord();
    await insertFlag({});
    await runNotifier(env, { nowMs: NOW, fetchImpl: discordFetch(404).fetchImpl });

    const retried = discordFetch();
    const result = await runNotifier(env, { nowMs: NOW + HOUR, fetchImpl: retried.fetchImpl });
    expect(result).toMatchObject({ found: 1, sent: 1 });
    expect(retried.posts[0]!.content).not.toContain('discord stopped working');
    expect((await notified()).map((row) => row.subject)).toEqual(['alert']);
  });

  it('says nothing at all when no credential is held', async () => {
    await insertFlag({});
    const discord = discordFetch();
    const result = await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    expect(result).toMatchObject({ fresh: 1, sent: 0, skipped: 'no-credential' });
    expect(discord.posts).toHaveLength(0);
  });

  it('caps one message and says how many more there were', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      condition: 'open-error' as const,
      subject: 'alert' as const,
      subjectRef: String(i),
      occurrence: '',
      line: `asset${i} — pulse: no report`,
    }));
    const message = composeMessage(many, many.slice(0, 10));
    expect(message).toContain('14 new alerts');
    // The count and nothing else: the heading already says the whole volume.
    expect(message.split('\n').at(-1)).toBe('• …and 4 more');
    // Ten lines plus the overflow line plus the heading.
    expect(message.split('\n')).toHaveLength(12);
  });
});

it('keeps successful delivery and dedupe when health recording fails', async () => {
  await connectDiscord();
  await insertFlag({});
  const discord = discordFetch();
  const undo = await refuseHealthStates();
  try {
    const result = await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    expect(result).toMatchObject({ sent: 1, skipped: null, monitoringAvailable: false });
    expect(await notified()).toHaveLength(1);
    await runNotifier(env, { nowMs: NOW + HOUR, fetchImpl: discord.fetchImpl });
    expect(discord.posts).toHaveLength(1);
  } finally { await undo(); }
});
