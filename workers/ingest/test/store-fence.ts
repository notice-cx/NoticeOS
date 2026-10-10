// The store fence: a test that has ended cannot touch the store.
//
// Vitest gives up on a test at its time limit but cannot stop it: the test's
// function keeps running, and with one runtime reused from file to file its
// work could reach the next file's store.
//
// So every test, and every file's own hooks, run inside an async context that
// names them (`within`, called from test/clean-start.ts), and everything
// `reset()` empties — the Postgres store, the bucket and the Cache API — refuses
// a call made from a test or file that has ended. The refusal is thrown into
// that work, and recorded (`takeStrays`) so the file fails naming the test
// that left it running. A call already on its way when its test ends is waited
// for (`settle`) before the next test starts and before a file empties the
// store. test/isolation-probe.ts proves it.
//
// The fence also records which Postgres bindings a file reached, so the next
// file's clean start makes again only the copies that can have changed: every
// file reaches `POSTGRES`, and only a few the second copy.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkspaceStore } from '@noticeos/postgres';

/** One test, or one file's own hooks, while it runs. */
interface Holder {
  readonly name: string;
  live: boolean;
}

/** A store call refused because the test or file that made it had ended. */
export interface Stray {
  readonly holder: string;
  readonly call: string;
}

interface FenceState {
  readonly context: AsyncLocalStorage<Holder>;
  readonly inFlight: Set<PromiseLike<unknown>>;
  strays: Stray[];
  /** The Postgres bindings reached since `takeReached` was last called. */
  reached: Set<string>;
}

// The setup file (clean-start.ts) is evaluated again for every file; the
// runtime, its bindings and any stray work are not. So the fence's state lives
// on globalThis.
const STATE = Symbol.for('noticeos.ingest.store-fence');
const FENCED = Symbol.for('noticeos.ingest.store-fence.fenced');

function state(): FenceState {
  const global = globalThis as unknown as { [STATE]?: FenceState };
  return (global[STATE] ??= { context: new AsyncLocalStorage<Holder>(), inFlight: new Set(), strays: [], reached: new Set() });
}

function guard(call: string): void {
  const holder = state().context.getStore();
  if (holder === undefined || holder.live) return;
  state().strays.push({ holder: holder.name, call });
  throw new Error(`store fence: "${holder.name}" has ended, so its ${call} was refused`);
}

function track(result: unknown): unknown {
  if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
    const pending = result as PromiseLike<unknown>;
    const { inFlight } = state();
    inFlight.add(pending);
    const done = () => {
      inFlight.delete(pending);
    };
    pending.then(done, done);
  }
  return result;
}

type After = (result: unknown) => unknown;

/** Guard each named method of one binding object, once per runtime. */
function fence(target: object, label: string, methods: Record<string, After>): object {
  const object = target as Record<string | symbol, unknown>;
  if (object[FENCED]) return target;
  for (const [method, after] of Object.entries(methods)) {
    const original = object[method];
    if (typeof original !== 'function') continue;
    Object.defineProperty(object, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        guard(`${label}.${method}()`);
        return after((original as (...args: unknown[]) => unknown).apply(object, args));
      },
    });
  }
  Object.defineProperty(object, FENCED, { value: true });
  return target;
}

/**
 * A Postgres binding (Hyperdrive): what an ended test would reach it by — its
 * connection string, read to open a store, and `connect()` — refused. Work
 * already inside a transaction when its test ended is not fenced here: the
 * next file's clean start copies the database again and ends every
 * connection to it (vitest.config.ts, TEST_POSTGRES), so its writes fail
 * rather than land.
 */
function fenceHyperdrive(binding: Record<string | symbol, unknown>, label: string): void {
  if (binding[FENCED]) return;
  const connectionString = binding.connectionString;
  fence(binding, label, {
    connect: (socket) => {
      noteReached(label);
      return socket;
    },
  });
  Object.defineProperty(binding, 'connectionString', {
    configurable: true,
    get: () => {
      guard(`${label}.connectionString`);
      noteReached(label);
      return connectionString;
    },
  });
}

/** Record that this file reached a Postgres binding, by its `env.` name.
 * test/helpers.ts records an owner statement run in a copy, which the fence
 * does not see. */
export function noteReached(label: string): void {
  state().reached.add(label);
}

/** The Postgres bindings reached since the last call, and forget them. */
export function takeReached(): Set<string> {
  const { reached } = state();
  state().reached = new Set();
  return reached;
}

/**
 * A test's own store (test/clean-start.ts), fenced like the bindings: a unit
 * of work from a test or file that has ended is refused and recorded, and one
 * already on its way is waited for before the next test starts.
 */
export function fenceWorkspaceStore(store: WorkspaceStore, label: string): WorkspaceStore {
  return {
    where: store.where,
    workspaceId: () => {
      guard(`${label}.workspaceId()`);
      return track(store.workspaceId()) as Promise<string>;
    },
    read: <T,>(work: Parameters<WorkspaceStore['read']>[0]) => {
      guard(`${label}.read()`);
      return track(store.read(work)) as Promise<T>;
    },
    write: <T,>(work: Parameters<WorkspaceStore['write']>[0]) => {
      guard(`${label}.write()`);
      return track(store.write(work)) as Promise<T>;
    },
    close: () => store.close(),
  };
}

const isBucket = (value: Record<string, unknown>) =>
  ['head', 'get', 'put', 'list', 'delete'].every((method) => typeof value[method] === 'function');
const isHyperdrive = (value: Record<string, unknown>) => typeof value.connect === 'function' && typeof value.connectionString === 'string';

/** Fence every bucket and Postgres binding in `env`, and the Cache API. */
export function fenceStore(env: object): void {
  for (const [name, value] of Object.entries(env)) {
    if (value === null || typeof value !== 'object') continue;
    const binding = value as Record<string | symbol, unknown>;
    // Fenced by an earlier file: reading it again would count as reaching it.
    if (binding[FENCED]) continue;
    if (isHyperdrive(binding)) fenceHyperdrive(binding, `env.${name}`);
    else if (isBucket(binding)) {
      fence(binding, `env.${name}`, { head: track, get: track, put: track, list: track, delete: track, createMultipartUpload: track });
    }
  }
  fence(caches.default, 'caches.default', { match: track, put: track, delete: track });
}

/** Wait until no store call is on its way. */
export async function settle(): Promise<void> {
  const { inFlight } = state();
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/**
 * Run `body` as `name`: its store calls are allowed until it returns and
 * refused after, however long its work goes on. Returns once its calls still
 * on their way have landed.
 */
export async function within(name: string, body: () => Promise<void>): Promise<void> {
  const holder: Holder = { name, live: true };
  try {
    await state().context.run(holder, body);
  } finally {
    holder.live = false;
    await settle();
  }
}

/** The calls refused since the last look; forgets them. */
export function takeStrays(): Stray[] {
  const current = state();
  const strays = current.strays;
  current.strays = [];
  return strays;
}
