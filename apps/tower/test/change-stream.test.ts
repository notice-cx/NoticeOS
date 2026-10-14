import type { ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { useWork } from '@/hooks/useWork';
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
function fakePage() {
  return {
    EventSource: FakeSource,
    BroadcastChannel: class { onmessage: unknown = null; postMessage() {} close() {} },
    navigator: { locks: { request: (_name: string, _options: unknown, held: () => Promise<void>) => held() } },
    document: { readyState: 'complete' },
  } as unknown as Window;
}

describe("a page's change stream", () => {
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
    expect(invalidate).not.toHaveBeenCalled();

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
