import { env } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { openWorkspaceStore } from '@noticeos/postgres';
import { assertCredentialOwner, credentialSummary, deleteCredential, listCredentialSummaries, putCredential, resolveCredential } from '../src/credentials.js';
import { healthConnection, healthScope, observeIntegration } from '../src/integration-health-context.js';
import { recordIntegrationObservation } from '../src/integration-health-store.js';
import { googleCredentialResolver } from '../src/google-signals.js';
import { mediavineClient } from '../src/mediavine-connection.js';
import { asOwner, reset } from './helpers.js';

const hosted = (profile: 'hosted' | 'demo' = 'hosted'): IngestEnv => ({ ...env, NOTICEOS_WORKSPACE_PROFILE: profile });
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

it.each(['hosted', 'demo'] as const)('%s never consults legacy provider bindings for absent connections', async profile => {
  const selected = hosted(profile);
  let reads = 0;
  Object.defineProperty(selected, 'BING_WEBMASTER_API_KEY', { get() { reads++; throw new Error('Legacy secret read'); } });
  const result = await resolveCredential(selected, 'bing-webmaster');
  expect(result).toMatchObject({ workspaceId: await env.STORE.workspaceId(), connectionId: null, source: 'none', fields: {}, legacySlots: {} });
  expect((await credentialSummary(selected, 'bing-webmaster'))?.source).toBe('none');
  expect((await listCredentialSummaries(selected)).summaries.find(row => row.provider === 'bing-webmaster')?.source).toBe('none');
  expect(googleCredentialResolver(selected)('BING_WEBMASTER_API_KEY')).toBeUndefined();
  expect(reads).toBe(0);
});

it('keeps the explicit standalone legacy path and rejects missing hosted stores', async () => {
  const selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone', BING_WEBMASTER_API_KEY: 'synthetic-legacy-value' };
  expect((await resolveCredential(selected, 'bing-webmaster')).source).toBe('env');
  expect(googleCredentialResolver(selected)('BING_WEBMASTER_API_KEY')).toBe('synthetic-legacy-value');
  const missing = { ...hosted(), STORE: undefined } as unknown as IngestEnv;
  await expect(resolveCredential(missing, 'bing-webmaster')).rejects.toThrow('Credential workspace is unavailable');
});

it('keeps captured secrets, reconnections and health evidence inside the actual workspace', async () => {
  const workspaceId = crypto.randomUUID();
  await asOwner(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name)
    VALUES('${workspaceId}','credential-fixture','Credential fixture')`);
  const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
  const a = hosted(), b = { ...hosted(), STORE: store };
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider calls'));
  try {
    const fields = { BING_WEBMASTER_API_KEY: 'same-synthetic-value' };
    for (const selected of [a, b]) expect((await putCredential(selected, { provider: 'bing-webmaster', fields })).ok).toBe(true);
    const first = await resolveCredential(a, 'bing-webmaster'), second = await resolveCredential(b, 'bing-webmaster');
    expect(first.fields).toEqual(second.fields);
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.connectionId).not.toBe(second.connectionId);
    const connectionA = await healthConnection(a, 'bing-webmaster', first);
    const connectionB = await healthConnection(b, 'bing-webmaster', second);
    expect(connectionA.revision).not.toBe(connectionB.revision);
    await expect(assertCredentialOwner(b, first, 'bing-webmaster')).rejects.toThrow('ownership');
    await expect(healthConnection(b, 'bing-webmaster', first)).rejects.toThrow('ownership');
    await expect(mediavineClient(b, {}, first)).rejects.toThrow('ownership');
    const observedAt = new Date().toISOString();
    expect(await observeIntegration(a, connectionA, { capability: 'bing-discovery', observedAt, ok: false, code: 'network' })).toBe(true);
    expect(await observeIntegration(b, connectionA, { capability: 'bing-discovery', observedAt, ok: true })).toBe(false);
    const scope = await healthScope(connectionA, 'bing-discovery');
    await expect(recordIntegrationObservation(store, { scope, attemptId: 'foreign', startedAt: observedAt, finishedAt: observedAt,
      outcome: 'success', failure: null, code: null, nextAttemptAt: null, evidenceSource: 'live', evidenceId: 'foreign' })).rejects.toThrow('Invalid monitoring identity');
    expect(await store.read(tx => tx.query('SELECT event_id FROM noticeos.integration_health_events'))).toEqual([]);
    expect(await a.STORE.read(tx => tx.query('SELECT workspace_id FROM noticeos.integration_health_events'))).toEqual([{ workspace_id: first.workspaceId }]);
    await deleteCredential(a, 'bing-webmaster');
    expect((await resolveCredential(a, 'bing-webmaster')).fields).toEqual({});
    expect((await resolveCredential(b, 'bing-webmaster')).connectionId).toBe(second.connectionId);
    expect((await putCredential(a, { provider: 'bing-webmaster', fields })).ok).toBe(true);
    const reconnect = await healthConnection(a, 'bing-webmaster');
    expect(reconnect.connectionId).not.toBe(connectionA.connectionId);
    expect(reconnect.revision).not.toBe(connectionA.revision);
    expect(await observeIntegration(a, connectionA, { capability: 'bing-discovery', observedAt, ok: true })).toBe(false);
    const unreadable = { ...a, CREDENTIALS_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) };
    expect((await resolveCredential(unreadable, 'bing-webmaster')).fields).toEqual({});
    expect((await credentialSummary(unreadable, 'bing-webmaster'))?.source).toBe('store');
    await expect(healthConnection(unreadable, 'bing-webmaster')).rejects.toThrow('Monitoring connection could not be resolved');
    const summaries = await listCredentialSummaries(a);
    expect(JSON.stringify(summaries)).not.toContain(fields.BING_WEBMASTER_API_KEY);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    await store.close();
    await asOwner(['integration_health_events','integration_capability_state','capability_targets','connection_secrets','integration_connections','workspace_counters','workspaces']
      .map(table => `DELETE FROM noticeos.${table} WHERE workspace_id='${workspaceId}';`).join('\n'));
  }
});

it('hosted stored Google maps cannot name environment service-account bindings', async () => {
  const selected = hosted();
  const fields = { GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({ example: { service_account_binding: 'GOOGLE_FIXTURE_KEY', properties: {} } }) };
  // A legacy stored map can exist after a profile change; neither its provider
  // resolver nor its health fingerprint may consult the installation binding.
  let reads = 0;
  Object.defineProperty(selected, 'GOOGLE_FIXTURE_KEY', { get() { reads++; throw new Error('Legacy key read'); } });
  const resolved = { workspaceId: await env.STORE.workspaceId(), connectionId: crypto.randomUUID(), provider: 'google', source: 'store' as const,
    revision: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, fields, legacySlots: {} };
  expect(googleCredentialResolver(selected)('GOOGLE_FIXTURE_KEY')).toBeUndefined();
  await expect(healthConnection(selected, 'google', resolved)).rejects.toThrow('Legacy Google bindings');
  expect(reads).toBe(0);
});
