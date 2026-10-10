// The proof that every test file starts clean in a reused runtime (the reset
// is test/clean-start.ts, the fence test/store-fence.ts).
//
// isolation-probe-a.test.ts and isolation-probe-b.test.ts are this one file
// under two names. Each first checks that it starts from the migrated store,
// an empty bucket and cache, and no module state held (src/isolate-state.ts);
// then it leaves all of those dirty behind it — a saved settings document, a
// stored object, a cached response, a warm read cache — and it leaves work
// running: writes to the database, the bucket and the cache, waiting to be let
// go. Whichever of the two runs second in a runtime checks what the first left
// and lets its work go, which must be refused and land nowhere, so either order
// proves it. Each also leaves a dead fake clock's setTimeout on the global, and
// the next file's timers still fire.
// In the full suite they share a runtime only by chance;
// `vitest run test/isolation-probe --maxWorkers=1` always puts them in one.
// Inside each file, one test leaves the same work for the next to let go.
// Postgres is in both halves: the settings document the probe saves lives
// there (src/config-store.ts), and so does a site it leaves; both are gone
// at the next file, and work left running cannot reach its test's store.
import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { getConfigDocument, seedConfigDocuments } from '../src/config-store.js';
import { heldIsolateState, registeredIsolateState } from '../src/isolate-state.js';
import { storeSites } from './sites';
import { TEST_SITES } from './invented-sites';
import { takeStrays } from './store-fence';

type Probe = 'a' | 'b';

const FILE = 'config/tower.json';
const cached = (probe: Probe) => `https://isolation-probe.example/${probe}`;

/** The module state a runtime keeps between calls, each registered beside its
 * declaration (src/isolate-state.ts); importing the Worker loads them all. */
const STATEFUL = ['config-store read cache', 'DataForSEO collector lane', 'GA4 token cache'];
const loadWorker = () => import('../src/index.js');

/** Work a test starts and does not wait for: three writes, held until `letGo`. */
interface LeftRunning {
  readonly tag: string;
  letGo(): void;
  /** Each write's error, or null where it landed. */
  readonly attempts: Promise<(unknown | null)[]>;
}

function leaveRunning(tag: string): LeftRunning {
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => (letGo = resolve));
  // A refusal is thrown as the call is made; this turns it into the answer.
  const outcome = (write: () => Promise<unknown>) => Promise.resolve().then(write).then(() => null, (error: unknown) => error);
  const attempts = held.then(() =>
    Promise.all([
      outcome(() => env.RAW_SIGNALS.put(`stray/${tag}`, tag)),
      outcome(() => caches.default.put(`https://isolation-probe.example/stray/${tag}`, new Response(tag))),
      outcome(() => postgresSite(`stray-${tag}`)),
    ]),
  );
  return { tag, letGo, attempts };
}

/** A site in this runtime's Postgres copy, through the test's own store (test/clean-start.ts). */
async function postgresSite(site: string): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES ($1, $2, 'Probe', 'live')", [tx.workspaceId, site]),
  );
}

/** The sites in this runtime's Postgres copy. */
async function postgresSites(): Promise<unknown[]> {
  return (await env.STORE.read((tx) => tx.query<{ asset_id: string }>('SELECT asset_id FROM noticeos.assets ORDER BY asset_id'))).map((row) => row.asset_id);
}

/** Whether a zero-delay timer fires, raced against workerd's own wait, which
 * no fake clock replaces. */
async function zeroDelayTimerFires(): Promise<boolean> {
  const wait = (globalThis as unknown as { scheduler: { wait(ms: number): Promise<void> } }).scheduler.wait(1_000);
  return Promise.race([new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0)), wait.then(() => false)]);
}

/** Let the work go, and prove every write was refused and none landed. */
async function expectRefused(work: LeftRunning, from: string): Promise<void> {
  work.letGo();
  const attempts = await work.attempts;
  for (const error of attempts) expect(String(error)).toContain(`store fence: "${from}" has ended`);
  expect(await env.RAW_SIGNALS.head(`stray/${work.tag}`)).toBeNull();
  expect(await caches.default.match(`https://isolation-probe.example/stray/${work.tag}`)).toBeUndefined();
  expect(await postgresSites()).not.toContain(`stray-${work.tag}`);
  // Refused, and on record — the file it happened in would fail — until this probe takes it.
  expect(takeStrays().map((stray) => stray.holder)).toEqual(attempts.map(() => from));
}

// globalThis outlives a file in a reused runtime, and nothing under test keeps
// anything there: the one place a probe can leave word for the next file.
interface Left {
  /** The module state it left held. */
  held: string[];
  running: LeftRunning;
  test: string;
}
const LEFT = Symbol.for('noticeos.ingest.isolation-probe');
function left(): Partial<Record<Probe, Left>> {
  const global = globalThis as unknown as Record<symbol, Partial<Record<Probe, Left>> | undefined>;
  return (global[LEFT] ??= {});
}

export function isolationProbe(self: Probe): void {
  const other: Probe = self === 'a' ? 'b' : 'a';
  const earlier = left()[other];
  const file = `test/isolation-probe-${self}.test.ts`;
  let inFile: LeftRunning | null = null;

  it(earlier ? `starts clean after probe ${other} ran in this runtime` : 'starts clean', async () => {
    // Before anything reads: every module state is registered and holds nothing.
    expect(heldIsolateState()).toEqual([]);
    await loadWorker();
    expect(registeredIsolateState()).toEqual(expect.arrayContaining(STATEFUL));
    expect(heldIsolateState()).toEqual([]);
    expect((await getConfigDocument(env, FILE)).source).toBe('file');
    expect((await env.RAW_SIGNALS.list()).objects).toEqual([]);
    expect(await caches.default.match(cached(other))).toBeUndefined();
    // Exactly the complete fixture list, with no site left by the previous file.
    const seeded = TEST_SITES.map((site) => site.id).sort();
    expect((await storeSites()).map((site) => site.id)).toEqual(seeded);
    expect(await postgresSites()).toEqual(seeded);
    // The runtime's own timers: a timer set now fires.
    expect(await zeroDelayTimerFires()).toBe(true);
    if (earlier) {
      // What the other file left held is held no longer.
      expect(earlier.held).toContain('config-store read cache');
      // The other file's work, still running into this one: refused, landed nowhere.
      delete left()[other];
      await expectRefused(earlier.running, earlier.test);
    }
  });

  it('ends with its writes still waiting to run', () => {
    inFile = leaveRunning(`${self}-in-file`);
  });

  it('keeps the test before it out of the store once it has ended', async () => {
    expect(inFile).not.toBeNull();
    await expectRefused(inFile!, `${file} > ends with its writes still waiting to run`);
  });

  const leaving = 'leaves a saved document, a stored object, a cached response, a stored site, a warm read cache, a dead clock and running work behind';
  it(leaving, async () => {
    const document = { countdown: { label: `Isolation probe ${self}`, target: '2026-10-01' } };
    expect((await seedConfigDocuments(env, { documents: { [FILE]: document }, actor: 'isolation-probe' })).ok).toBe(true);
    expect((await getConfigDocument(env, FILE)).body).toEqual(document);
    await env.RAW_SIGNALS.put(`isolation-probe/${self}`, self);
    await postgresSite(`isolation-probe-${self}`);
    expect(await postgresSites()).toContain(`isolation-probe-${self}`);
    await caches.default.put(cached(self), new Response(self, { headers: { 'cache-control': 'max-age=3600' } }));
    expect(await caches.default.match(cached(self))).toBeDefined();
    const held = heldIsolateState();
    expect(held).toContain('config-store read cache');
    left()[self] = { held, running: leaveRunning(`${self}-across-files`), test: `${file} > ${leaving}` };
    // Last: a spy on a faked setTimeout, restored after the clock. That order
    // leaves the dead clock's setTimeout on the global, and a zero-delay timer
    // set after it never fires.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    vi.useRealTimers();
    spy.mockRestore();
    expect(await zeroDelayTimerFires()).toBe(false);
  });
}
