import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dates, type Period } from '@noticeos/mediavine';
import { discoverMediavineSites, withMediavineLease } from '../src/mediavine-connection.js';
import { disconnectMediavine, putMediavineCredential, runMediavine, saveMediavineSettings, syncMediavine } from '../src/mediavine.js';
import { connectCredential } from '../src/credential-connect.js';
import { discoverSites } from '../src/site-discovery.js';
import { runCollectNow } from '../src/dispatch.js';
import { mediavineSyncOn } from '@noticeos/contract';
import { resolveCredential, saveMediavineSession, rotateCredentialKeys } from '../src/credentials.js';
import { probeCredential } from '../src/credential-probes.js';
import { applyConfigOps, forgetConfigCache, getConfigDocument } from '../src/config-store.js';
import { bookEntry, call, credentialVerdict, reset, emptyTables, storedCount, storedCredential, storedHealthStates } from './helpers.js';
import { OPERATOR_TOKEN } from './fixtures.js';

const NOW = Date.parse('2026-09-09T13:10:00Z');
const ASSET = 'meadow.example';
const SITE = { id: 'synthetic-site', title: 'Test publisher', domain: 'example.test' };
const SECRET = 'synthetic-private-password';
const reportPeriod = (value: string) => `${value.slice(6)}-${value.slice(0, 2)}-${value.slice(3, 5)}`;
function transport(options: { revenue?: number | null; status?: number; retryAfter?: string } = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string | null> };
    if (body.query.includes('unidashSignIn')) return Response.json({ data: { unidashSignIn: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresIn: 3600, twoFactorRequired: false } } });
    if (body.query.includes('unidashRefreshToken')) return Response.json({ data: { unidashRefreshToken: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresIn: 3600 } } });
    if (body.query.includes('sitesForUser')) return Response.json({ data: { sitesForUser: { edges: [{ node: SITE }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (options.status) return new Response('', { status: options.status, headers: options.retryAfter ? { 'retry-after': options.retryAfter } : undefined });
    const period: Period = { start: reportPeriod(body.variables.startDate!), end: reportPeriod(body.variables.endDate!) };
    const days = dates(period);
    const value = options.revenue === undefined ? 1.25 : options.revenue;
    return Response.json({ data: { internalSite: SITE, metricsSummary: { summary: { earnings: days.length * (value ?? 0) + 0.02 } }, earningsReport: { earnings: days.map(date => ({ date: date.replaceAll('-', '/'), revenue: value })) } } });
  });
}
async function connect() {
  expect((await putMediavineCredential(env, { provider: 'mediavine', fields: { MEDIAVINE_USER: 'fake@example.test', MEDIAVINE_PASSWORD: SECRET } })).ok).toBe(true);
  const fetchImpl = transport();
  expect((await discoverMediavineSites(env, { fetchImpl, nowMs: NOW })).ok).toBe(true);
  const saved = await saveMediavineSettings(env, { asset: ASSET, siteId: SITE.id, enabled: true });
  if (!saved.ok) throw new Error(saved.message);
  return fetchImpl;
}
/** The site's ad-revenue cell, read fresh from the store. */
async function adRevenueCell(asset = ASSET) {
  forgetConfigCache(env.STORE);
  const body = (await getConfigDocument(env, 'config/integrations.json')).body as { assets: Record<string, Record<string, Record<string, unknown>>> };
  return body.assets[asset]!['ad-network']!;
}
/** The Ad revenue row's Not using, as it writes it: the reason and the
 * posture in one changeset (`declineOps`, apps/tower/shared/lane-decline.ts). */
async function declineAdRevenue(asset = ASSET, reason = 'REASON: Replaced by another tool') {
  const cell = await adRevenueCell(asset);
  const op = (field: string, value: string) => ({ kind: 'file-json-set' as const, file: 'config/integrations.json',
    pointer: `/assets/${asset}/ad-network/${field}`, value,
    ...(cell[field] === undefined ? { expectAbsent: true as const } : { expect: cell[field] as string }) });
  const result = await applyConfigOps(env, { actor: 'operator', ops: [op('note', reason), op('status', 'skipped')] });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}
/** Every ad-network cell the store holds as `skipped`, and its note. */
async function skippedAdRevenue() {
  forgetConfigCache(env.STORE);
  const body = (await getConfigDocument(env, 'config/integrations.json')).body as { assets: Record<string, Record<string, { status?: string; note?: string }>> };
  return Object.entries(body.assets).flatMap(([asset, lanes]) =>
    lanes['ad-network']?.status === 'skipped' ? [{ asset, note: lanes['ad-network'].note ?? '' }] : []);
}
async function count(table: 'mediavine_daily' | 'mediavine_runs') {
  return storedCount(`SELECT count(*)::int AS n FROM noticeos.${table}`);
}
/** The site's revenue as every financial page reads it: its sum in exact cents, and its rows. */
async function total() {
  const [row] = await env.STORE.read((tx) => tx.query<{ amount: bigint | null; rows: number }>(
    `SELECT SUM(amount_minor)::bigint AS amount, count(*)::int AS rows FROM noticeos.financial_ledger WHERE asset_id = $1 AND kind = 'revenue'`, [ASSET]));
  return { amount: row?.amount === null || row?.amount === undefined ? null : Number(row.amount), rows: row?.rows ?? 0 };
}
/** The site's retry state, as the store keeps it. */
async function retryState() {
  return (await env.STORE.read((tx) => tx.query('SELECT * FROM noticeos.mediavine_state WHERE asset_id = $1', [ASSET])))[0] ?? null;
}
/** The site's first ledger entry's amount, in cents. */
async function firstEntryMinor() {
  const [row] = await env.STORE.read((tx) => tx.query<{ amount_minor: bigint }>(
    'SELECT amount_minor FROM noticeos.ledger_entries ORDER BY entry_id LIMIT 1'));
  return row === undefined ? null : Number(row.amount_minor);
}
beforeEach(async () => {
  await reset();
  await emptyTables(['config_changes']);
  await emptyTables(['config_documents']);
});
describe('Mediavine encrypted connection and controls', () => {
  it('saves the forecast calendar without making provider requests or clearing sync limits', async () => {
    const fetchImpl = await connect();
    await syncMediavine(env, { asset: ASSET }, { fetchImpl, nowMs: NOW });
    const before = await retryState();
    const calls = fetchImpl.mock.calls.length;
    const result = await saveMediavineSettings(env, { asset: ASSET, siteId: SITE.id, enabled: true, holidayCalendar: 'US' });
    expect(result).toMatchObject({ ok: true, value: { holidayCalendar: 'US', enabled: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    expect(await retryState()).toEqual(before);
  });
  it('discovers sites through the default native fetch and an isolated outbound service', async () => {
    const response = await (env as typeof env & { NATIVE_MEDIAVINE: Fetcher }).NATIVE_MEDIAVINE.fetch('https://test.invalid/');
    expect(await response.json()).toEqual([SITE]);
    expect(response.status).toBe(200);
  });
  it('authenticates and imports using request options accepted by the native Worker runtime', async () => {
    await putMediavineCredential(env, { provider: 'mediavine', fields: { MEDIAVINE_USER: 'fake@example.test', MEDIAVINE_PASSWORD: SECRET } });
    const source = transport();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      // Exercise workerd's native request validation before the synthetic response.
      // A plain fetch mock misses unsupported options such as redirect: 'error'.
      new Request(url, init);
      return source(url, init);
    });
    expect((await discoverMediavineSites(env, { fetchImpl, nowMs: NOW })).ok).toBe(true);
    expect((await saveMediavineSettings(env, { asset: ASSET, siteId: SITE.id, enabled: true })).ok).toBe(true);
    expect((await syncMediavine(env, { asset: ASSET }, { fetchImpl, nowMs: NOW })).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await count('mediavine_daily')).toBe(8);
  });
  it('key rotation cannot overwrite a concurrently refreshed session', async () => {
    await connect();
    const next = { ...env, CREDENTIALS_KEY_PREVIOUS: env.CREDENTIALS_KEY,
      CREDENTIALS_KEY: btoa('0123456789abcdef0123456789abcdef') };
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    let interrupted = false;
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      if (!interrupted) {
        interrupted = true;
        await saveMediavineSession(next, JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: NOW + 3_600_000 }));
      }
      return original(algorithm, key, data);
    });
    try {
      const rotated = await rotateCredentialKeys(next);
      expect(rotated.contended).toContain('mediavine');
      expect((await resolveCredential(next, 'mediavine')).fields.MEDIAVINE_SESSION).toContain('new-refresh');
    } finally { spy.mockRestore(); }
  });
  it('does not restamp cached or busy probes and throttles failed probes', async () => {
    await connect(); const fetchImpl = transport();
    const cached = await probeCredential(env, 'mediavine', { fetchImpl, nowMs: NOW + 500 });
    expect(cached.checkedAt).toBe(new Date(NOW).toISOString());
    await withMediavineLease(env, async () => {
      expect((await probeCredential(env, 'mediavine', { fetchImpl, nowMs: NOW + 500 })).ok).toBe(false);
    }, { nowMs: NOW });
    expect(await credentialVerdict('mediavine')).toEqual({ lastError: null, lastOkAt: new Date(NOW).toISOString() });
    const refused = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    await discoverMediavineSites(env, { fetchImpl: refused, nowMs: NOW + 3_600_000 });
    await discoverMediavineSites(env, { fetchImpl: refused, nowMs: NOW + 3_600_001 });
    expect(refused).toHaveBeenCalledTimes(1);
  });
  it('sees a pause from another isolate despite a warm configuration cache', async () => {
    await connect();
    const config = await getConfigDocument(env, 'config/integrations.json');
    // A pause is the site's Not using.
    const changed = structuredClone(config.body) as { assets: Record<string, Record<string, { status: string }>> };
    changed.assets[ASSET]!['ad-network']!.status = 'skipped';
    await env.STORE.write((tx) => tx.execute("UPDATE noticeos.config_documents SET body = $1::json WHERE document_key = 'integrations'", [JSON.stringify(changed)]));
    const fetchImpl = transport(); await runMediavine(env, { fetchImpl, nowMs: NOW });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('checks pause again after token refresh, before requesting the report', async () => {
    await connect();
    const source = transport();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const response = await source(url, init);
      const config = await getConfigDocument(env, 'config/integrations.json');
      const changed = structuredClone(config.body) as { assets: Record<string, Record<string, { status: string }>> };
      changed.assets[ASSET]!['ad-network']!.status = 'skipped';
      await env.STORE.write((tx) => tx.execute("UPDATE noticeos.config_documents SET body = $1::json WHERE document_key = 'integrations'", [JSON.stringify(changed)]));
      return response;
    });
    await runMediavine(env, { fetchImpl, nowMs: NOW + 86_400_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(await count('mediavine_daily')).toBe(0);
  });
  it('stores session encrypted, reuses it across fresh clients, and caches site discovery', async () => {
    const fetchImpl = await connect();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await discoverMediavineSites(env, { fetchImpl, nowMs: NOW + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const stored = await storedCredential('mediavine');
    expect(new TextDecoder().decode(stored!.ciphertext)).not.toContain(SECRET);
    // The session is the store's own: sealed with the login, never named in the clear.
    expect(stored!.field_names).toEqual(['MEDIAVINE_USER', 'MEDIAVINE_PASSWORD']);
    expect(JSON.stringify(stored)).not.toContain('synthetic-access');
    const result = await syncMediavine(env, { asset: ASSET }, { fetchImpl, nowMs: NOW });
    expect(result.ok).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(access|refresh|private)/);
    expect((await resolveCredential(env, 'mediavine')).fields.MEDIAVINE_SESSION).toContain('synthetic-refresh');
  });
  it('allows only one provider operation at a time', async () => {
    await connect();
    const fetchImpl = transport();
    await withMediavineLease(env, async () => {
      expect((await syncMediavine(env, { asset: ASSET }, { fetchImpl, nowMs: NOW })).ok).toBe(false);
      expect((await discoverMediavineSites(env, { fetchImpl, nowMs: NOW })).ok).toBe(false);
    }, { nowMs: NOW });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('pause stops scheduled calls, preserves history, and disconnect removes credentials/session', async () => {
    await connect(); const fetchImpl = transport();
    await syncMediavine(env, { asset: ASSET }, { fetchImpl, nowMs: NOW });
    // A pause is the site's Not using, with its reason.
    await declineAdRevenue();
    fetchImpl.mockClear(); await runMediavine(env, { fetchImpl, nowMs: NOW + 86_400_000 });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(await count('mediavine_daily')).toBe(8);
    await disconnectMediavine(env);
    expect((await resolveCredential(env, 'mediavine')).source).toBe('none');
    expect(await count('mediavine_daily')).toBe(8);
  });
  // Switching a running sync off here would record a decline nobody explained.
  // The settings door starts a sync and never writes `skipped`; stopping is
  // the row's Not using, which saves the reason with it.
  it('never switches a running sync off, and no skipped ad revenue cell is ever written without its reason', async () => {
    await connect();
    const before = await adRevenueCell();
    expect(before.status).toBe('needs-setup');
    const refused = await saveMediavineSettings(env, { asset: ASSET, siteId: SITE.id, enabled: false });
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/Not using/) });
    expect(await adRevenueCell()).toEqual(before);
    expect(await skippedAdRevenue()).toEqual([]);

    // The row's Not using, then a forecast-calendar save on the stopped site:
    // the posture and its reason stay exactly as the row wrote them.
    await declineAdRevenue();
    const saved = await saveMediavineSettings(env, { asset: ASSET, siteId: SITE.id, enabled: false, holidayCalendar: 'US' });
    expect(saved).toMatchObject({ ok: true, value: { enabled: false, holidayCalendar: 'US' } });
    expect(await adRevenueCell()).toMatchObject({ status: 'skipped', note: 'REASON: Replaced by another tool', revenueHolidayCalendar: 'US' });

    // Starting it again is this door's to do, and writes no decline.
    expect((await saveMediavineSettings(env, { asset: ASSET, siteId: SITE.id, enabled: true })).ok).toBe(true);
    expect((await adRevenueCell()).status).toBe('needs-setup');
    for (const cell of await skippedAdRevenue()) expect(cell.note).toMatch(/reason/i);
  });
  it('does not import Mediavine environment credentials after disconnect', async () => {
    const legacy = { ...env, MEDIAVINE_USER: 'legacy', MEDIAVINE_PASSWORD: SECRET };
    const result = await resolveCredential(legacy, 'mediavine');
    expect(result.source).toBe('none'); expect(result.fields).toEqual({});
  });
  it('refuses a site outside the discovered account', async () => {
    await connect();
    expect((await saveMediavineSettings(env, { asset: ASSET, siteId: 'not-authorized', enabled: true })).ok).toBe(false);
  });
});
describe('daily accounting', () => {
  it('fills earlier holes after the first manual single-day fetch', async () => {
    await connect();
    await syncMediavine(env, { asset: ASSET, start: '2026-09-08', end: '2026-09-08' }, { fetchImpl: transport(), nowMs: NOW });
    expect((await runMediavine(env, { fetchImpl: transport(), nowMs: NOW + 3_600_000 })).outcome).toBe('ran');
    expect(await count('mediavine_daily')).toBe(8);
  });
  it('recognizes a payment under another source through its original estimate', async () => {
    await connect();
    const estimate = await bookEntry({ kind: 'revenue', asset: ASSET, period: '2026-09', family: 'ads', amountMinor: 1000, source: 'mediavine-journey', bookingState: 'estimated' });
    await bookEntry({ kind: 'revenue', asset: ASSET, period: '2026-09', family: 'ads', amountMinor: 1100, source: 'bank-payment', bookingState: 'reconciled', supersedesId: estimate.entryId });
    await syncMediavine(env, { asset: ASSET }, { fetchImpl: transport(), nowMs: NOW });
    expect(await total()).toEqual({ amount: 1100, rows: 1 });
  });
  it('refuses history reassignment through generic config edits before provider requests', async () => {
    await connect();
    await syncMediavine(env, { asset: ASSET }, { fetchImpl: transport(), nowMs: NOW });
    const config = await getConfigDocument(env, 'config/integrations.json');
    const changed = structuredClone(config.body) as { assets: Record<string, Record<string, { mediavineSiteId?: string; mediavineEnabled?: boolean }>> };
    delete changed.assets[ASSET]!['ad-network']!.mediavineSiteId;
    changed.assets['northwind.example']!['ad-network']!.mediavineSiteId = SITE.id;
    changed.assets['northwind.example']!['ad-network']!.mediavineEnabled = true;
    await env.STORE.write((tx) => tx.execute("UPDATE noticeos.config_documents SET body = $1::json WHERE document_key = 'integrations'", [JSON.stringify(changed)]));
    const fetchImpl = transport();
    const result = await syncMediavine(env, { asset: 'northwind.example' }, { fetchImpl, nowMs: NOW + 3_600_000 });
    expect(result.ok).toBe(false); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('books current-month coverage once, then fetches only the next yesterday after a refresh', async () => {
    await connect(); const fetchImpl = transport();
    await runMediavine(env, { fetchImpl, nowMs: NOW });
    expect(await count('mediavine_daily')).toBe(8); expect(await total()).toEqual({ amount: 1000, rows: 1 });
    expect((await runMediavine(env, { fetchImpl, nowMs: NOW + 3_600_000 })).outcome).toBe('skipped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await runMediavine(env, { fetchImpl, nowMs: NOW + 86_400_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]!.body)).variables).toMatchObject({ startDate: '09/09/2026', endDate: '09/09/2026' });
    expect(await total()).toEqual({ amount: 1125, rows: 1 });
  });
  it('replays unchanged rows once and appends revisions, including a return to an older value', async () => {
    await connect();
    for (const [i, revenue] of [1.25, 1.25, 2, 1.25].entries()) {
      expect((await syncMediavine(env, { asset: ASSET, start: '2026-09-08', end: '2026-09-08' }, { fetchImpl: transport({ revenue }), nowMs: NOW + i * 3_600_000 })).ok).toBe(true);
    }
    expect(await count('mediavine_daily')).toBe(3);
    expect(await total()).toEqual({ amount: 125, rows: 1 });
    expect(await count('mediavine_runs')).toBe(4);
  });
  it('retains a partial CSV until daily coverage includes every old day, without double-counting', async () => {
    await connect();
    // Booked as an import books it: the note's coverage (through 09-07) is stored as its coverage end.
    await bookEntry({ kind: 'revenue', asset: ASSET, period: '2026-09', family: 'ads', amountMinor: 900, source: 'mediavine-journey', bookingState: 'estimated', note: 'Mediavine Journey, 7/30 days — PARTIAL, covers 2026-09-01..2026-09-07' });
    await syncMediavine(env, { asset: ASSET, start: '2026-09-08', end: '2026-09-08' }, { fetchImpl: transport(), nowMs: NOW });
    expect(await total()).toEqual({ amount: 900, rows: 1 });
    await syncMediavine(env, { asset: ASSET, start: '2026-09-01', end: '2026-09-08' }, { fetchImpl: transport(), nowMs: NOW + 3_600_000 });
    expect(await total()).toEqual({ amount: 1000, rows: 1 });
    expect(await firstEntryMinor()).toBe(900);
  });
  it.each([
    'Mediavine Journey, 7/30 days — PARTIAL, covers 2026-09-01..2026-09-07',
    'Dashboard description with different wording',
  ])('uses explicit partial coverage for daily replacement regardless of note wording (%s)', async (note) => {
    await connect();
    const posted = await call(new Request('https://ingest.local/api/revenue', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
      body: JSON.stringify([{ kind: 'revenue', asset: ASSET, period: '2026-09', family: 'ads', amount: 9, source: 'mediavine-journey', booking_state: 'estimated',
        note, coverage_start: '2026-09-01', coverage_end: '2026-09-07', coverage_complete: false }]),
    }));
    expect(posted.status).toBe(200);
    expect(await storedCount("SELECT count(*)::int AS n FROM noticeos.ledger_entries WHERE coverage_end = '2026-09-07'")).toBe(1);
    await syncMediavine(env, { asset: ASSET, start: '2026-09-08', end: '2026-09-08' }, { fetchImpl: transport(), nowMs: NOW });
    expect(await total()).toEqual({ amount: 900, rows: 1 });
    await syncMediavine(env, { asset: ASSET, start: '2026-09-01', end: '2026-09-08' }, { fetchImpl: transport(), nowMs: NOW + 3_600_000 });
    expect(await total()).toEqual({ amount: 1000, rows: 1 });
  });
  it('keeps reconciled payments authoritative and includes unrelated revenue with no source', async () => {
    await connect();
    await syncMediavine(env, { asset: ASSET }, { fetchImpl: transport(), nowMs: NOW });
    const posted = await call(new Request('https://ingest.local/api/revenue', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
      body: JSON.stringify([
        { kind: 'revenue', asset: ASSET, period: '2026-09', family: 'ads', amount: 9, source: 'mediavine-journey', booking_state: 'estimated',
          external_id: 'coverage-estimate', coverage_start: '2026-09-01', coverage_end: '2026-09-07', coverage_complete: false },
        { kind: 'revenue', asset: ASSET, period: '2026-09', family: 'ads', amount: 12, source: 'bank-payment', booking_state: 'reconciled',
          external_id: 'coverage-payment', supersedes_external_id: 'mediavine-journey:coverage-estimate',
          coverage_start: '2026-09-01', coverage_end: '2026-09-30', coverage_complete: true, note: 'Payment received' },
      ]),
    }));
    expect(await posted.json()).toMatchObject({ inserted: 2, failed: 0 });
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.ledger_entries
      WHERE external_id = 'bank-payment:coverage-payment' AND coverage_start = '2026-09-01'
        AND coverage_end = '2026-09-30' AND coverage_complete = true AND supersedes_id IS NOT NULL`)).toBe(1);
    await bookEntry({ kind: 'revenue', asset: ASSET, period: '2026-09', family: 'affiliate', amountMinor: 99, bookingState: 'estimated' });
    expect(await total()).toEqual({ amount: 1299, rows: 2 });
  });
  it('requires full-month coverage before replacing a CSV with unknown coverage', async () => {
    await connect();
    await bookEntry({ kind: 'revenue', asset: ASSET, period: '2026-08', family: 'ads', amountMinor: 5000, source: 'mediavine', bookingState: 'estimated' });
    await syncMediavine(env, { asset: ASSET, start: '2026-08-02', end: '2026-08-31' }, { fetchImpl: transport(), nowMs: NOW });
    expect(await total()).toEqual({ amount: 5000, rows: 1 });
    await syncMediavine(env, { asset: ASSET, start: '2026-08-01', end: '2026-08-01' }, { fetchImpl: transport(), nowMs: NOW + 3_600_000 });
    expect(await total()).toEqual({ amount: 3875, rows: 1 });
  });
  it('does not overwrite saved revenue with an incomplete report', async () => {
    await connect();
    await syncMediavine(env, { asset: ASSET }, { fetchImpl: transport(), nowMs: NOW });
    const result = await syncMediavine(env, { asset: ASSET, start: '2026-09-01', end: '2026-09-08' }, { fetchImpl: transport({ revenue: null }), nowMs: NOW + 3_600_000 });
    expect(result.ok).toBe(false); expect(await total()).toEqual({ amount: 1000, rows: 1 });
  });
});
describe('request budget and scheduling', () => {
  it('stops automatic requests after permission denial without trying to reauthenticate', async () => {
    await connect(); const fetchImpl = transport({ status: 403 });
    expect((await runMediavine(env, { fetchImpl, nowMs: NOW })).outcome).toBe('failed');
    expect((await runMediavine(env, { fetchImpl, nowMs: NOW + 86_400_000 })).outcome).toBe('skipped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('makes no provider call before 6:10 Pacific', async () => {
    await connect(); const fetchImpl = transport();
    await runMediavine(env, { fetchImpl, nowMs: NOW - 1 }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('stops after three failures in one day and respects durable backoff across fresh clients', async () => {
    await connect(); const fetchImpl = transport({ status: 503 });
    for (const minutes of [0, 1, 20, 30, 60, 120, 300]) await runMediavine(env, { fetchImpl, nowMs: NOW + minutes * 60_000 });
    const reports = fetchImpl.mock.calls.filter(([, init]) => String(init?.body).includes('earningsReport'));
    expect(reports).toHaveLength(3); expect(await count('mediavine_runs')).toBe(3);
  });
  it('honors Retry-After for manual probes and subsequent scheduled attempts', async () => {
    await connect(); const fetchImpl = transport({ status: 429, retryAfter: '7200' });
    await runMediavine(env, { fetchImpl, nowMs: NOW });
    await runMediavine(env, { fetchImpl, nowMs: NOW + 3_600_000 });
    expect((await discoverMediavineSites(env, { fetchImpl, nowMs: NOW + 3_600_000 })).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// The connect panel: the login is shown to Mediavine before it is kept, the
// account's sites are listed without a second sign-in, Start's one write — the
// site id — is what starts the sync, and Disconnect forgets the login and
// nothing else.
describe('Mediavine in the connect panel', () => {
  const LOGIN = { MEDIAVINE_USER: 'fake@example.test', MEDIAVINE_PASSWORD: SECRET };
  // A site the older switch never touched: its entry holds no Mediavine field.
  const SITE_ASSET = 'northwind.example';
  /** What the panel's Start writes — the site id, and nothing else — through
   * the store's own guarded write; `extra` adds the row's own Not using. */
  async function mapSite(asset = SITE_ASSET, extra: Record<string, string> = {}) {
    const file = 'config/integrations.json';
    forgetConfigCache(env.STORE);
    const lane = ((await getConfigDocument(env, file)).body as { assets: Record<string, Record<string, Record<string, unknown>>> }).assets[asset]!['ad-network']!;
    expect(lane.mediavineEnabled).toBeUndefined();
    const ops = Object.entries({ mediavineSiteId: SITE.id, ...extra }).filter(([field, value]) => lane[field] !== value).map(([field, value]) => ({
      kind: 'file-json-set' as const, file, pointer: `/assets/${asset}/ad-network/${field}`, value,
      ...(lane[field] === undefined ? { expectAbsent: true as const } : { expect: lane[field] as string }),
    }));
    const result = await applyConfigOps(env, { actor: 'operator', ops });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }

  it('keeps a refused login out of the store, and says refused, not unreachable', async () => {
    const refusing = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errors: [{ message: 'Unauthenticated', extensions: { code: 'UNAUTHENTICATED' } }] }));
    const answer = await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl: refusing, nowMs: NOW });
    expect(answer).toMatchObject({ ok: true, verdict: 'refused' });
    expect((await resolveCredential(env, 'mediavine')).source).toBe('none');
    const down = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    expect(await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl: down, nowMs: NOW })).toMatchObject({ ok: true, verdict: 'unreachable' });
    expect((await resolveCredential(env, 'mediavine')).source).toBe('none');
  });

  it('keeps an accepted login with its session and site list, so the panel lists the sites without signing in again', async () => {
    const fetchImpl = transport();
    const answer = await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl, nowMs: NOW });
    expect(answer).toMatchObject({ ok: true, verdict: 'accepted', facts: { sites: 1 } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // sign in, list sites
    const stored = await resolveCredential(env, 'mediavine');
    expect(stored.source).toBe('store');
    expect(stored.fields.MEDIAVINE_SESSION).toContain('synthetic-refresh');
    const listed = await discoverSites(env, 'mediavine', { fetchImpl, nowMs: NOW + 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(listed).toMatchObject({ ok: true, kind: 'account', sites: [
      { lane: 'ad-network', ref: SITE.id, label: SITE.domain, host: SITE.domain, mapping: { mediavineSiteId: SITE.id }, ready: true },
    ] });
  });

  it('lists the sites without stamping a verdict or an observation, and says a refused login is refused', async () => {
    await putMediavineCredential(env, { provider: 'mediavine', fields: LOGIN });
    const before = await credentialVerdict('mediavine');
    const listed = await discoverSites(env, 'mediavine', { fetchImpl: transport(), nowMs: NOW });
    expect(listed.ok).toBe(true);
    expect(await credentialVerdict('mediavine')).toEqual(before);
    expect(await storedHealthStates()).toEqual([]);
    await putMediavineCredential(env, { provider: 'mediavine', fields: LOGIN });
    const refusing = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
    expect(await discoverSites(env, 'mediavine', { fetchImpl: refusing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'refused' });
  });

  it("syncs a site once its id is saved — Start's one write — and stops at its Not using", async () => {
    await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl: transport(), nowMs: NOW });
    await mapSite();
    const fetchImpl = transport();
    const run = await runCollectNow(env, { provider: 'mediavine', assets: [SITE_ASSET] }, { fetchImpl, nowMs: NOW });
    expect(run).toMatchObject({ ok: true, job: 'mediavine', sites: [{ asset: SITE_ASSET, outcome: 'collected', code: null }] });
    expect(await count('mediavine_daily')).toBe(8);
    await mapSite(SITE_ASSET, { status: 'skipped', note: 'Not using: Replaced by another tool' });
    const declined = await runCollectNow(env, { provider: 'mediavine', assets: [SITE_ASSET] }, { fetchImpl, nowMs: NOW + 3_600_000 });
    expect(declined).toMatchObject({ ok: false, error: 'no-sites' });
    expect(mediavineSyncOn({ mediavineSiteId: SITE.id, status: 'needs-setup' })).toBe(true);
    expect(mediavineSyncOn({ mediavineSiteId: SITE.id, status: 'skipped' })).toBe(false);
    expect(mediavineSyncOn({ status: 'needs-setup' })).toBe(false);
  });

  it('collects through the day before yesterday when pressed before 6:10 a.m. Pacific', async () => {
    await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl: transport(), nowMs: NOW });
    await mapSite();
    const fetchImpl = transport();
    // 05:00 Pacific on 2026-09-09: Mediavine has reported through 09-07.
    const early = Date.parse('2026-09-09T12:00:00Z');
    const run = await runCollectNow(env, { provider: 'mediavine', assets: [SITE_ASSET] }, { fetchImpl, nowMs: early });
    expect(run).toMatchObject({ ok: true, sites: [{ outcome: 'collected' }] });
    const report = fetchImpl.mock.calls.find(([, init]) => String(init?.body).includes('earningsReport'));
    expect(JSON.parse(String(report![1]!.body)).variables).toMatchObject({ startDate: '09/01/2026', endDate: '09/07/2026' });
    // The schedule still waits for 6:10.
    const scheduled = transport();
    await runMediavine(env, { fetchImpl: scheduled, nowMs: early + 60_000 });
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('turns a press away while a sync holds the Mediavine lease', async () => {
    await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl: transport(), nowMs: NOW });
    await mapSite();
    await withMediavineLease(env, async () => {
      expect(await runCollectNow(env, { provider: 'mediavine', assets: [SITE_ASSET] }, { fetchImpl: transport(), nowMs: NOW }))
        .toMatchObject({ ok: false, error: 'in-flight' });
      expect(await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl: transport(), nowMs: NOW }))
        .toMatchObject({ ok: true, verdict: 'unreachable' });
    }, { nowMs: NOW });
  });

  it('forgets the login on Disconnect and leaves the site mapped, not Not using', async () => {
    await connectCredential(env, { provider: 'mediavine', fields: LOGIN }, { fetchImpl: transport(), nowMs: NOW });
    await mapSite();
    await disconnectMediavine(env);
    expect((await resolveCredential(env, 'mediavine')).source).toBe('none');
    forgetConfigCache(env.STORE);
    const lane = ((await getConfigDocument(env, 'config/integrations.json')).body as { assets: Record<string, Record<string, Record<string, unknown>>> }).assets[SITE_ASSET]!['ad-network']!;
    expect(lane).toMatchObject({ mediavineSiteId: SITE.id, status: 'needs-setup' });
    const fetchImpl = transport();
    expect((await runMediavine(env, { fetchImpl, nowMs: NOW })).outcome).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
