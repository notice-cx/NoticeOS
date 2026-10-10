import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { reset, storedCount, storedHealthStates } from './helpers.js';
import { beginCollection, collectionMonitoring, persistCollectionAttempt } from '../src/collection-attempt.js';
import { recordSignalSuccess } from '../src/signal-store.js';
import type { HealthConnection } from '../src/integration-health-context.js';

beforeEach(reset);
const target = { asset: 'meadow.example', integration: 'ga4' as const, credentialRef: 'fixture-account', propertyRef: 'fixture-property' };
const window = { start: '2026-09-10', end: '2026-09-11' };
const result = { observations: [], providerRows: 0, dataState: 'final' as const, provisionalFrom: null };

it('does not publish monitoring evidence when source persistence fails', async () => {
  const monitoring = beginCollection(env.STORE, { workspaceId: await env.STORE.workspaceId(), connectionId: null, provider: 'google', revision: 'captured', configured: true, changedAt: null });
  await expect(persistCollectionAttempt({ target, monitoring, attempt: {
    id: 'not-persisted', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), source: 'signal_runs', ok: true,
  } }, async () => { throw new Error('source store rejected'); })).rejects.toThrow('source store rejected');
  expect(await storedHealthStates()).toEqual([]);
});

it('captures the connection by value and keeps it out of the source report', async () => {
  const connection: HealthConnection = { workspaceId: await env.STORE.workspaceId(), connectionId: null, provider: 'google', revision: 'captured', configured: true, changedAt: null };
  const monitoring = beginCollection(env.STORE, connection);
  connection.revision = 'later-edit';
  await recordSignalSuccess(env, { ...target }, window, new Date().toISOString(), result, monitoring);
  expect((await storedHealthStates()).map(({ connection_revision: revision, outcome }) => ({ revision, outcome })))
    .toEqual([{ revision: 'captured', outcome: 'success' }]);
  expect(collectionMonitoring(monitoring)).toEqual({});
  const [source] = await env.STORE.read((tx) => tx.query<{ row: string }>('SELECT to_json(r)::text AS row FROM noticeos.signal_runs r'));
  expect(JSON.stringify(source)).not.toContain('captured');
});

it('retains source data while declaring monitoring unavailable when no connection was captured', async () => {
  const monitoring = beginCollection(env.STORE, null);
  await recordSignalSuccess(env, target, window, new Date().toISOString(), result, monitoring);
  expect(collectionMonitoring(monitoring)).toEqual({ monitoringAvailable: false });
  expect(await storedCount('SELECT count(*)::int AS n FROM noticeos.signal_runs')).toBe(1);
  expect(await storedHealthStates()).toEqual([]);
});
