// The operator notification lane.
//
// Every test here injects its own `fetchImpl` and its own webhook. That is a
// safety rule, not a convenience: a suite that let this lane reach real
// `fetch` with the operator's webhook would deliver test alerts into the
// operator's own channel. The pool does not read the checkout's `.dev.vars`
// (test/test-env.test.ts), and `vitest.config.ts` binds `DISCORD_WEBHOOK_URL`
// to the empty string, so the only webhook any test can reach is one it stored
// itself — and the ones below store `https://discord.test/...`, which resolves
// nowhere.
//
// What is pinned is the design rather than the plumbing: what qualifies, what
// does not, that a recurring condition is said once, and that the record only
// ever claims a message that actually landed.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composeMessage, runNotifier } from '../src/notifier.js';
import { putCredential } from '../src/credentials.js';
import { runScheduledCron } from '../src/dispatch.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import constantsJson from './fixture-config/constants.json';
import { asOwner, credentialVerdict, emptyTables, forgetCredentials, insertFlag as storeFlag, insertPulse, pgRows, refuseHealthStates, reset, setConnection } from './helpers.js';
import { changeSites, storeSites } from './sites';

const NOW = Date.parse('2026-09-05T13:05:00.000Z');
const HOUR = 3_600_000;
const WEBHOOK = 'https://discord.test/api/webhooks/1/notifier-suite';

interface Posted {
  fetchImpl: typeof fetch;
  posts: { url: string; content: string; allowedMentions: unknown }[];
}

function discordFetch(status = 204, headers?: HeadersInit): Posted {
  const posts: Posted['posts'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as { content: string; allowed_mentions: unknown };
    posts.push({ url, content: body.content, allowedMentions: body.allowed_mentions });
    return new Response(null, { status, headers });
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
    asset: over.asset ?? 'meadow.example',
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
    // The site by the name the Tower shows.
    expect(discord.posts[0]!.content).toContain('Meadow Board — pulse: no report received in 26h');
    expect(await notified()).toEqual([
      { subject: 'alert', ref: String(id), condition: 'open-error' },
    ]);

    // THE DEDUPE, which is the whole reason the table exists: the lane runs
    // after events or recovery, and an open condition must not be re-sent.
    const again = await runNotifier(env, {
      nowMs: NOW + HOUR,
      fetchImpl: discord.fetchImpl,
    });
    expect(again).toMatchObject({ fresh: 0, sent: 0, skipped: 'nothing-to-say' });
    expect(discord.posts).toHaveLength(1);
  });

  // An alert a same-day report retry replaced stays in the store and is
  // nothing to tell the operator.
  it('says nothing about an alert a same-day report retry replaced', async () => {
    await connectDiscord();
    const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
    const first = await insertPulse({ asset: 'meadow.example', date: at(2).slice(0, 10), receivedAt: at(2) });
    const retry = await insertPulse({ asset: 'meadow.example', date: at(2).slice(0, 10), receivedAt: at(1) });
    await storeFlag({
      asset: 'meadow.example', firedAt: at(2), severity: 'error', kind: 'anomaly', metric: 'signups',
      message: 'replaced by the retry', ruleId: 'flow-poisson-low', pulseId: first, replacedByPulseId: retry,
    });
    const discord = discordFetch();

    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ found: 0, sent: 0 });
    expect(discord.posts).toEqual([]);
    expect(await notified()).toEqual([]);
  });

  it("names an alert on the OS's own row System, whatever the row stores", async () => {
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
      expect(discord.posts[0]!.content).toContain('System — pulse: the runner stopped');
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

    // Failed retries stay in one episode, including when their timestamp changes.
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW + 2 * HOUR).toISOString(), last_error: 'Still refused.' });
    await runNotifier(env, { nowMs: NOW + 3 * HOUR, fetchImpl: discord.fetchImpl });
    expect(await notified()).toHaveLength(1);
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW + 4 * HOUR).toISOString(), last_ok_at: new Date(NOW + 4 * HOUR).toISOString(), last_error: null });
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW + 5 * HOUR).toISOString(), last_error: 'Refused again.' });
    await runNotifier(env, { nowMs: NOW + 6 * HOUR, fetchImpl: discord.fetchImpl });
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
    // webhook: the outcome and the status, not a sentence about the server's
    // settings.
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

  it('sends nothing when durable delivery intent cannot be claimed', async () => {
    await connectDiscord();
    await insertFlag({});
    const memoryless = { ...env.STORE, write: async () => { throw new Error('fixture: outbox unavailable'); } };
    const discord = discordFetch();
    const result = await runNotifier({ ...env, STORE: memoryless }, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    expect(result).toEqual({ found: 0, fresh: 0, sent: 0, skipped: 'store-unavailable' });
    expect(discord.posts).toHaveLength(0);
    expect(await notified()).toEqual([]);
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

async function queued() {
  return pgRows<{ state: string; attempts: number; due: string; lease: string | null; subject: string; ref: string }>(
    `SELECT state, attempts, next_attempt_at AS due, lease_id::text AS lease, subject, subject_ref AS ref
       FROM noticeos.notification_outbox ORDER BY subject_ref, occurred_at`,
  );
}

function pauseCredentialRead() {
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const original = env.STORE;
  let blocked = false;
  const store: typeof original = { ...original, read: async work => {
    if (!blocked) { blocked = true; entered(); await released; }
    return original.read(work);
  } };
  return { store, started, release };
}

describe('durable event delivery', () => {
  it('honors the saved pause for an event-triggered dispatch before claiming work', async () => {
    await connectDiscord();
    await insertFlag({});
    await emptyTables(['config_documents']);
    forgetConfigCache();
    try {
      const constants = { ...structuredClone(constantsJson), schedules: { notifications: { enabled: false, cron: '5 * * * *' } } };
      expect(await seedConfigDocuments(env, { documents: { 'config/constants.json': constants }, actor: 'config:seed' }, NOW)).toMatchObject({ ok: true });
      const result = await runScheduledCron('5 * * * *', env, 'event');
      expect(result.outcome).toBe('skipped');
      expect(result.steps?.find(step => step.id === 'notify')?.state).toBe('skipped');
      expect((await queued())[0]).toMatchObject({ state: 'pending', attempts: 0, lease: null });
      expect(await notified()).toEqual([]);
    } finally {
      await emptyTables(['config_documents']);
      forgetConfigCache();
    }
  });

  it('records failed notification delivery as a failed event dispatch', async () => {
    await connectDiscord();
    await insertFlag({ firedAt: new Date().toISOString() });
    const failed = discordFetch(503);
    const intercepted = vi.spyOn(globalThis, 'fetch').mockImplementation(failed.fetchImpl);
    try {
      const result = await runScheduledCron('5 * * * *', env, 'event');
      expect(result.outcome).toBe('failed');
      expect(result.steps?.find(step => step.id === 'notify')?.state).toBe('failed');
      expect(failed.posts).toHaveLength(1);
      expect(await notified()).toEqual([]);
    } finally { intercepted.mockRestore(); }
  });

  it('rechecks acknowledgement after waiting for a credential', async () => {
    await connectDiscord();
    const id = await insertFlag({});
    const gate = pauseCredentialRead();
    const discord = discordFetch();
    const run = runNotifier({ ...env, STORE: gate.store }, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    try {
      await gate.started;
      await env.STORE.write(tx => tx.execute(`UPDATE noticeos.flags SET disposition = 'ack' WHERE flag_number = $1`, [id]));
    } finally { gate.release(); }
    expect(await run).toMatchObject({ sent: 0 });
    expect(discord.posts).toHaveLength(0);
    expect((await queued())[0]!.state).toBe('cancelled');
  });

  it('prevents a consumer whose lease was replaced while reading credentials from sending', async () => {
    await connectDiscord();
    await insertFlag({});
    const gate = pauseCredentialRead();
    const discord = discordFetch();
    const run = runNotifier({ ...env, STORE: gate.store }, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    try {
      await gate.started;
      await env.STORE.write(tx => tx.execute(`UPDATE noticeos.notification_outbox
        SET lease_id = $1::uuid, lease_until = $2::timestamptz`, [crypto.randomUUID(), new Date(NOW + 300_000).toISOString()]));
    } finally { gate.release(); }
    expect(await run).toMatchObject({ sent: 0 });
    expect(discord.posts).toHaveLength(0);
    expect(await notified()).toEqual([]);
  });

  it('serializes concurrent recovery of a pre-upgrade connection failure', async () => {
    await connectDiscord();
    await putCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: 'synthetic-key' } });
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW - HOUR).toISOString(), last_error: 'Synthetic failure' });
    await asOwner('TRUNCATE noticeos.notification_outbox');
    const discord = discordFetch();
    const results = await Promise.all([
      runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl, recover: true }),
      runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl, recover: true }),
    ]);
    expect(results.reduce((sent, result) => sent + result.sent, 0)).toBe(1);
    expect(discord.posts).toHaveLength(1);
    expect(await queued()).toHaveLength(1);
    expect(await notified()).toHaveLength(1);
  });

  it('preserves a source receipt written by the previous release while the new trigger was installed', async () => {
    await connectDiscord();
    await putCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: 'synthetic-key' } });
    await asOwner("UPDATE noticeos.integration_connections SET created_at = '2026-09-05T10:00:00Z' WHERE provider = 'bing-webmaster'");
    const failedAt = new Date(NOW - HOUR).toISOString();
    await setConnection('bing-webmaster', { last_used_at: failedAt, last_error: 'Synthetic failure' });
    expect(await queued()).toHaveLength(1);
    await env.STORE.write(tx => tx.execute(`INSERT INTO noticeos.notifications
      (workspace_id, channel, subject, subject_ref, occurrence, condition, sent_at)
      VALUES ($1::uuid, 'discord', 'data-source', 'bing-webmaster', $2, 'source-failing', $3::timestamptz)`,
    [tx.workspaceId, failedAt, new Date(NOW - 30_000).toISOString()]));
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 0 });
    expect(discord.posts).toHaveLength(0);
    expect((await queued())[0]!.state).toBe('sent');
    expect(await notified()).toHaveLength(1);
  });

  it('keeps overflow pending until its own message is delivered', async () => {
    await connectDiscord();
    for (let i = 0; i < 14; i++) await insertFlag({ metric: `metric-${i}` });
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 10 });
    expect(await notified()).toHaveLength(10);
    expect((await queued()).filter(row => row.state === 'pending')).toHaveLength(4);
    expect(discord.posts[0]!.content).toContain('10 new alerts');
    expect(discord.posts[0]!.content).not.toContain('more');
    expect(await runNotifier(env, { nowMs: NOW + 1, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 4 });
    expect(await notified()).toHaveLength(14);
    expect((await queued()).every(row => row.state === 'sent')).toBe(true);
  });

  it('prevents overlapping consumers from sending the same leased batch', async () => {
    await connectDiscord();
    await insertFlag({});
    const discord = discordFetch();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const first = runNotifier(env, { nowMs: NOW, fetchImpl: async (input, init) => {
      entered();
      await released;
      return discord.fetchImpl(input, init);
    } });
    try {
      await started;
      expect(await runNotifier(env, { nowMs: NOW + 1, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 0 });
      expect(await notified()).toEqual([]);
    } finally { release(); }
    expect(await first).toMatchObject({ sent: 1 });
    expect(discord.posts).toHaveLength(1);
    expect(await notified()).toHaveLength(1);
  });

  it('reclaims a crashed consumer’s lease only after it expires', async () => {
    await connectDiscord();
    await insertFlag({});
    await env.STORE.write(tx => tx.execute(`UPDATE noticeos.notification_outbox
      SET lease_id = $1::uuid, lease_until = $2::timestamptz, attempts = 1`,
    [crypto.randomUUID(), new Date(NOW + 120_000).toISOString()]));
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW + 119_999, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 0 });
    expect(discord.posts).toHaveLength(0);
    expect(await runNotifier(env, { nowMs: NOW + 120_000, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 1 });
    expect((await queued())[0]).toMatchObject({ state: 'sent', attempts: 2, lease: null });
  });

  it('persists retry deadlines and respects Discord’s Retry-After', async () => {
    await connectDiscord();
    await insertFlag({});
    const limited = discordFetch(429, { 'retry-after': '90' });
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: limited.fetchImpl })).toMatchObject({ skipped: 'delivery-failed' });
    const [pending] = await queued();
    expect(pending).toMatchObject({ state: 'pending', attempts: 1, lease: null });
    const due = Date.parse(pending!.due);
    expect(due).toBeGreaterThanOrEqual(NOW + 90_000);
    expect(due).toBeLessThan(NOW + 91_000);
    expect(await notified()).toEqual([]);
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: due - 1, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 0 });
    expect(discord.posts).toHaveLength(0);
    expect(await runNotifier(env, { nowMs: due, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 1 });
    expect((await queued())[0]).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('backs off failed deliveries without marking them notified', async () => {
    await connectDiscord();
    await insertFlag({});
    const failed = discordFetch(503);
    await runNotifier(env, { nowMs: NOW, fetchImpl: failed.fetchImpl });
    const firstDue = Date.parse((await queued())[0]!.due);
    expect(firstDue).toBeGreaterThanOrEqual(NOW + 30_000);
    expect(firstDue).toBeLessThan(NOW + 31_000);
    await runNotifier(env, { nowMs: firstDue, fetchImpl: failed.fetchImpl });
    const secondDue = Date.parse((await queued())[0]!.due);
    expect(secondDue).toBeGreaterThanOrEqual(firstDue + 60_000);
    expect(secondDue).toBeLessThan(firstDue + 61_000);
    expect(await notified()).toEqual([]);
  });

  it.each(['acknowledged', 'resolved'] as const)('cancels an alert %s before delivery', async change => {
    await connectDiscord();
    const id = await insertFlag({});
    await env.STORE.write(tx => tx.execute(change === 'acknowledged'
      ? `UPDATE noticeos.flags SET disposition = 'ack', disposition_at = $2::timestamptz WHERE flag_number = $1`
      : `UPDATE noticeos.flags SET resolved_at = $2::timestamptz WHERE flag_number = $1`, [id, new Date(NOW).toISOString()]));
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 0 });
    expect(discord.posts).toHaveLength(0);
    expect((await queued())[0]).toMatchObject({ state: 'cancelled', lease: null });
    expect(await notified()).toEqual([]);
  });

  it('cancels queued intent when a report retry replaces the alert', async () => {
    await connectDiscord();
    const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
    const first = await insertPulse({ asset: 'meadow.example', date: at(2).slice(0, 10), receivedAt: at(2) });
    const id = await storeFlag({ asset: 'meadow.example', firedAt: at(2), severity: 'error', kind: 'anomaly',
      metric: 'signups', message: 'superseded reading', ruleId: 'flow-poisson-low', pulseId: first });
    const retry = await insertPulse({ asset: 'meadow.example', date: at(2).slice(0, 10), receivedAt: at(1) });
    await env.STORE.write(tx => tx.execute(`UPDATE noticeos.flags SET replaced_by_pulse_id = $2 WHERE flag_number = $1`, [id, retry]));
    const discord = discordFetch();
    await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl });
    expect(discord.posts).toHaveLength(0);
    expect((await queued())[0]).toMatchObject({ state: 'cancelled' });
  });

  it('delivers an escalation even when the original warning is older than the notification horizon', async () => {
    await connectDiscord();
    const id = await insertFlag({ severity: 'warn', firedAt: new Date(NOW - 30 * HOUR).toISOString() });
    await env.STORE.write(tx => tx.execute(`INSERT INTO noticeos.flag_evidence
      (workspace_id, flag_id, observed_at, severity, message)
      SELECT workspace_id, flag_id, $2::timestamptz, 'error', 'Condition escalated'
        FROM noticeos.flags WHERE flag_number = $1`, [id, new Date(NOW - 1_000).toISOString()]));
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 1 });
    expect(discord.posts[0]!.content).toContain('Condition escalated');
  });

  it('cancels an old connection episode after recovery and sends a later failure', async () => {
    await connectDiscord();
    await putCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: 'synthetic-key' } });
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW - HOUR).toISOString(), last_error: 'First failure' });
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW - 30_000).toISOString(),
      last_ok_at: new Date(NOW - 30_000).toISOString(), last_error: null });
    await setConnection('bing-webmaster', { last_used_at: new Date(NOW - 1_000).toISOString(), last_error: 'Second failure' });
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 1 });
    expect(discord.posts[0]!.content).toContain('Second failure');
    expect((await queued()).map(row => row.state)).toEqual(['cancelled', 'sent']);
    expect(await notified()).toHaveLength(1);
  });

  it('recovers pre-upgrade intent and preserves old successful delivery receipts', async () => {
    await connectDiscord();
    await insertFlag({});
    const old = await insertFlag({ metric: 'previously-notified' });
    await env.STORE.write(tx => tx.execute(`INSERT INTO noticeos.notifications
      (workspace_id, channel, subject, subject_ref, occurrence, condition, sent_at)
      VALUES ($1::uuid, 'discord', 'alert', $2, '', 'open-error', $3::timestamptz)`,
    [tx.workspaceId, String(old), new Date(NOW - 1000).toISOString()]));
    await asOwner('TRUNCATE noticeos.notification_outbox');
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 0 });
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl, recover: true })).toMatchObject({ sent: 1 });
    expect(discord.posts).toHaveLength(1);
    expect(discord.posts[0]!.content).not.toContain('previously-notified');
    expect(await notified()).toHaveLength(2);
    expect(await runNotifier(env, { nowMs: NOW + 1, fetchImpl: discord.fetchImpl, recover: true })).toMatchObject({ sent: 0 });
  });

  it('bounds Discord content and disables mentions from alert text', async () => {
    await connectDiscord();
    for (let i = 0; i < 10; i++) await insertFlag({ metric: `metric-${i}`, message: `@everyone\n${'x'.repeat(1000)}` });
    const discord = discordFetch();
    expect(await runNotifier(env, { nowMs: NOW, fetchImpl: discord.fetchImpl })).toMatchObject({ sent: 10 });
    expect(discord.posts[0]!.content.length).toBeLessThanOrEqual(2000);
    expect(discord.posts[0]!.content.split('\n')).toHaveLength(11);
    expect(discord.posts[0]!.allowedMentions).toEqual({ parse: [] });
    expect(await notified()).toHaveLength(10);
  });
});
