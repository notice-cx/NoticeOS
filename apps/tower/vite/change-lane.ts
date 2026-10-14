// The change stream: one server-side check of the pushed reads, shared by
// every open page, sent as Server-Sent Events (shared/change-topics.ts).

import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { CHANGE_CHECK_MS, CHANGE_STREAM_PATH, CHANGE_TOPICS, type ChangeEvent, type ChangeTopic } from "../shared/change-topics";
import { ANSWER_TIMES_HEADER } from "../shared/read-validator";

/** One read of a pushed topic: 304 when `validator` still names its content. */
export type TopicRead = (path: string, validator: string | null) => Promise<{
  status: number; validator: string | null; times: Record<string, string>;
}>;

/** A heartbeat comment keeps a proxy from closing a quiet stream. */
const HEARTBEAT_MS = 25_000;

export function createChangeWatch(read: TopicRead, checkMs = CHANGE_CHECK_MS) {
  const clients = new Set<ServerResponse>();
  const validators = new Map<ChangeTopic, string>();
  let timers: ReturnType<typeof setInterval>[] = [];
  let checking: Promise<void> | null = null;

  const write = (frame: string) => { for (const client of clients) client.write(frame); };
  const send = (event: ChangeEvent) => write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);

  async function checkOnce() {
    const changed: ChangeTopic[] = [];
    for (const { topic, path } of CHANGE_TOPICS) {
      const known = validators.get(topic) ?? null;
      let answer: Awaited<ReturnType<TopicRead>>;
      try { answer = await read(path, known); } catch { continue; }
      if (answer.status === 304) {
        if (Object.keys(answer.times).length > 0) send({ kind: "fresh", topic, times: answer.times });
        continue;
      }
      if (answer.status !== 200 || answer.validator === null) continue;
      validators.set(topic, answer.validator);
      // The first read sets what later reads are compared with; a page that
      // opens the stream reads its topics once itself.
      if (known !== null && answer.validator !== known) changed.push(topic);
    }
    if (changed.length > 0) send({ kind: "change", topics: changed });
  }
  /** One check at a time; a tick that finds one running waits for it. */
  function check(): Promise<void> {
    checking ??= checkOnce().finally(() => { checking = null; });
    return checking;
  }

  return {
    clients,
    check,
    open(res: ServerResponse) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.write(`retry: 5000\n\n`);
      clients.add(res);
      if (timers.length === 0) {
        void check();
        timers = [setInterval(() => void check(), checkMs), setInterval(() => write(":\n\n"), HEARTBEAT_MS)];
        for (const timer of timers) timer.unref?.();
      }
      res.on("close", () => {
        clients.delete(res);
        if (clients.size > 0) return;
        for (const timer of timers) clearInterval(timer);
        timers = [];
        validators.clear();
      });
    },
  };
}

/** The server's own address, for reading its topics as a page would. */
function selfOrigin(server: ViteDevServer): string | null {
  const address = server.httpServer?.address() as AddressInfo | string | null | undefined;
  if (!address || typeof address === "string") return null;
  const host = ["::", "0.0.0.0", ""].includes(address.address) ? "127.0.0.1"
    : address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

/** A topic read through a fetch that answers as the Tower does. */
export function topicReader(fetch: (request: Request) => Promise<Response>, origin: () => string | null): TopicRead {
  return async (path, validator) => {
    const base = origin();
    if (base === null) throw new Error("The Tower is not listening yet.");
    const response = await fetch(new Request(`${base}${path}`, {
      headers: { accept: "application/json", ...(validator === null ? {} : { "if-none-match": validator }) },
      signal: AbortSignal.timeout(10_000),
    }));
    await response.body?.cancel();
    let times: Record<string, string> = {};
    try { times = JSON.parse(response.headers.get(ANSWER_TIMES_HEADER) ?? "{}") as Record<string, string>; } catch { /* No times. */ }
    return { status: response.status, validator: response.headers.get("etag"), times };
  };
}

/** The middleware that answers `CHANGE_STREAM_PATH` from one watch. */
export function changeStreamMiddleware(watch: ReturnType<typeof createChangeWatch>): Connect.NextHandleFunction {
  return (req, res, next) => {
    if ((req.url ?? "").split("?")[0] !== CHANGE_STREAM_PATH) { next(); return; }
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    watch.open(res);
  };
}

/** `enforce: "pre"`: the stream is answered here, never by the Worker. Its
 * reads go to this server's own address, through the Worker as a page's do. */
export function changeLane(): Plugin {
  return {
    name: "noticeos:change-lane",
    enforce: "pre",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(changeStreamMiddleware(createChangeWatch(topicReader((request) => fetch(request), () => selfOrigin(server)))));
    },
  };
}
