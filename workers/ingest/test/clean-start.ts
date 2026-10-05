// BEFORE EVERY TEST FILE, IN THE RUNTIME THAT FILE RUNS IN (bead ro-ujb9.168).
//
// The suite reuses one Workers runtime per Vitest worker from file to file
// (vitest.config.ts, `isolate: false`): starting a runtime for every file took
// longer than the tests. This is what still gives each file a start of its own:
//  - every module is evaluated again, so no module-level state carries over —
//    config-store's read cache, calendar's feed round, the DataForSEO lane,
//    the GA4 token cache, and any cache added later. (`vi.mock` would carry
//    over; this suite has none.)
//  - no global stub or fake clock left by the file before is still in place;
//  - the raw-signal bucket and Cache API are emptied (`reset()`), and this
//    runtime's Postgres copy is made again from the run's template. Complete
//    synthetic sites are inserted directly in fixture order. Nothing rolls
//    back between tests inside a file.
//  - every test, and the file's own hooks, get a store of their own on that
//    copy as `env.STORE`, the way each call into the Worker gets one
//    (src/call-store.ts), closed when they end;
//  - work a test or file left running cannot touch the store after it ends
//    (test/store-fence.ts); a file where that happened fails, naming the test.
//  - after a test runs past its time limit, the rest of its file is skipped
//    rather than run beside it: its work is still going, and it can still
//    hold the file's module state (the DataForSEO lane refuses a second run).
// test/isolation-probe.ts proves it.
import { env, reset } from 'cloudflare:test';
import { openWorkspaceStore } from '@noticeos/postgres';
import { aroundAll, aroundEach, beforeEach, vi } from 'vitest';
import { fenceStore, fenceWorkspaceStore, settle, takeStrays, within } from './store-fence';
import { seedTestSites } from './invented-sites';
import { createTestTimeoutSignals } from './timeout-signals';
import { clearRawSignals } from './clear-raw-signals';

fenceStore(env);
let nativeTimeout = AbortSignal.timeout;
let timeoutSignals!: ReturnType<typeof createTestTimeoutSignals>;
// A failed file setup names the operation, preserving the original cause;
// there is no retry that could hide a shared-runtime failure (ro-jc8y).
let starting = 'settling work left by the previous test file';
try {
  // A call left on its way lands before the store is emptied, never after.
  await settle();
  starting = 'restoring modules, timers and globals';
  vi.resetModules();
  vi.useRealTimers();
  const timers = restorePristineTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  nativeTimeout = AbortSignal.timeout;
  timeoutSignals = createTestTimeoutSignals(timers, nativeTimeout);
  AbortSignal.timeout = timeoutSignals.timeout;
  starting = 'resetting R2 and the Cache API';
  await reset();
  // Pinned workerd resets only actor databases still in its map. An idle or
  // aborted bucket can retain durable rows outside that map (ro-irl4).
  // Explicit supported R2 operations also clear those rows, or fail setup.
  await clearRawSignals(env.RAW_SIGNALS);
  starting = 'resetting this runtime\'s Postgres test copy';
  const copied = await env.TEST_POSTGRES.fetch('http://test-postgres/reset', { method: 'POST' });
  if (!copied.ok) throw new Error(`the copy service answered ${copied.status}`);
  starting = 'seeding the Postgres test sites';
  await seedTestSites();
} catch (error) {
  AbortSignal.timeout = nativeTimeout;
  throw new Error(`ingest test file setup failed while ${starting}`, { cause: error });
}

/**
 * The runtime's own timers, whatever the file before did to them (bead
 * ro-ujb9.76.64). `vi.useRealTimers()` undoes a fake clock that is still
 * installed, but not one whose method was put back on the global after the
 * clock was gone: a spy on a faked `setTimeout` (`vi.spyOn(globalThis,
 * 'setTimeout')` under `vi.useFakeTimers()`), restored after
 * `vi.useRealTimers()`, leaves the dead clock's `setTimeout` in place, and
 * every timer the next file sets never fires. The runtime's first file keeps
 * the real ones on the global, where module re-evaluation cannot reach, and
 * every file after starts with them.
 */
function restorePristineTimers(): Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'> {
  const PRISTINE = Symbol.for('noticeos.ingest.pristine-timers');
  type Timers = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
  const runtime = globalThis as typeof globalThis & { [PRISTINE]?: Timers };
  runtime[PRISTINE] ??= {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  Object.assign(globalThis, runtime[PRISTINE]);
  return runtime[PRISTINE];
}

/** `run`, with a store of its own on this runtime's copy as `env.STORE`,
 * fenced and closed when `run` ends, and the store before it put back. */
async function withOwnStore(run: () => Promise<void>): Promise<void> {
  const before = env.STORE as typeof env.STORE | undefined;
  const store = openWorkspaceStore(env.POSTGRES.connectionString);
  env.STORE = fenceWorkspaceStore(store, 'env.STORE');
  try {
    await run();
  } finally {
    if (before) env.STORE = before;
    await store.close();
  }
}

// Vitest reads which fixtures a hook wants from its second parameter, and only
// from a destructuring pattern; these hooks want none.
aroundAll(async (runSuite, {}, file) => {
  try {
    await timeoutSignals.run(() => withOwnStore(() => within(`${file.name} (its own hooks)`, runSuite)));
    const strays = takeStrays();
    if (strays.length > 0) {
      throw new Error(
        `work left running after its test ended tried to use the store:\n${strays.map((stray) => `  ${stray.holder}: ${stray.call}`).join('\n')}`,
      );
    }
  } finally {
    AbortSignal.timeout = nativeTimeout;
  }
});

let ranOver: string | null = null;

aroundEach(async (runTest, { task }) => {
  const name = `${task.file.name} > ${task.name}`;
  await timeoutSignals.run(() => withOwnStore(() => within(name, runTest)));
  if (task.result?.errors?.some((error) => error.message?.startsWith('Test timed out'))) ranOver ??= name;
});

beforeEach(({ skip }) => {
  if (ranOver !== null) skip(`not run beside "${ranOver}", which ran past its time limit and may still be running`);
});
