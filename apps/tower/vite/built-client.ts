// The built app for an installation whose source does not change: its image
// runs `vite build`, and this server hands the browser that bundle (a few
// files, React's production build) instead of each source module as Vite
// transforms it. The Worker, the ingest and the local lanes answer exactly as
// before; only the app's own files change.

import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";

/** Written beside the built app: the release it was built from. */
export const BUILT_RELEASE_FILE = ".noticeos-release";

/** Paths the Worker answers first (`run_worker_first` in wrangler.jsonc), and
 * the dev server's own: never the app's files. */
const NOT_APP = /^\/(?:api\/|\.well-known\/oauth-(?:protected-resource|authorization-server)\/|cdn-cgi\/|@|__|node_modules\/|src\/)/u;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".map": "application/json; charset=utf-8",
};

/** The built app's directory when it was built from this release, else null:
 * a bundle from other source is never served. */
export function builtClientDir(distClient: string, release: string): string | null {
  try {
    return readFileSync(path.join(distClient, BUILT_RELEASE_FILE), "utf8").trim() === release ? distClient : null;
  } catch {
    return null;
  }
}

/** Serves the built app: a file it holds, or its page for any other address a
 * browser opens, as the Worker's single-page asset handling does. Hashed files
 * under `assets/` are kept a year; everything else is checked each time. */
export function builtClientMiddleware(dir: string, { page }: {
  /** Rewrites the app's page before it is sent (a test server pins its clock). */
  page?: (html: string) => string;
} = {}): Connect.NextHandleFunction {
  const root = path.resolve(dir);
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", "http://tower.invalid").pathname); } catch { next(); return; }
    if (NOT_APP.test(pathname)) { next(); return; }
    const candidate = path.resolve(root, `.${pathname}`);
    const inside = candidate === root || candidate.startsWith(`${root}${path.sep}`);
    let file = inside && candidate !== root && existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
    if (file === null) {
      // An address with no file is a page of the app, when a browser opens it.
      if (path.extname(pathname) !== "" || !String(req.headers.accept ?? "").includes("text/html")) { next(); return; }
      file = path.join(root, "index.html");
    }
    if (page !== undefined && file === path.join(root, "index.html")) {
      const html = page(readFileSync(file, "utf8"));
      res.setHeader("content-type", TYPES[".html"]!);
      res.setHeader("cache-control", "no-cache");
      res.end(req.method === "HEAD" ? undefined : html);
      return;
    }
    const stat = statSync(file);
    const validator = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", file.startsWith(path.join(root, "assets") + path.sep) ? "public, max-age=31536000, immutable" : "no-cache");
    res.setHeader("etag", validator);
    if (req.headers["if-none-match"] === validator) { res.statusCode = 304; res.end(); return; }
    res.setHeader("content-length", String(stat.size));
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file).on("error", () => { if (!res.headersSent) res.statusCode = 500; res.end(); }).pipe(res);
  };
}

/**
 * At build, writes the release beside the built app; at serve, when `serve`
 * holds and the built app is this release's, answers with it ahead of Vite's
 * own file handling. A development stack, or an image whose bundle is missing
 * or from other source, keeps Vite's source-module serving.
 */
export function builtClient({ distClient, release, serve }: { distClient: string; release: string; serve: boolean }): Plugin {
  return {
    name: "noticeos:built-client",
    enforce: "pre",
    writeBundle(options) {
      if (options.dir !== undefined && path.resolve(options.dir) === path.resolve(distClient)) {
        writeFileSync(path.join(distClient, BUILT_RELEASE_FILE), `${release}\n`);
      }
    },
    configureServer(server) {
      if (!serve) return;
      const dir = builtClientDir(distClient, release);
      if (dir === null) {
        server.config.logger.warn("No built app for this release: serving the app from source.");
        return;
      }
      server.middlewares.use(builtClientMiddleware(dir));
    },
  };
}
