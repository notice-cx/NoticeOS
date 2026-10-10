import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { countOf, failureWords, healthFailure, recordIntegrationObservation, type RecordedObservation } from '../src/integration-health-store.js';
import { refuseHealthStates, reset, storedHealthEvents, storedHealthStates } from './helpers.js';
const T = Date.parse('2026-09-10T12:00:00Z');
let workspaceId: string;
function item(outcome: 'success' | 'failure', offset = 0, patch: Partial<RecordedObservation> = {}): RecordedObservation {
  const at = new Date(T + offset).toISOString();
  return { scope: { workspace: workspaceId, provider: 'google', connection: 'revision1', capability: 'ga4-realtime', asset: 'meals.example', target: 'property1', family: '' }, attemptId: `${offset}-${outcome}`, startedAt: at, finishedAt: at, outcome, failure: outcome === 'failure' ? 'rate-limit' : null, code: outcome === 'failure' ? 'daily-tokens' : null, nextAttemptAt: null, evidenceSource: 'live', evidenceId: `${offset}`, ...patch };
}
const rows = storedHealthStates;
async function events() { return (await storedHealthEvents()).map(({ kind, safe_code }) => ({ kind, safe_code })); }
beforeEach(async () => { await reset(); workspaceId = await env.STORE.workspaceId(); });
describe('durable integration history', () => {
  it('retains failures, last success and recovery while deduplicating repeated observations', async () => {
    await recordIntegrationObservation(env.STORE, item('success'));
    await recordIntegrationObservation(env.STORE, item('failure', 1000));
    await recordIntegrationObservation(env.STORE, item('failure', 1000));
    await recordIntegrationObservation(env.STORE, item('failure', 2000));
    expect(await events()).toEqual([{ kind: 'failed', safe_code: 'rate-limit-daily' }]);
    expect((await rows())[0]).toMatchObject({ outcome: 'failure', last_success_started_at: new Date(T).toISOString() });
    await recordIntegrationObservation(env.STORE, item('success', 3000));
    expect(await events()).toEqual([{ kind: 'failed', safe_code: 'rate-limit-daily' }, { kind: 'recovered', safe_code: null }]);
  });
  it('rejects delayed old success as recovery, but keeps its last-success evidence', async () => {
    await recordIntegrationObservation(env.STORE, item('failure', 2000));
    await recordIntegrationObservation(env.STORE, item('success', 1000, { finishedAt: new Date(T + 4000).toISOString() }));
    expect((await rows())[0]).toMatchObject({ outcome: 'failure', last_success_started_at: new Date(T + 1000).toISOString() });
    expect(await events()).toHaveLength(1);
  });
  it('does not let concurrent or tied observations manufacture a recovery', async () => {
    await Promise.all([recordIntegrationObservation(env.STORE, item('failure', 2000)), recordIntegrationObservation(env.STORE, item('success', 1000))]);
    await recordIntegrationObservation(env.STORE, item('success', 2000));
    expect((await rows())[0]?.outcome).toBe('failure');
    expect((await events()).some((event) => event.kind === 'recovered')).toBe(false);
  });
  // Observations of one target are taken one at a time, so each reads the
  // state the one before it left.
  it('takes concurrent observations of one target one at a time: two recoveries at once are one', async () => {
    await recordIntegrationObservation(env.STORE, item('failure'));
    // Two connections open before the race, so the two land together.
    await Promise.all([env.STORE.read((tx) => tx.query('SELECT 1')), env.STORE.read((tx) => tx.query('SELECT 1'))]);
    await Promise.all([recordIntegrationObservation(env.STORE, item('success', 1000)), recordIntegrationObservation(env.STORE, item('success', 2000))]);
    expect(await events()).toEqual([{ kind: 'failed', safe_code: 'rate-limit-daily' }, { kind: 'recovered', safe_code: null }]);
    expect((await rows())[0]).toMatchObject({ outcome: 'success', attempt_id: '2000-success' });
  });
  it('makes a target once when its first observations land together', async () => {
    await Promise.all([
      recordIntegrationObservation(env.STORE, item('failure', 2000)),
      recordIntegrationObservation(env.STORE, item('failure', 3000, { code: 'access' })),
    ]);
    expect(await rows()).toEqual([expect.objectContaining({ outcome: 'failure', safe_code: 'access' })]);
    expect([['failed'], ['changed', 'failed']]).toContainEqual((await events()).map((event) => event.kind).sort());
  });
  it.each(['connection', 'capability', 'asset', 'target', 'family'] as const)('isolates %s', async (key) => {
    const failing = item('failure');
    const other = { ...failing.scope, [key]: key === 'capability' ? 'ga4-hourly' : key === 'asset' ? 'nosh.example' : 'other' };
    await recordIntegrationObservation(env.STORE, failing);
    await recordIntegrationObservation(env.STORE, item('success', 1000, { scope: other }));
    expect(await rows()).toHaveLength(2);
    expect((await rows()).filter((row) => row.outcome === 'failure')).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });
  // The store's workspace is the call's, so a scope names that one alone:
  // another workspace's health is another store's (row security).
  it('refuses a scope naming another workspace', async () => {
    await expect(recordIntegrationObservation(env.STORE, item('failure', 0, { scope: { ...item('failure').scope, workspace: 'other' } }))).rejects.toThrow('Invalid monitoring identity');
    expect(await rows()).toEqual([]);
  });
  // An account's target names no site: it is stored with none and read as ''.
  it('keeps an account-wide target apart from every site', async () => {
    const account = { ...item('failure').scope, provider: 'dataforseo', capability: 'dataforseo-credit', asset: '', target: '' };
    await recordIntegrationObservation(env.STORE, item('failure', 0, { scope: account }));
    await recordIntegrationObservation(env.STORE, item('failure', 1000, { scope: account }));
    expect(await rows()).toEqual([expect.objectContaining({ provider: 'dataforseo', asset: '', target_id: '', outcome: 'failure' })]);
    expect(await events()).toHaveLength(1);
  });
  it('refuses a site that is not in the site list, and keeps nothing of it', async () => {
    await expect(recordIntegrationObservation(env.STORE, item('failure', 0, { scope: { ...item('failure').scope, asset: 'unknown.example' } }))).rejects.toThrow();
    expect(await rows()).toEqual([]);
    expect(await events()).toEqual([]);
  });
  it('names a provider report\'s evidence by its Postgres table', async () => {
    const family = JSON.stringify(['events', '2026-09-09', '', '']);
    await recordIntegrationObservation(env.STORE, item('failure', 0, { scope: { ...item('failure').scope, capability: 'ga4-archive', family }, evidenceSource: 'signal_dump_runs', evidenceId: 'dump-1' }));
    expect((await rows())[0]).toMatchObject({ evidence_source: 'archive_runs', evidence_id: 'dump-1' });
    expect((await storedHealthEvents())[0]).toMatchObject({ evidence_source: 'archive_runs', evidence_id: 'dump-1' });
  });
  it('stores only reviewed failure categories even when an adapter passes unsafe prose', async () => {
    await recordIntegrationObservation(env.STORE, item('failure', 0, { code: 'provider said https://private.test/secret-value' }));
    expect(JSON.stringify(await rows())).not.toContain('secret-value');
    expect((await rows())[0]?.safe_code).toBe('provider');
  });
  it('rolls back the event if the paired state mutation fails', async () => {
    const undo = await refuseHealthStates();
    try {
      await expect(recordIntegrationObservation(env.STORE, item('failure'))).rejects.toThrow();
      expect(await events()).toHaveLength(0);
    } finally { await undo(); }
  });
});

// A card's verdict is the site row's words, so the codes behind it must land
// in the right kind.
describe('a failed collection in the site row\'s words', () => {
  it('reads Clarity\'s refused token as access and its ten-a-day cap as the daily allowance', () => {
    expect(healthFailure('clarity_token_rejected')).toEqual({ failure: 'access', code: 'access' });
    expect(healthFailure('clarity_daily_cap_reached')).toEqual({ failure: 'rate-limit', code: 'rate-limit-daily' });
    expect(healthFailure('clarity_http_500')).toEqual({ failure: 'provider', code: 'provider' });
  });

  it('words each kind once, in the order met, and counts with the right noun', () => {
    expect(failureWords(['ga4_http_403', 'gsc_http_403', 'ga4_http_500'])).toEqual([
      'Access was refused',
      'The provider could not complete the request',
    ]);
    expect(countOf(4, 4, 'property', 'properties')).toBe('4 of 4 properties');
    expect(countOf(1, 1, 'property', 'properties')).toBe('1 of 1 property');
  });
});
