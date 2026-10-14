// Compression for everything the standalone Tower serves: its API replies and
// the app's own files. A hosted Worker is compressed by Cloudflare's edge.

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { constants, createBrotliCompress, createGzip, type BrotliCompress, type Gzip } from "node:zlib";
import type { Connect, Plugin } from "vite";

/** Text worth compressing. The change stream is text too, but each event must
 * leave as it is written, so it is never compressed. */
const COMPRESSIBLE = /^(?:application\/(?:json|javascript|manifest\+json|xml)|text\/(?!event-stream)[a-z-]+|image\/svg\+xml)\b/u;
/** Below this many bytes a reply is sent as it is. */
const SMALLEST = 1024;

type Encoding = "br" | "gzip";

/** The encoding to send, from the request's `Accept-Encoding`: Brotli first. */
export function chosenEncoding(acceptEncoding: string | string[] | undefined): Encoding | null {
  const accepted = new Map<string, number>();
  for (const part of String(acceptEncoding ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    accepted.set(name, q ? Number(q.slice(2)) : 1);
  }
  for (const encoding of ["br", "gzip"] as const) if ((accepted.get(encoding) ?? 0) > 0) return encoding;
  return null;
}

function appendVary(res: ServerResponse) {
  const vary = String(res.getHeader("vary") ?? "");
  if (!/\baccept-encoding\b/iu.test(vary)) res.setHeader("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
}

/** Wraps one response so its body is compressed when its status, type and
 * length allow, decided when the first byte or the headers are sent. */
export function compressReply(req: IncomingMessage, res: ServerResponse): void {
  const encoding = chosenEncoding(req.headers["accept-encoding"]);
  if (encoding === null || req.method === "HEAD") return;
  const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  const writeHead = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => ServerResponse;
  let stream: BrotliCompress | Gzip | null | undefined;

  const decide = (): BrotliCompress | Gzip | null => {
    if (stream !== undefined) return stream;
    const type = String(res.getHeader("content-type") ?? "");
    const length = Number(res.getHeader("content-length") ?? Number.NaN);
    const fits = res.statusCode >= 200 && res.statusCode !== 204 && res.statusCode !== 304
      && !res.getHeader("content-encoding") && COMPRESSIBLE.test(type) && !(length < SMALLEST);
    if (!fits) return (stream = null);
    res.removeHeader("content-length");
    res.setHeader("content-encoding", encoding);
    appendVary(res);
    stream = encoding === "br"
      ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
      : createGzip({ level: 6 });
    stream.on("data", (chunk: Buffer) => write(chunk));
    stream.on("end", () => end());
    return stream;
  };

  res.writeHead = ((status: number, ...rest: unknown[]) => {
    if (typeof rest[0] === "string") res.statusMessage = rest.shift() as string;
    const headers = rest[0] as OutgoingHttpHeaders | readonly unknown[] | undefined;
    res.statusCode = status;
    if (Array.isArray(headers)) {
      for (let index = 0; index + 1 < headers.length; index += 2) res.setHeader(String(headers[index]), headers[index + 1] as string);
    } else if (headers) {
      for (const [name, value] of Object.entries(headers)) if (value !== undefined && value !== null) res.setHeader(name, value as string | number | string[]);
    }
    decide();
    return writeHead(res.statusCode);
  }) as typeof res.writeHead;

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    const target = decide();
    return target === null ? write(chunk, ...rest) : target.write(chunk as Buffer, ...(rest as []));
  }) as typeof res.write;

  res.end = ((...args: unknown[]) => {
    const target = decide();
    if (target === null) return end(...args);
    const chunk = typeof args[0] === "function" ? undefined : args[0];
    const done = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    if (done) res.once("finish", done);
    if (chunk === undefined || chunk === null) target.end();
    else if (typeof args[1] === "string") target.end(chunk as Buffer, args[1] as BufferEncoding);
    else target.end(chunk as Buffer);
    return res;
  }) as typeof res.end;
}

/** Ahead of every other middleware, so the Worker's replies, the local lanes
 * and Vite's own file answers all pass through it. */
export function compressReplies(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => { compressReply(req, res); next(); };
  return {
    name: "noticeos:compress-replies",
    enforce: "pre",
    configureServer(server) { server.middlewares.use(middleware); },
  };
}
