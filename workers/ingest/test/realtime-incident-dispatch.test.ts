import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REALTIME_ATTEMPT_EVIDENCE } from '@noticeos/contract';
import type { WorkspaceStore } from '@noticeos/postgres';
import { GA4_REALTIME_CRON } from '../src/crons.js';
import { runScheduledCron } from '../src/dispatch.js';
import { getConfigDocument } from '../src/config-store.js';
import { resolveGoogleCredential } from '../src/google-oauth.js';
import { googleTargets, googleCredentialResolver } from '../src/google-signals.js';
import { healthConnection, observeIntegration } from '../src/integration-health-context.js';
import type { LaneRegister } from '../src/lane-mapping.js';
import { reset, storedHealthEvents } from './helpers.js';

beforeEach(reset);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const incidents = async () => (await storedHealthEvents()).filter(event => event.evidence_source !== REALTIME_ATTEMPT_EVIDENCE);

it('keeps a quiet network retry and recovery out of failed job and incident channels', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('synthetic network failure')));
  const retry = await runScheduledCron(GA4_REALTIME_CRON, env);
  expect(retry.outcome).toBe('ran');
  expect(retry.steps?.find(step => step.id === 'traffic')).toMatchObject({ state: 'waiting', summary: 'Reconnecting' });
  expect(await incidents()).toEqual([]);
  const connection = await healthConnection(env, 'google');
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const credential = await resolveGoogleCredential(env);
  for (const target of googleTargets(credential, credential.source, googleCredentialResolver(env), register).filter(target => target.integration === 'ga4')) {
    await observeIntegration(env, connection, { capability: 'ga4-realtime', asset: target.asset, target: target.propertyRef, ok: true, observedAt: new Date(Date.now() + 1000).toISOString() });
  }
  expect(await incidents()).toEqual([]);
});

it('records a confirmed network incident once while keeping its workflow step failed', async () => {
  const connection = await healthConnection(env, 'google');
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const credential = await resolveGoogleCredential(env);
  const target = googleTargets(credential, credential.source, googleCredentialResolver(env), register).find(target => target.integration === 'ga4')!;
  const now = Date.now();
  for (const offset of [-120_000, -60_000]) await observeIntegration(env, connection, { capability: 'ga4-realtime', asset: target.asset, target: target.propertyRef, ok: false, code: 'network', observedAt: new Date(now + offset).toISOString() });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('synthetic network failure')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const failed = await runScheduledCron(GA4_REALTIME_CRON, env);
  expect(failed.outcome).toBe('ran');
  expect(failed.steps?.find(step => step.id === 'traffic')?.state).toBe('failed');
  expect((await incidents()).map(event => event.kind)).toEqual(['failed']);
});

it('records refused access immediately without failing the firing itself', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: 'access_denied' }, { status: 403 })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await runScheduledCron(GA4_REALTIME_CRON, env);
  expect(result.outcome).toBe('ran');
  expect(result.steps?.find(step => step.id === 'traffic')?.state).toBe('failed');
  expect((await incidents()).some(event => event.failure_kind === 'access')).toBe(true);
});

it('fails the firing when it cannot record the asset failures', async () => {
  const write: WorkspaceStore['write'] = work => env.STORE.write(tx => work({
    ...tx,
    query: (sql, values) => {
      if (sql.includes('FROM noticeos.capability_targets')) throw new Error('Monitoring unavailable');
      return tx.query(sql, values);
    },
  }));
  const store = { ...env.STORE, write };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: 'access_denied' }, { status: 403 })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await runScheduledCron(GA4_REALTIME_CRON, { ...env, STORE: store });
  expect(result.outcome).toBe('failed');
  expect(result.steps?.find(step => step.id === 'traffic')?.state).toBe('failed');
  expect(await incidents()).toEqual([]);
});
