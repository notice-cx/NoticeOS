import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { CHANGE_STREAM_PATH, CHANGE_TOPICS, isChangeTopic, type ChangeEvent, type ChangeTopic } from '@shared/change-topics';
import { ANSWER_TIME_FIELDS } from '@shared/read-validator';

/** The cached reads each pushed topic refreshes when its content changes. A
 * changed task snapshot means the hub changed, so each project's live read is
 * read again too (an unchanged one answers 304). */
const REFRESHES: Record<ChangeTopic, readonly QueryKey[]> = {
  work: [['work'], ['tasks'], ['task']],
  wall: [['wall']],
  'wall-feed': [['wall-feed']],
  'integration-health': [['integration-health']],
};
const HOLDS: Record<ChangeTopic, QueryKey> = {
  work: ['work'], wall: ['wall'], 'wall-feed': ['wall-feed'], 'integration-health': ['integration-health'],
};

/** Between the tabs of one Tower: the tab holding the lock keeps the one
 * stream and passes what it hears to the others, so several open tabs use one
 * connection rather than one each from the browser's six per host. */
type TabMessage = ChangeEvent | { kind: 'status'; connected: boolean } | { kind: 'ask' };
const CHANNEL = 'noticeos:changes';

export interface ChangeStream {
  /** Whether a stream is delivering changes now; polling stops while it is. */
  connected(): boolean;
  subscribe(listener: () => void): () => void;
  close(): void;
}

export const NO_CHANGE_STREAM: ChangeStream = Object.freeze({
  connected: () => false, subscribe: () => () => {}, close() {},
});

function decode(kind: string, data: string): ChangeEvent | null {
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (kind === 'change' && Array.isArray(value.topics) && value.topics.every(isChangeTopic)) return { kind, topics: value.topics };
    if (kind === 'fresh' && isChangeTopic(value.topic) && value.times && typeof value.times === 'object') {
      return { kind, topic: value.topic, times: value.times as Record<string, string> };
    }
  } catch { /* A frame this page cannot read changes nothing. */ }
  return null;
}

/** Opens the change stream for a standalone or shared demo page. Browsers
 * without tab coordination, including plain-HTTP TVs, keep their own stream. */
export function createChangeStream(queries: QueryClient, window: Window, streamUrl = CHANGE_STREAM_PATH): ChangeStream {
  const page = window as Window & typeof globalThis;
  if (typeof page.EventSource !== 'function') return NO_CHANGE_STREAM;
  const shared = typeof page.BroadcastChannel === 'function' && typeof page.navigator.locks?.request === 'function';
  const listeners = new Set<() => void>();
  let connected = false;
  let leading = false;
  let closed = false;
  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    // Every tab includes changes before it joined, or while no leader held
    // the stream. Followers can first connect through a status reply.
    if (value) for (const { topic } of CHANGE_TOPICS) {
      for (const queryKey of REFRESHES[topic]) void queries.invalidateQueries({ queryKey });
    }
    for (const listener of listeners) listener();
  };
  const apply = (message: TabMessage) => {
    if (closed) return;
    if (message.kind === 'status') setConnected(message.connected);
    else if (message.kind === 'ask') { if (leading) channel?.postMessage({ kind: 'status', connected } satisfies TabMessage); }
    else if (message.kind === 'change') {
      for (const topic of message.topics) for (const queryKey of REFRESHES[topic]) void queries.invalidateQueries({ queryKey });
    } else {
      // Unchanged content: only the time it was read moves, without a read.
      queries.setQueryData(HOLDS[message.topic], (held: unknown) => {
        if (held === null || typeof held !== 'object' || Array.isArray(held)) return held;
        const next: Record<string, unknown> = { ...held };
        for (const field of ANSWER_TIME_FIELDS) if (field in next && typeof message.times[field] === 'string') next[field] = message.times[field];
        return next;
      });
    }
  };
  const channel = shared ? new page.BroadcastChannel(`${CHANNEL}:${streamUrl}`) : null;
  if (channel) channel.onmessage = (event: MessageEvent<TabMessage>) => apply(event.data);
  const relay = (message: TabMessage) => { apply(message); if (!closed) channel?.postMessage(message); };
  const stop = new AbortController();
  const holdSource = () => new Promise<void>((release) => {
    leading = true;
    const source = new page.EventSource(streamUrl);
    source.addEventListener('open', () => {
      relay({ kind: 'status', connected: true });
    });
    source.addEventListener('error', () => relay({ kind: 'status', connected: false }));
    for (const kind of ['change', 'fresh'] as const) {
      source.addEventListener(kind, (event: MessageEvent<string>) => {
        const message = decode(kind, event.data);
        if (message !== null) relay(message);
      });
    }
    stop.signal.addEventListener('abort', () => {
      source.close();
      if (connected) channel?.postMessage({ kind: 'status', connected: false } satisfies TabMessage);
      leading = false;
      release();
    }, { once: true });
  });
  const holdStream = () => (shared
    ? page.navigator.locks.request(`${CHANNEL}:${streamUrl}`, { signal: stop.signal }, holdSource)
    : holdSource()).catch(() => { /* Unavailable connections retain polling. */ });
  // After the page has loaded: a browser opens six connections to a host, and
  // a stream held from the start would take one from the page's own files.
  if (page.document.readyState === 'complete') void holdStream();
  else page.addEventListener('load', () => { if (!stop.signal.aborted) void holdStream(); }, { once: true, signal: stop.signal });
  channel?.postMessage({ kind: 'ask' } satisfies TabMessage);
  return Object.freeze({
    connected: () => connected,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {
      if (closed) return;
      stop.abort();
      closed = true;
      channel?.close();
      setConnected(false);
    },
  });
}
