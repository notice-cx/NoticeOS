import { toast } from 'sonner';
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import type { BrowserEntry, BrowserUiRuntime } from './browser-entry';
import type { WorkspaceChoice } from './browser-session';
import type { TowerApi } from './api';
import { createOwnerStorage, readStored, forgetStored, storageKey } from './browser-storage';
import type { ScheduledAnswer } from './answer-queue';
import { useMutation, type UseMutationOptions, type MutateOptions, type QueryClient, type DefaultError } from '@tanstack/react-query';
import { BrowserRetiredError } from './browser-runtime';
import { demoViewer } from '@shared/demo-viewer';

interface BrowserContextValue {
  readonly runtime: BrowserUiRuntime;
  readonly workspaceLabel: string | null;
  /** Captured bootstrap presentation; every administration request reauthorizes. */
  readonly workspaceRole?: WorkspaceChoice['role'];
  readonly refreshSession?: BrowserEntry['refresh'];
  readonly switchWorkspace?: BrowserEntry['switchWorkspace'];
  readonly logout?: BrowserEntry['logout'];
}
const BrowserContext = createContext<BrowserContextValue | null>(null);
export function BrowserRuntimeProvider({ value, children }: { value: BrowserContextValue; children: ReactNode }) {
  return <BrowserContext.Provider value={value}>{children}</BrowserContext.Provider>;
}
export function useBrowserContext(): BrowserContextValue {
  const value = useContext(BrowserContext);
  if (!value) throw new Error('A verified browser runtime is required.');
  return value;
}
export function useBrowserRuntime() { return useBrowserContext().runtime; }
/** Presentation facts only; the gallery can render without an entry context. */
export function useVerifiedDemoMode() { return useContext(BrowserContext)?.runtime.owner.mode === 'demo'; }
/** The existing immutable viewer and hosted synthetic workspace share only
 * presentation restrictions. Server admission remains the write authority. */
export function useDemoReadonly() { return useVerifiedDemoMode() || demoViewer() !== null; }
export function useTowerApi(): TowerApi { return useBrowserRuntime().api; }
/** Mutation callbacks include optimistic rollback and per-call UI handlers.
 * They are captured with the same owner as the issuing request. */
export function useOwnerMutation<Data = unknown, Failure = DefaultError, Variables = void, Optimistic = unknown>(
  options: UseMutationOptions<Data, Failure, Variables, Optimistic>, queryClient?: QueryClient,
) {
  const runtime = useBrowserRuntime();
  const live = () => { if (runtime.guard(() => true)() !== true) throw new BrowserRetiredError(); };
  const onMutate = options.onMutate;
  const result = useMutation<Data, Failure, Variables, Optimistic>({ ...options,
    onMutate: onMutate ? async (variables, context) => { live(); const value = await onMutate(variables, context); live(); return value; } : undefined,
    onSuccess: options.onSuccess ? runtime.guard(options.onSuccess) : undefined,
    onError: options.onError ? runtime.guard(options.onError) : undefined,
    onSettled: options.onSettled ? runtime.guard(options.onSettled) : undefined,
  }, queryClient);
  const callbacks = (value?: MutateOptions<Data, Failure, Variables, Optimistic>) => value ? {
    ...value,
    onSuccess: value.onSuccess ? runtime.guard(value.onSuccess) : undefined,
    onError: value.onError ? runtime.guard(value.onError) : undefined,
    onSettled: value.onSettled ? runtime.guard(value.onSettled) : undefined,
  } : undefined;
  return { ...result,
    mutate(variables: Variables, value?: MutateOptions<Data, Failure, Variables, Optimistic>) {
      live(); result.mutate(variables, callbacks(value));
    },
    async mutateAsync(variables: Variables, value?: MutateOptions<Data, Failure, Variables, Optimistic>) {
      live();
      try { const data = await result.mutateAsync(variables, callbacks(value)); live(); return data; }
      catch (error) { live(); throw error; }
    },
  };
}
export function useOwnerAnswers() {
  const queue = useBrowserRuntime().answers;
  useSyncExternalStore(queue.subscribe, queue.snapshot, queue.snapshot);
  return useMemo(() => ({
    hides: queue.hides,
    undo: queue.undo,
    schedule({ send, ...answer }: ScheduledAnswer) { queue.schedule({ ...answer, answer: send }); },
  }), [queue]);
}
export function useOwnerPreferences() {
  const runtime = useBrowserRuntime();
  return useMemo(() => {
    const assertActive = () => { if (runtime.guard(() => true)() !== true) throw new Error('This browser context is no longer active.'); };
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Browser storage is unavailable. */ }
    if (runtime.owner.mode !== 'standalone') {
      // Preferences belong to the verified person/session/workspace, while a
      // new generation relinquishes requests, drafts and undo callbacks.
      return createOwnerStorage({ ...runtime.owner, clientGeneration: 0 }, storage, assertActive, runtime.assertReadable);
    }
    return Object.freeze({
      read(name: string) { runtime.assertReadable(); return readStored(storage, name); },
      write(name: string, value: string) { assertActive(); try { storage?.setItem(storageKey(name), value); } catch { /* No preference stored. */ } },
      forget(name: string) { assertActive(); forgetStored(storage, name); },
    });
  }, [runtime]);
}

/** Every displayed completion and toast action keeps the lifetime that created
 * it. This also refuses an old Undo callback saved outside the mounted tree. */
export function useOwnerToast(): typeof toast {
  const runtime = useBrowserRuntime();
  const guardedArgs = (args: unknown[]) => {
    const options = args[1];
    if (options && typeof options === 'object' && 'action' in options) {
      const action = options.action;
      if (action && typeof action === 'object' && 'onClick' in action && typeof action.onClick === 'function') {
        const onClick = action.onClick;
        return [args[0], { ...options, action: { ...action, onClick: runtime.guard((...values: unknown[]) => Reflect.apply(onClick, action, values)) } }, ...args.slice(2)];
      }
    }
    return args;
  };
  return useMemo(() => new Proxy(toast, {
    apply(target, receiver, args: unknown[]) {
      if (runtime.guard(() => true)() !== true) return undefined;
      return Reflect.apply(target, receiver, guardedArgs(args));
    },
    get(target, name, receiver) {
      const method: unknown = Reflect.get(target, name, receiver);
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => {
        if (runtime.guard(() => true)() !== true) return undefined;
        return Reflect.apply(method, target, guardedArgs(args));
      };
    },
  }), [runtime]);
}
