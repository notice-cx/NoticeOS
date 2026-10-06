// STATE A WORKER ISOLATE KEEPS FROM ONE CALL TO THE NEXT (issue #5).
//
// A few modules hold something at module level on purpose: a short read
// cache, the DataForSEO collector lane, the GA4 token cache. Each registers
// here, beside its declaration, how to forget it and whether it holds anything
// now. Nothing in production reads this. The test suite reuses one Workers
// runtime from file to file and starts each file by forgetting all of it
// (test/clean-start.ts). That replaced re-evaluating every module per file,
// which was most of the suite's time. scripts/ingest-isolate-state.test.mjs
// refuses new module-level mutable state that is not registered here or
// declared a pure cache.

interface IsolateState {
  /** Back to what a new isolate starts with. */
  forget(): void;
  /** Whether it holds anything now. */
  held(): boolean;
}

const registered = new Map<string, IsolateState>();

/** Register one module's state under a name a failing check can show. */
export function isolateState(name: string, state: IsolateState): void {
  registered.set(name, state);
}

/** Forget every registered state, as a new isolate would start. */
export function forgetIsolateState(): void {
  for (const state of registered.values()) state.forget();
}

/** The names of the registered states that hold something now. */
export function heldIsolateState(): string[] {
  return [...registered].filter(([, state]) => state.held()).map(([name]) => name);
}

/** The names of every state registered so far in this isolate. */
export function registeredIsolateState(): string[] {
  return [...registered.keys()];
}
