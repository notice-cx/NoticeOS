// What every local lane shares: the boundary, not the business. A lane is a
// Vite middleware that answers an `/api/*` path from the dev server's Node
// process because it needs something workerd lacks (a filesystem, a process
// to spawn). Here: the same-origin check, the JSON check, the capped body
// read, the repo root and the middleware shell.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import type { Connect } from "vite";
import { readProductEnv } from "../../../scripts/product-env.mjs";

/**
 * The nearest ancestor holding the workspace manifest. Walked rather than
 * counted: Vite bundles the config file before executing it, so
 * `import.meta.url` says where the bundle is, not where this file is.
 */
export function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from, "../../.."); // the counted fallback
    dir = parent;
  }
}

/**
 * The home checkout when `NOTICEOS_HOME` names one: the app container runs
 * this dev server from its code folder, and `NOTICEOS_HOME` keeps a Save
 * committing in the operator's checkout and the lanes reading its `.local/`.
 */
export function laneRepoRoot(env: Record<string, string | undefined>, from: string): string {
  const home = readProductEnv(env, "home");
  return home ? path.resolve(home) : findRepoRoot(from);
}

export const DEFAULT_REPO_ROOT = laneRepoRoot(
  process.env,
  path.dirname(fileURLToPath(import.meta.url)),
);

/** A request reduced to what a lane decides on; a handler takes one directly. */
export interface LaneRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: string;
  /** The raw request target (path plus query). */
  url?: string;
}

export interface LaneReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Same-origin, by the Worker's write routes' rule: a signal the browser did
 * send has to agree, and a signal it did not send is never read as a failed
 * check (a curl on this machine has no Origin).
 */
export function crossOrigin(headers: Record<string, string | undefined>): boolean {
  const host = headers.host;
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return true;
  for (const name of ["origin", "referer"] as const) {
    const raw = headers[name];
    if (raw === undefined || raw === "") continue;
    let candidate: string;
    try {
      candidate = new URL(raw).host;
    } catch {
      return true; // unparseable is not a pass
    }
    return candidate !== host;
  }
  return false;
}

/** True when the request declares a JSON body. */
export function isJson(headers: Record<string, string | undefined>): boolean {
  return Boolean(headers["content-type"]?.toLowerCase().startsWith("application/json"));
}

/** An unbounded body read on a LAN listener is a way to be hurt. */
export const MAX_BODY_BYTES = 256 * 1024;

export async function readBody(req: Connect.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Every lane answer is JSON and never cached. */
export function sendReply(res: ServerResponse, reply: LaneReply): void {
  res.statusCode = reply.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(reply.body));
}

export interface LaneMiddlewareOptions {
  /** Does this lane own the path? Query string already stripped. */
  matches: (pathname: string) => boolean;
  handle: (request: LaneRequest) => Promise<LaneReply>;
  /** The machine code an unexpected throw answers with. */
  failure: string;
}

/** Catches everything: an exception escaping here hangs the socket. */
export function laneMiddleware(
  options: LaneMiddlewareOptions,
): Connect.NextHandleFunction {
  return function noticeosLane(req, res, next) {
    const raw = req.url ?? "";
    const pathname = raw.split("?")[0] ?? "";
    if (!options.matches(pathname)) {
      next();
      return;
    }
    const method = req.method ?? "GET";
    void (async () => {
      const body = method === "GET" || method === "HEAD" ? "" : await readBody(req);
      const reply =
        body === null
          ? { status: 413, body: { error: "payload_too_large" } }
          : await options.handle({
              method,
              headers: req.headers as Record<string, string | undefined>,
              body,
              url: raw,
            });
      sendReply(res, reply);
    })().catch(() => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: options.failure }));
    });
  };
}
