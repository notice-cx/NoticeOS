import { describe, expect, it, vi } from 'vitest';
import { MediavineClient, normalizeReport, pacificDay, dates, type Session } from '../src/index.js';
const NOW = Date.parse('2026-09-09T13:10:00Z');
const SITE = { id: 'site-one', domain: 'example.test', title: 'Example' };
const period = { start: '2026-09-08', end: '2026-09-08' };
const report = (revenue: number | null = 12.34) => ({ internalSite: SITE, metricsSummary: { summary: { earnings: 12.36 } }, earningsReport: { earnings: [{ date: '2026/09/08', revenue }] } });
const goodSession: Session = { accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: NOW + 3_600_000 };
function client(responses: Response[], session: Session | null = goodSession) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const next = responses.shift(); if (!next) throw new Error('Unexpected provider call'); return next;
  });
  const saveSession = vi.fn<(value: Session | null) => Promise<void>>().mockResolvedValue();
  return { client: new MediavineClient({ credentials: { email: 'test@example.test', password: 'private-password' }, session, fetchImpl, saveSession, now: () => NOW }), fetchImpl, saveSession };
}
const json = (data: unknown) => Response.json({ data });
describe('provider session and request budget', () => {
  it.each([301, 302, 303, 307, 308])('refuses HTTP %s without following the redirect or changing the session', async status => {
    const run = client([new Response('', { status, headers: { location: 'https://another-host.example.test/' } })]);
    await expect(run.client.revenue(SITE.id, period)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(run.fetchImpl).toHaveBeenCalledTimes(1);
    expect(run.fetchImpl.mock.calls[0]![1]!.redirect).toBe('manual');
    expect(run.saveSession).not.toHaveBeenCalled();
  });
  it('does not refresh or sign in again after permission denial', async () => {
    for (const response of [new Response('', { status: 403 }), Response.json({ errors: [{ message: 'Unauthorized site', extensions: { code: 'FORBIDDEN' } }] })]) {
      const run = client([response]);
      await expect(run.client.revenue(SITE.id, period)).rejects.toMatchObject({ kind: 'permission' });
      expect(run.fetchImpl).toHaveBeenCalledTimes(1);
      expect(run.saveSession).not.toHaveBeenCalled();
    }
    const refresh = client([new Response('', { status: 403 })], { ...goodSession, expiresAt: 0 });
    await expect(refresh.client.revenue(SITE.id, period)).rejects.toMatchObject({ kind: 'permission' });
    expect(refresh.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('never attempts password login twice after a newly issued session is rejected', async () => {
    const run = client([json({ unidashSignIn: { accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600 } }), new Response('', { status: 401 }), new Response('', { status: 401 })], null);
    await expect(run.client.revenue(SITE.id, period)).rejects.toMatchObject({ kind: 'auth' });
    expect(run.fetchImpl).toHaveBeenCalledTimes(3);
    expect(run.fetchImpl.mock.calls.filter(([, init]) => String(init?.body).includes('unidashSignIn'))).toHaveLength(1);
  });
  it('recognizes the portal UNAUTHORIZED refresh code without relying on message wording', async () => {
    const run = client([Response.json({ errors: [{ message: 'Access denied', extensions: { code: 'UNAUTHORIZED' } }] }), json({ unidashSignIn: { accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600, twoFactorRequired: false } }), json(report())], { ...goodSession, expiresAt: 0 });
    await run.client.revenue(SITE.id, period);
    expect(run.saveSession).toHaveBeenCalledWith(null); expect(run.fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('preserves Retry-After on unavailable responses and bounds absurd dates', async () => {
    for (const header of ['7200', '99999999999999']) {
      const run = client([new Response('', { status: 503, headers: { 'retry-after': header } })]);
      await expect(run.client.revenue(SITE.id, period)).rejects.toMatchObject({ kind: 'unavailable', retryAt: header === '7200' ? NOW + 7_200_000 : NOW + 366 * 86_400_000 });
      expect(run.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it('reuses valid access and fetches explicit yesterday independently of UI presets', async () => {
    const run = client([json(report())]);
    const value = await run.client.revenue(SITE.id, period);
    expect(value.dailyMinor).toBe(1234); expect(value.differenceMinor).toBe(2);
    expect(run.fetchImpl).toHaveBeenCalledTimes(1); expect(run.saveSession).not.toHaveBeenCalled();
    const init = run.fetchImpl.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body)).variables).toEqual({ siteId: SITE.id, startDate: '09/08/2026', endDate: '09/08/2026' });
  });
  it('refreshes once and persists rotation before requesting revenue', async () => {
    const run = client([json({ unidashRefreshToken: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 } }), json(report())], { ...goodSession, expiresAt: NOW - 1 });
    await run.client.revenue(SITE.id, period);
    expect(run.fetchImpl).toHaveBeenCalledTimes(2);
    expect(run.saveSession).toHaveBeenCalledWith({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: NOW + 3_600_000 });
    expect(String(run.fetchImpl.mock.calls[0]![1]!.body)).not.toContain('private-password');
  });
  it('does not try password sign-in after a throttled refresh', async () => {
    const run = client([new Response('', { status: 429, headers: { 'retry-after': '7200' } })], { ...goodSession, expiresAt: 0 });
    await expect(run.client.revenue(SITE.id, period)).rejects.toMatchObject({ kind: 'rate-limit', retryAt: NOW + 7_200_000 });
    expect(run.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('recovers a revoked refresh token with one sign-in', async () => {
    const run = client([new Response('', { status: 401 }), json({ unidashSignIn: { accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600, twoFactorRequired: false } }), json(report())], { ...goodSession, expiresAt: 0 });
    await run.client.revenue(SITE.id, period);
    expect(run.fetchImpl).toHaveBeenCalledTimes(3); expect(run.saveSession).toHaveBeenCalledWith(null);
  });
  it('stops after a second access rejection and never echoes a provider error', async () => {
    const run = client([new Response('', { status: 401 }), json({ unidashRefreshToken: { accessToken: 'new', expiresIn: 3600 } }), Response.json({ errors: [{ message: 'unauthorized private-access private-password' }] })]);
    await expect(run.client.revenue(SITE.id, period)).rejects.toMatchObject({ kind: 'auth', message: 'Mediavine declined the saved connection. Reconnect your account.' });
    expect(run.fetchImpl).toHaveBeenCalledTimes(3);
  });
});
describe('report truth', () => {
  it('keeps unknown dates and null revenue distinct from zero', () => {
    expect(normalizeReport(report(null), period, NOW).complete).toBe(false);
    expect(normalizeReport(report(0), period, NOW).dailyMinor).toBe(0);
    expect(normalizeReport({ ...report(), earningsReport: { earnings: [] } }, period, NOW)).toMatchObject({ complete: false, missingDates: ['2026-09-08'] });
  });
  it('rejects duplicates, unexpected dates and fractional cents', () => {
    for (const earnings of [[{ date: '2026/09/08', revenue: 1 }, { date: '2026/09/08', revenue: 1 }], [{ date: '2026/09/09', revenue: 1 }], [{ date: '2026/09/08', revenue: 0.001 }]]) {
      expect(() => normalizeReport({ ...report(), earningsReport: { earnings } }, period, NOW)).toThrow();
    }
  });
  it('validates real dates and a bounded backfill', () => {
    expect(() => dates({ start: '2026-02-30', end: '2026-03-01' })).toThrow();
    expect(() => dates({ start: '2025-01-01', end: '2026-09-01' })).toThrow();
  });
});
describe('Pacific scheduling', () => {
  it.each([
    ['2026-09-09T13:09:59Z', '2026-09-08', false], ['2026-09-09T13:10:00Z', '2026-09-08', true],
    ['2026-01-01T14:10:00Z', '2025-12-31', true], ['2026-03-08T13:10:00Z', '2026-03-07', true],
    ['2026-11-01T14:09:59Z', '2026-10-31', false], ['2026-11-01T14:10:00Z', '2026-10-31', true],
  ])('handles %s', (now, yesterday, ready) => { expect(pacificDay(Date.parse(now))).toMatchObject({ yesterday, ready }); });
});
