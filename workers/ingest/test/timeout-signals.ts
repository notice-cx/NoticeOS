// Native AbortSignal.timeout holds its timer until it fires or its request
// ends. The pool reuses one request across files, and mocked provider calls
// return before their deadlines. Give those deadlines the test's lifetime.
import { AsyncLocalStorage } from 'node:async_hooks';

export type RealTimeouts = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;

interface Scope {
  live: boolean;
  pending: Set<() => void>;
}

/** Real deadlines while work runs, disposed when its test or hooks finish.
 * Calls outside a test keep the runtime's native implementation. Capture real
 * timer functions before a test installs a fake clock: native timeout signals
 * do not follow Vitest's clock either. */
export function createTestTimeoutSignals(
  timers: RealTimeouts,
  nativeTimeout: typeof AbortSignal.timeout = AbortSignal.timeout,
): {
  timeout: typeof AbortSignal.timeout;
  run<T>(work: () => Promise<T>): Promise<T>;
} {
  const context = new AsyncLocalStorage<Scope>();
  return {
    timeout(milliseconds) {
      const scope = context.getStore();
      if (!scope) return nativeTimeout.call(AbortSignal, milliseconds);
      if (!scope.live) throw new Error('timeout signal requested after its test ended');
      const controller = new AbortController();
      let cancel!: () => void;
      const timer = timers.setTimeout(() => {
        scope.pending.delete(cancel);
        controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      }, milliseconds);
      cancel = () => timers.clearTimeout(timer);
      scope.pending.add(cancel);
      return controller.signal;
    },
    async run(work) {
      const scope: Scope = { live: true, pending: new Set() };
      try {
        return await context.run(scope, work);
      } finally {
        scope.live = false;
        for (const cancel of scope.pending) cancel();
        scope.pending.clear();
      }
    },
  };
}
