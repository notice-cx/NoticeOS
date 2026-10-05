// What every LOCAL lane shares — the boundary, not the business.
//
// A "lane" here is a Vite middleware that answers an `/api/*` path from the dev
// server's NODE process instead of from the Worker, because the thing it needs
// is something workerd does not have: a filesystem (the config lane, D18) or a
// MySQL-speaking task hub on 127.0.0.1 (the task lane, D19). Both are
// `apply: "serve"`, so neither exists in a built Tower — the Worker answers
// those paths with the honest read-only version instead.
//
// This file holds the four things they must not implement twice, because two
// implementations of a boundary are two boundaries:
//
//   • the same-origin check — the ONLY thing standing between an operator's
//     browser and a page on another site steering it into a local write;
//   • the JSON content-type check and the capped body read;
//   • the repo root, walked rather than counted;
//   • the middleware shell: match a path, read the body, answer JSON, never
//     leak an exception to the socket.
//
// Everything above that line — which verbs, which files, which allowlist — is
// each lane's own, and stays in its own file.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import type { Connect } from "vite";
import { readProductEnv } from "../../../scripts/product-env.mjs";

/**
 * The checkout a lane reads and writes: the nearest ancestor holding the
 * workspace manifest.
 *
 * Walked rather than counted (`../../..`) on purpose. Vite BUNDLES the config
 * file and everything it imports before executing it, so what `import.meta.url`
 * resolves to is a fact about that bundler's file handling rather than about
 * this file's location — and a repo root off by one directory would mean a Save
 * writing into `apps/`, or a task lane looking for `config/beads.json` in a
 * directory that has none. Walking up finds the same root from either starting
 * point, and works in a git worktree, where the checkout is not where the
 * repository lives.
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
 * The HOME checkout when the local runner names one (bead ro-ujb9.113): the
 * managed service runs this dev server from a runtime copy of the code under
 * `.local/runtime/`, and passes `NOTICEOS_HOME` so a Save still commits in the
 * operator's checkout, the task lane still reads its host inventory and
 * resolves "../example.com" beside it, and the schedule lanes read its
 * `.local/`. Unset — every test and a bare `pnpm dev` — it is the checkout this
 * file is in, exactly as before.
 */
export function laneRepoRoot(env: Record<string, string | undefined>, from: string): string {
  // The legacy REINDEX_OS_HOME is still read (scripts/product-env.mts).
  const home = readProductEnv(env, "home");
  return home ? path.resolve(home) : findRepoRoot(from);
}

export const DEFAULT_REPO_ROOT = laneRepoRoot(
  process.env,
  path.dirname(fileURLToPath(import.meta.url)),
);

/** A request reduced to what a lane decides on. The middleware reads the body
 * off the socket; the handler is a pure-ish function a test can call directly,
 * the same shape the Worker's routes have. */
export interface LaneRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: string;
  /** The raw request target (path plus query). Lanes with more than one route
   * need it; the single-path config lane does not, so it stays optional. */
  url?: string;
}

export interface LaneReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Same-origin, by the same rule the Worker's write routes use: a signal the
 * browser DID send has to agree, and a signal it did not send is never read as a
 * failed check (a curl on this machine has no Origin, and neither does an
 * older client). What this refuses is the case that matters — a page on another
 * site steering the operator's browser at their own Tower.
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

/** Read a request body off the socket, capped: these lanes take a handful of
 * scalar edits and a paragraph of prose, and an unbounded read on a LAN
 * listener is a way to be hurt. */
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

/** Every lane answer is JSON and never cached — these are operator writes and
 * live reads, and an intermediary handing back a stale one would be a lie. */
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
  /** The machine code an unexpected throw answers with. Named per lane so the
   * browser can tell which one fell over. */
  failure: string;
}

/**
 * The middleware shell. Matches, reads the body (capped), calls the handler,
 * writes JSON — and catches everything, because an exception escaping here
 * hangs the socket rather than answering the operator.
 */
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
