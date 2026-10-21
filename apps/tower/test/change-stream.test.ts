import type { ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { useWork } from '@/hooks/useWork';
import { useWall } from '@/hooks/useWall';
import { useWallFeed } from '@/hooks/useWallFeed';
import { useIntegrationHealth } from '@/hooks/useIntegrationHealth';
import { wallMoneyResponse } from './critical-response-fixtures';
import { createChangeWatch, type TopicRead } from '../vite/change-lane';
import { createChangeStream, type ChangeStream } from '@/lib/change-stream';
import { CHANGE_STREAM_PATH } from '@shared/change-topics';

/** A response the watch writes frames to, closed by `emit("close")`. */
function client() {
  const res = Object.assign(new EventEmitter(), {
    frames: [] as string[], statusCode: 0, headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value; },
    write(frame: string) { res.frames.push(frame); return true; },
  });
  return res;
}
const events = (res: ReturnType<typeof client>) => res.frames.filter((frame) => frame.startsWith('event:'))
  .map((frame) => JSON.parse(frame.split('\ndata: ')[1]!) as unknown);

describe("the server's one check for every open page", () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sends unchanged topics their new answer times and names the topics whose content changed', async () => {
    vi.useFakeTimers();
    const content: Record<string, string> = { '/api/work': 'a', '/api/wall': 'a', '/api/wall/feed': 'a', '/api/integrations/health': 'a' };
    const reads: string[] = [];
    const read: TopicRead = async (path, validator) => {
      reads.push(path);
      const current = `"${content[path]}"`;
      const times: Record<string, string> = validator === current ? { generatedAt: `t${reads.length}` } : {};
      return { status: validator === current ? 304 : 200, validator: current, times };
    };
    const watch = createChangeWatch(read, 1_000);
    const [one, two] = [client(), client()];
    watch.open(one as unknown as ServerResponse);
    watch.open(two as unknown as ServerResponse);
    await watch.check();
    // The first reads set what later ones are compared with.
    expect(events(one)).toEqual([]);
    expect(reads).toHaveLength(4);

    content['/api/wall/feed'] = 'b';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toHaveLength(8);
    for (const res of [one, two]) {
      expect(events(res)).toContainEqual({ kind: 'change', topics: ['wall-feed'] });
      expect(events(res)).toContainEqual({ kind: 'fresh', topic: 'work', times: { generatedAt: 't5' } });
    }
    expect(one.headers['content-type']).toBe('text/event-stream; charset=utf-8');

    // The last page gone, the server stops reading.
    one.emit('close'); two.emit('close');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toHaveLength(8);
  });

  it('stops: ends every stream, reads no more, and resolves only once a read under way has finished', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let reads = 0;
    const read: TopicRead = async () => {
      reads++;
      if (reads === 1) await new Promise<void>((resolve) => { finish = resolve; });
      return { status: 200, validator: '"a"', times: {} };
    };
    const watch = createChangeWatch(read, 1_000);
    const page = Object.assign(client(), { ended: false, end() { page.ended = true; } });
    watch.open(page as unknown as ServerResponse);
    let stopped = false;
    const stopping = watch.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.ended).toBe(true);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    const after = reads;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toBe(after);
  });
});

/** A browser's stream: a fake EventSource the test drives, a channel between
 * tabs and a lock that grants at once. */
class FakeSource extends EventTarget {
  static last: FakeSource | null = null;
  closed = false;
  constructor(readonly url: string) { super(); FakeSource.last = this; }
  close() { this.closed = true; }
  emit(kind: string, data?: unknown) {
    this.dispatchEvent(data === undefined ? new Event(kind) : new MessageEvent(kind, { data: JSON.stringify(data) }));
  }
}
class FakeChannel {
  static last: FakeChannel | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { FakeChannel.last = this; }
  postMessage() {}
  close() {}
}
function fakePage() {
  return Object.assign(new EventTarget(), {
    EventSource: FakeSource,
    BroadcastChannel: FakeChannel,
    navigator: { locks: { request: (_name: string, _options: unknown, held: () => Promise<void>) => held() } },
    document: { readyState: 'complete' },
  }) as unknown as Window;
}

describe("a page's change stream", () => {
  it('refreshes cached queries when a follower first receives a connected status', () => {
    const queries = new QueryClient();
    queries.setQueryData(['work'], { projects: ['old'] });
    const invalidate = vi.spyOn(queries, 'invalidateQueries').mockResolvedValue();
    const stream = createChangeStream(queries, fakePage());
    try {
      FakeChannel.last!.onmessage?.(new MessageEvent('message', { data: { kind: 'status', connected: true } }));
      expect(stream.connected()).toBe(true);
      expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
        [['work'], ['tasks'], ['task'], ['wall'], ['wall-feed'], ['integration-health']]);
    } finally { stream.close(); queries.clear(); }
  });

  it('stops polling while it is open, reads a changed topic, keeps an unchanged one current, and reads everything once after a reconnect', async () => {
    const queries = new QueryClient();
    queries.setQueryData(['work'], { generatedAt: 'old', capturedAt: 'old', projects: [] });
    queries.setQueryData(['wall'], { generatedAt: 'old', assets: [] });
    const invalidate = vi.spyOn(queries, 'invalidateQueries').mockResolvedValue();
    const stream = createChangeStream(queries, fakePage());
    const source = FakeSource.last!;
    expect(source.url).toBe(CHANGE_STREAM_PATH);
    const heard = vi.fn();
    stream.subscribe(heard);

    source.emit('open');
    expect(stream.connected()).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(6);
    invalidate.mockClear();

    source.emit('change', { kind: 'change', topics: ['work'] });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([['work'], ['tasks'], ['task']]);

    source.emit('fresh', { kind: 'fresh', topic: 'work', times: { generatedAt: 'new', capturedAt: 'new' } });
    expect(queries.getQueryData(['work'])).toEqual({ generatedAt: 'new', capturedAt: 'new', projects: [] });

    // A dropped stream polls again; its return reads every pushed topic once.
    source.emit('error');
    expect(stream.connected()).toBe(false);
    invalidate.mockClear();
    source.emit('open');
    expect(stream.connected()).toBe(true);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      [['work'], ['tasks'], ['task'], ['wall'], ['wall-feed'], ['integration-health']]);

    stream.close();
    expect(source.closed).toBe(true);
    expect(stream.connected()).toBe(false);
    expect(heard).toHaveBeenCalled();
  });

  it('opens only once the page has loaded', () => {
    FakeSource.last = null;
    const page = Object.assign(new EventTarget(), fakePage(), { document: { readyState: 'loading' } }) as unknown as Window;
    const stream = createChangeStream(new QueryClient(), page);
    expect(FakeSource.last).toBeNull();
    page.dispatchEvent(new Event('load'));
    expect(FakeSource.last).not.toBeNull();
    stream.close();
  });

  it('is not opened where the browser has no event stream', () => {
    const stream = createChangeStream(new QueryClient(), { navigator: {} } as unknown as Window);
    expect(stream.connected()).toBe(false);
  });
});

describe('a polled read while the stream delivers it', () => {
  afterEach(() => { vi.useRealTimers(); });

  async function readsOver(pushed: boolean, ms: number) {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ generatedAt: 'now', projects: [] }));
    const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>({ mode: 'standalone', clientGeneration: 0 },
      { origin: 'https://desk.example', fetch, sendAnswer: async () => {} });
    const changes: ChangeStream = { connected: () => pushed, subscribe: () => () => {}, close() {} };
    const wrapper = ({ children }: { children: ReactNode }) => createElement(BrowserRuntimeProvider, {
      value: { runtime: { ...runtime, changes }, workspaceLabel: null },
      children: createElement(QueryClientProvider, { client: runtime.queries, children }),
    });
    const { unmount } = renderHook(() => useWork(), { wrapper });
    await vi.advanceTimersByTimeAsync(ms);
    unmount();
    runtime.retire();
    return fetch.mock.calls.length;
  }

  it('is read once and not polled while pushed, and polled every 30 s otherwise', async () => {
    expect(await readsOver(true, 95_000)).toBe(1);
    expect(await readsOver(false, 95_000)).toBe(4);
  });
});

describe('shared demo browser runtime', () => {
  afterEach(() => { vi.useRealTimers(); });
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  it('opens only for standalone and unprefixed demos; freezes and retires its stream', () => {
    const hosted = { mode: 'hosted', workspaceId, principalId: workspaceId, sessionId: workspaceId, clientGeneration: 0 };
    for (const [identity, apiBase, expected] of [
      [{ mode: 'standalone', clientGeneration: 0 }, '/api/', true],
      [{ mode: 'demo', workspaceId, clientGeneration: 0 }, '/api/', true],
      [hosted, '/api/', false],
      [{ mode: 'demo', workspaceId, clientGeneration: 0 }, `/visit/${'a'.repeat(32)}/api/`, false],
    ] as const) {
      FakeSource.last = null;
      const runtime = createBrowserRuntime(identity, { origin: 'https://demo.example.com', apiBase,
        fetch: async () => Response.json({}), page: fakePage(), sendAnswer: async () => {} });
      try {
        expect(FakeSource.last !== null).toBe(expected);
        if (expected) {
          const source = FakeSource.last!;
          expect(source.url).toBe('https://demo.example.com/api/changes');
          source.emit('open'); expect(runtime.changes.connected()).toBe(true);
          runtime.freeze(); expect(source.closed).toBe(true); expect(runtime.changes.connected()).toBe(false);
        }
      } finally { runtime.retire(); }
    }
  });

  it('refreshes changed queries, suspends all covered polling while connected, and resumes on disconnect', async () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    const runtime = createBrowserRuntime({ mode: 'demo', workspaceId, clientGeneration: 0 }, {
      origin: 'https://demo.example.com', page: fakePage(), sendAnswer: async () => {},
      fetch: async input => {
        const path = new URL(String(input)).pathname; reads.push(path);
        return Response.json(path === '/api/wall' ? wallMoneyResponse() : {
          generatedAt: '2026-10-01T12:00:00.000Z', projects: [], items: [], events: [], available: true,
        });
      },
    });
    const source = FakeSource.last!;
    const wrapper = ({ children }: { children: ReactNode }) => createElement(BrowserRuntimeProvider, {
      value: { runtime, workspaceLabel: null }, children: createElement(QueryClientProvider, { client: runtime.queries, children }),
    });
    const hook = renderHook(() => { useWork(); useWall(); useWallFeed(); useIntegrationHealth(); }, { wrapper });
    const counts = () => Object.fromEntries(['/api/work', '/api/wall', '/api/wall/feed', '/api/integrations/health'].map(path => [path, reads.filter(read => read === path).length]));
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(reads).toHaveLength(4);
      await act(async () => { source.emit('open'); await vi.advanceTimersByTimeAsync(1); });
      expect(Object.values(counts())).toEqual([2, 2, 2, 2]);
      await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
      expect(Object.values(counts())).toEqual([2, 2, 2, 2]);
      await act(async () => { source.emit('change', { topics: ['work'] }); await vi.advanceTimersByTimeAsync(1); });
      expect(Object.values(counts())).toEqual([3, 2, 2, 2]);
      await act(async () => { source.emit('error'); await vi.advanceTimersByTimeAsync(61_000); });
      expect(Object.values(counts())).toEqual([5, 3, 4, 4]);
    } finally { hook.unmount(); runtime.retire(); }
    expect(source.closed).toBe(true);
  });
});
