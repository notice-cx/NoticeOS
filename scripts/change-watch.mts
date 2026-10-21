/** One server-side watch of validated reads, shared by every listening page. */
import type { ServerResponse } from 'node:http';
import { CHANGE_CHECK_MS, CHANGE_TOPICS, type ChangeEvent, type ChangeTopic } from './change-topics.mjs';
import { ANSWER_TIMES_HEADER } from './read-validator.mjs';

export type TopicRead = (path: string, validator: string | null, signal: AbortSignal) => Promise<{
  status: number; validator: string | null; times: Record<string, string>;
}>;
const HEARTBEAT_MS = 25_000;

export function createChangeWatch(read: TopicRead, checkMs = CHANGE_CHECK_MS) {
  const clients = new Set<ServerResponse>();
  const validators = new Map<ChangeTopic, string>();
  let timers: ReturnType<typeof setInterval>[] = [];
  let controller: AbortController | null = null;
  let checking: { controller: AbortController; promise: Promise<void> } | null = null;

  function quiet() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
    controller?.abort(); controller = null;
    validators.clear();
  }
  function endClients() {
    for (const client of [...clients]) client.end();
    clients.clear(); quiet();
  }
  function write(frame: string) {
    for (const client of [...clients]) {
      // A slow reader reconnects instead of accumulating an unbounded buffer.
      try { if (!client.write(frame)) client.destroy(); } catch { client.destroy(); }
    }
  }
  const send = (event: ChangeEvent) => write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  async function checkOnce(run: AbortController) {
    const changed: ChangeTopic[] = [];
    for (const { topic, path } of CHANGE_TOPICS) {
      if (run.signal.aborted) return;
      const known = validators.get(topic) ?? null;
      let answer: Awaited<ReturnType<TopicRead>>;
      try { answer = await read(path, known, run.signal); }
      catch { if (!run.signal.aborted) endClients(); return; }
      if (run.signal.aborted) return;
      if (answer.status === 304 && known !== null) {
        if (Object.keys(answer.times).length) send({ kind: 'fresh', topic, times: answer.times });
      } else if (answer.status === 200 && answer.validator !== null) {
        validators.set(topic, answer.validator);
        if (known !== null && answer.validator !== known) changed.push(topic);
      } else {
        // Polling resumes when a topic is unavailable or admission is lost.
        endClients(); return;
      }
    }
    if (!run.signal.aborted && changed.length) send({ kind: 'change', topics: changed });
  }
  function check(): Promise<void> {
    const run = controller;
    if (!run || run.signal.aborted || !clients.size) return Promise.resolve();
    if (checking) {
      const held = checking;
      return held.promise.then(() => held.controller === run ? undefined : check());
    }
    const promise = checkOnce(run).finally(() => { checking = null; });
    checking = { controller: run, promise };
    return promise;
  }
  return {
    clients, check,
    async stop() { endClients(); await checking?.promise; },
    open(res: ServerResponse) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      clients.add(res);
      res.once('close', () => { clients.delete(res); if (!clients.size) quiet(); });
      res.write('retry: 5000\n\n');
      if (!controller) {
        controller = new AbortController();
        timers = [setInterval(() => void check(), checkMs), setInterval(() => write(':\n\n'), HEARTBEAT_MS)];
        for (const timer of timers) timer.unref?.();
        void check();
      }
    },
  };
}

/** Reads retain the ordinary read deadline and the watch's cancellation. */
export function topicReader(fetch: (request: Request) => Promise<Response>, origin: () => string | null): TopicRead {
  return async (path, validator, signal) => {
    const base = origin();
    if (base === null) throw new Error('The Tower is not listening yet.');
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), 10_000); timeout.unref?.();
    const lifetime = AbortSignal.any([signal, deadline.signal]);
    let interrupted: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      interrupted = () => reject(new Error('Topic read interrupted.'));
      lifetime.addEventListener('abort', interrupted, { once: true });
      if (lifetime.aborted) interrupted();
    });
    try {
      if (lifetime.aborted) return await aborted;
      const pending = fetch(new Request(`${base}${path}`, {
        headers: { accept: 'application/json', ...(validator === null ? {} : { 'if-none-match': validator }) }, signal: lifetime,
      }));
      // An adapter that finishes after cancellation still relinquishes its body.
      void pending.then(response => { if (lifetime.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await Promise.race([pending, aborted]);
      await Promise.race([response.body?.cancel(), aborted]);
      let times: Record<string, string> = {};
      try { times = JSON.parse(response.headers.get(ANSWER_TIMES_HEADER) ?? '{}') as Record<string, string>; } catch { /* No times. */ }
      return { status: response.status, validator: response.headers.get('etag'), times };
    } finally { clearTimeout(timeout); lifetime.removeEventListener('abort', interrupted); }
  };
}
