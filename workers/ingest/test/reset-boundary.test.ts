import { abortAllDurableObjects, env, evictAllDurableObjects, reset as resetBindings } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { takeStrays, within } from './store-fence';
import { clearRawSignals } from './clear-raw-signals';

it('awaited R2 writes are absent after supported reset and the Postgres-copy setup gap', async () => {
  const keys = Array.from({ length: 73 }, (_, index) => `reset-boundary/${index}`);
  await Promise.all(keys.map(key => env.RAW_SIGNALS.put(key, 'synthetic archive')));
  const before = await env.RAW_SIGNALS.list({ prefix: 'reset-boundary/' });
  expect(before.objects).toHaveLength(73);
  await resetBindings();
  const immediate = await env.RAW_SIGNALS.list({ prefix: 'reset-boundary/' });
  const copied = await env.TEST_POSTGRES.fetch('http://test-postgres/reset', { method: 'POST' });
  expect(copied.status).toBe(204);
  const afterCopy = await env.RAW_SIGNALS.list({ prefix: 'reset-boundary/' });
  console.log(JSON.stringify({ resetBoundary: { before: before.objects.length,
    immediate: immediate.objects.map(row => row.key), afterCopy: afterCopy.objects.map(row => row.key) } }));
  expect(immediate.objects).toEqual([]);
  expect(afterCopy.objects).toEqual([]);
});

it('a write released after its holder ends is refused before it can repopulate R2', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempt!: Promise<unknown>;
  await within('reset-boundary ended holder', async () => {
    attempt = held.then(() => env.RAW_SIGNALS.put('reset-boundary/late', 'synthetic archive'))
      .then(() => null, error => error);
  });
  await resetBindings();
  release();
  expect(String(await attempt)).toContain('store fence: "reset-boundary ended holder" has ended');
  expect(await env.RAW_SIGNALS.head('reset-boundary/late')).toBeNull();
  expect(takeStrays()).toEqual([{ holder: 'reset-boundary ended holder', call: 'env.RAW_SIGNALS.put()' }]);
});

it('supported reset removes R2 storage even when its bucket actor was evicted', async () => {
  await resetBindings();
  const keys = Array.from({ length: 73 }, (_, index) => `reset-evicted/${index}`);
  await Promise.all(keys.map(key => env.RAW_SIGNALS.put(key, 'synthetic archive')));
  expect((await env.RAW_SIGNALS.list({ prefix: 'reset-evicted/' })).objects).toHaveLength(73);
  await evictAllDurableObjects();
  await resetBindings();
  const after = await env.RAW_SIGNALS.list({ prefix: 'reset-evicted/' });
  console.log(JSON.stringify({ evictedResetBoundary: after.objects.map(row => row.key) }));
  expect(after.objects).toEqual([]);
});

it('explicit cleanup removes detached R2 storage after its bucket actor was aborted', async () => {
  await resetBindings();
  const keys = Array.from({ length: 73 }, (_, index) => `reset-aborted/${index}`);
  await Promise.all(keys.map(key => env.RAW_SIGNALS.put(key, 'synthetic archive')));
  expect((await env.RAW_SIGNALS.list({ prefix: 'reset-aborted/' })).objects).toHaveLength(73);
  await abortAllDurableObjects();
  await resetBindings();
  const resetOnly = await env.RAW_SIGNALS.list({ prefix: 'reset-aborted/' });
  console.log(JSON.stringify({ abortedResetOnlyCount: resetOnly.objects.length }));
  await clearRawSignals(env.RAW_SIGNALS);
  const after = await env.RAW_SIGNALS.list({ prefix: 'reset-aborted/' });
  console.log(JSON.stringify({ abortedResetBoundary: after.objects.map(row => row.key) }));
  expect(after.objects).toEqual([]);
});

it('clears every page of the actual bucket', async () => {
  const keys = Array.from({ length: 1005 }, (_, index) => `reset-pages/${String(index).padStart(4, '0')}`);
  for (let start = 0; start < keys.length; start += 100) {
    await Promise.all(keys.slice(start, start + 100).map(key => env.RAW_SIGNALS.put(key, 'synthetic archive')));
  }
  const first = await env.RAW_SIGNALS.list({ prefix: 'reset-pages/' });
  expect(first.objects).toHaveLength(1000);
  expect(first.truncated).toBe(true);
  await clearRawSignals(env.RAW_SIGNALS);
  expect((await env.RAW_SIGNALS.list()).objects).toEqual([]);
});

it('propagates storage failure instead of accepting an uncleared bucket', async () => {
  const failed = new Error('synthetic delete failure');
  const bucket = {
    list: () => env.RAW_SIGNALS.list(),
    delete: async () => { throw failed; },
  };
  await env.RAW_SIGNALS.put('reset-failure', 'synthetic archive');
  await expect(clearRawSignals(bucket)).rejects.toBe(failed);
  expect(await env.RAW_SIGNALS.head('reset-failure')).not.toBeNull();
  await clearRawSignals(env.RAW_SIGNALS);
});

it('refuses a silent deletion no-op when the bucket remains populated', async () => {
  await env.RAW_SIGNALS.put('reset-noop', 'synthetic archive');
  const bucket = {
    list: (options?: R2ListOptions) => env.RAW_SIGNALS.list(options),
    delete: async () => {},
  };
  await expect(clearRawSignals(bucket)).rejects.toThrow('the fixture raw-signal bucket was not emptied');
  expect(await env.RAW_SIGNALS.head('reset-noop')).not.toBeNull();
  await clearRawSignals(env.RAW_SIGNALS);
});
