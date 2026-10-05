import { useEffect, useState, type ReactNode } from 'react';
import { render as renderBase, renderHook as renderHookBase, type RenderOptions } from '@testing-library/react';
import * as standaloneApi from '@/lib/api';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { resetAnswerQueue, standaloneAnswerQueue } from '@/lib/answer-queue';

export * from '@testing-library/react';

/** Legacy component cases explicitly exercise standalone compatibility. New
 * ownership/entry cases import testing-library directly and supply real facts.
 * This is neither a production fallback nor a mock of the runtime hook. */
function StandaloneTestOwner({ children }: { children: ReactNode }) {
  const [runtime] = useState(() => {
    resetAnswerQueue();
    const owned = createBrowserRuntime<(keepalive: boolean) => Promise<void>>({ mode: 'standalone', clientGeneration: 0 }, {
      origin: window.location.origin,
      fetch: globalThis.fetch,
      sendAnswer: (_api, send, keepalive) => send(keepalive),
    });
    return { ...owned, api: standaloneApi, answers: standaloneAnswerQueue() };
  });
  useEffect(() => () => runtime.retire(), [runtime]);
  return <BrowserRuntimeProvider value={{ runtime, workspaceLabel: null }}>{children}</BrowserRuntimeProvider>;
}
function wrapper(Inner?: React.JSXElementConstructor<{ children: ReactNode }>) {
  return function StandaloneWrapper({ children }: { children: ReactNode }) {
    return <StandaloneTestOwner>{Inner ? <Inner>{children}</Inner> : children}</StandaloneTestOwner>;
  };
}
export const render = ((ui: React.ReactNode, options?: RenderOptions) => renderBase(ui, { ...options, wrapper: wrapper(options?.wrapper) })) as typeof renderBase;
export const renderHook: typeof renderHookBase = (hook, options) => renderHookBase(hook, { ...options, wrapper: wrapper(options?.wrapper) });
