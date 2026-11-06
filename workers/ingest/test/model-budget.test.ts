import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS, LOCAL_MODEL_OUTPUT_TOKENS } from '@noticeos/contract/local-model-settings';
import { credentialSummary, deleteCredential, listCredentialSummaries, putCredential, recordCredentialOutcome, resolveCredential, setModelOutputTokens } from '../src/credentials.js';
import { healthConnection } from '../src/integration-health-context.js';
import { reset } from './helpers.js';
import { providerCacheScope } from '../src/provider-read-cache.js';

let target: IngestEnv;
const fields = { LOCAL_MODEL_BASE_URL: 'https://models.example.com/custom/api', LOCAL_MODEL_ID: ' exact-model ', LOCAL_MODEL_API_TOKEN: 'synthetic-private-model-token' };
beforeEach(async () => { await reset(); target = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' }; });

it('updates only the generation budget without losing credentials, health or connection identity', async () => {
  expect(await putCredential(target, { provider: 'local-model', fields })).toMatchObject({ ok: true });
  await recordCredentialOutcome(target, 'local-model', { ok: true, error: null, at: '2026-11-06T12:00:00Z' });
  const before = await resolveCredential(target, 'local-model');
  const previousSummary = await credentialSummary(target, 'local-model');
  const health = await healthConnection(target, 'local-model');
  expect(previousSummary?.modelOutputTokens).toBe(DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS);
  expect(await setModelOutputTokens(target, { modelOutputTokens: 16_384 })).toEqual({ ok: true });
  const after = await resolveCredential(target, 'local-model');
  expect(after.fields).toEqual({ ...fields, [LOCAL_MODEL_OUTPUT_TOKENS]: '16384' });
  expect(after.connectionId).toBe(before.connectionId);
  expect(after.revision).toEqual(before.revision);
  expect(await healthConnection(target, 'local-model')).toEqual(health);
  const summary = await credentialSummary(target, 'local-model');
  expect(summary).toMatchObject({ modelOutputTokens: 16_384, lastOkAt: previousSummary?.lastOkAt, lastError: previousSummary?.lastError, updatedAt: previousSummary?.updatedAt });
  const listed = (await listCredentialSummaries(target)).summaries.find(summary => summary.provider === 'local-model');
  expect(listed?.modelOutputTokens).toBe(16_384);
  for (const value of Object.values(fields)) expect(JSON.stringify({ summary, listed })).not.toContain(value);
  expect(await providerCacheScope([before.fields])).not.toBe(await providerCacheScope([after.fields]));
});

it.each([0, 1023, 32_769, 4096.5, NaN, '8192'])('refuses invalid budget %j without changing saved fields', async value => {
  await putCredential(target, { provider: 'local-model', fields });
  expect(await setModelOutputTokens(target, { modelOutputTokens: value } as never)).toEqual({ ok: false, error: 'validation' });
  expect((await resolveCredential(target, 'local-model')).fields).toEqual(fields);
});

it.each(['hosted', 'demo'])('refuses %s updates before touching a store', async profile => {
  const unavailable = new Proxy({}, { get() { throw new Error('Store must not be touched'); } });
  expect(await setModelOutputTokens({ NOTICEOS_WORKSPACE_PROFILE: profile, STORE: unavailable } as never, { modelOutputTokens: 8192 }))
    .toEqual({ ok: false, error: 'not_supported' });
});

it('refuses a disconnected or legacy environment connection without creating a stored connection', async () => {
  expect(await setModelOutputTokens(target, { modelOutputTokens: 8192 })).toEqual({ ok: false, error: 'not_connected' });
  const legacy = { ...target, ...fields };
  expect((await credentialSummary(legacy, 'local-model'))?.modelOutputTokens).toBe(DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS);
  expect(await setModelOutputTokens(legacy, { modelOutputTokens: 16_384 })).toEqual({ ok: false, error: 'store_required' });
  expect((await resolveCredential(legacy, 'local-model', 'store-only')).source).toBe('none');
});

it('cannot revive a connection deleted while a budget update was being sealed', async () => {
  await putCredential(target, { provider: 'local-model', fields });
  const store = new Proxy(target.STORE, { get(object, key) {
    if (key === 'write') return async (work: Parameters<typeof object.write>[0]) => {
      await deleteCredential(target, 'local-model'); return object.write(work);
    };
    const value: unknown = Reflect.get(object, key);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  expect(await setModelOutputTokens({ ...target, STORE: store }, { modelOutputTokens: 16_384 })).toEqual({ ok: false, error: 'conflict' });
  expect((await resolveCredential(target, 'local-model')).source).toBe('none');
});


it('cannot overwrite a newer connection replacement with a stale budget update', async () => {
  await putCredential(target, { provider: 'local-model', fields });
  const replacement = { ...fields, LOCAL_MODEL_ID: 'replacement-model', LOCAL_MODEL_API_TOKEN: 'synthetic-replacement-token' };
  const store = new Proxy(target.STORE, { get(object, key) {
    if (key === 'write') return async (work: Parameters<typeof object.write>[0]) => {
      await putCredential(target, { provider: 'local-model', fields: replacement }); return object.write(work);
    };
    const value: unknown = Reflect.get(object, key);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  expect(await setModelOutputTokens({ ...target, STORE: store }, { modelOutputTokens: 16_384 })).toEqual({ ok: false, error: 'conflict' });
  expect((await resolveCredential(target, 'local-model')).fields).toEqual(replacement);
});
