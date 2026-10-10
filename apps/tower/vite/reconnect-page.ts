// The reconnecting page: what a wall-mounted TV gets when the dispatch into
// workerd throws during a document load. Vite's own error page never retries;
// this one reloads itself. Only document requests get it: a poller handed a
// holding page instead of a rejection would read the outage as data and blank
// the panel it was holding.

import type { IncomingHttpHeaders } from "node:http";
import type { Connect, Plugin, ViteDevServer } from "vite";

/** Read by the meta refresh, the script timer and the `retry-after` header. */
export const RETRY_SECONDS = 5;

/** The Wall's background, inlined: the app's stylesheet is what failed to load,
 * and a white flash on a black wall is the most alarming part of the event. */
const PAGE_BACKGROUND = "#0a0a0a";

/** A hex copy of the app's `--warn` token; hex because the kiosk browser may
 * not know oklch. */
const WARN = "#f5a623";

/** Short enough that a junk URL cannot push the message off a TV. */
const MAX_PATH_LENGTH = 120;

/** Node hands a repeated header over as an array; `.toLowerCase()` on one would
 * throw inside an error middleware. */
function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * A navigation, or a poller waiting for JSON? When `sec-fetch-dest` is present
 * it is believed alone; the `accept` fallback is for a kiosk browser that
 * sends no Fetch Metadata, and a wildcard `accept` does not count.
 */
export function isDocumentRequest(headers: IncomingHttpHeaders): boolean {
  const dest = firstHeaderValue(headers["sec-fetch-dest"]).trim().toLowerCase();
  if (dest) return dest === "document";
  return firstHeaderValue(headers.accept).toLowerCase().includes("text/html");
}

/** The path, without the query: on a TV "which page died" is the whole question. */
export function failingPath(url: string | undefined): string {
  const path = (url ?? "").split("?")[0] ?? "";
  if (!path) return "/";
  return path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}…` : path;
}

/** The path is request-supplied text going onto a page served on the LAN. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes every interpolated value, so the failing path can never be
 * interpolated raw by an edit that forgets `escapeHtml`. */
function html(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  return strings.reduce(
    (out, part, index) => out + part + (index < values.length ? escapeHtml(String(values[index])) : ""),
    "",
  );
}

/** The two lines a person reads from across the room. */
export const RECONNECT_TITLE = "Tower reconnecting";
export const RECONNECT_RETRY = `Retrying every ${RETRY_SECONDS}s`;

/**
 * Self-contained: the pipeline that would serve a stylesheet, font or module is
 * what just failed. Both retry paths ship: the meta refresh fires with
 * scripting off or wedged, the `setTimeout` covers a browser that ignores
 * meta refresh.
 */
export function reconnectPageHtml(path: string): string {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="${PAGE_BACKGROUND}" />
    <meta http-equiv="refresh" content="${RETRY_SECONDS}" />
    <title>${RECONNECT_TITLE}</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        background: ${PAGE_BACKGROUND};
        color: #e8e8e8;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      main { padding: 2rem; }
      .dot {
        display: block;
        width: clamp(0.75rem, 1.4vw, 1.5rem);
        height: clamp(0.75rem, 1.4vw, 1.5rem);
        margin: 0 auto clamp(1rem, 2vw, 2rem);
        border-radius: 50%;
        background: ${WARN};
        animation: pulse 2s ease-in-out infinite;
      }
      h1 {
        margin: 0;
        font-size: clamp(1.5rem, 3.2vw, 3rem);
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      p { margin: clamp(0.5rem, 1vw, 1rem) 0 0; font-size: clamp(0.95rem, 1.4vw, 1.4rem); color: #9a9a9a; }
      .path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #6f6f6f; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
      @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    </style>
  </head>
  <body>
    <main>
      <span class="dot" aria-hidden="true"></span>
      <h1>${RECONNECT_TITLE}</h1>
      <p>${RECONNECT_RETRY}</p>
      <p class="path">${path}</p>
    </main>
    <script>
      setTimeout(function () { location.reload(); }, ${RETRY_SECONDS * 1000});
    </script>
  </body>
</html>
`;
}

/**
 * undici's message for a dead network is "fetch failed" and the diagnosis lives
 * on `err.cause`. Since this middleware answers the request, vite's error
 * middleware never logs, so this line is the only record.
 */
export function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) return `${err.message}: ${cause.message}`;
  if (typeof cause === "string" && cause) return `${err.message}: ${cause}`;
  return err.message;
}

/**
 * Four arity is the only signature Connect hands an error to. `headersSent`
 * first: a dispatch that failed mid-stream has committed a status line, and
 * writing a second one throws inside the error path.
 */
export function reconnectMiddleware(
  onAnswered: (err: unknown, path: string) => void = () => {},
): Connect.ErrorHandleFunction {
  return function noticeosReconnectPage(err, req, res, next) {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (!isDocumentRequest(req.headers)) {
      next(err);
      return;
    }
    // `originalUrl` is what arrived; `url` may have been rewritten upstream.
    const path = failingPath(req.originalUrl ?? req.url);
    onAnswered(err, path);
    res.statusCode = 503;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("retry-after", String(RETRY_SECONDS));
    res.end(reconnectPageHtml(path));
  };
}

/**
 * Connect walks forward only: `next(err)` reaches the first 4-arity handler
 * after the layer that failed, so this one must be appended after the
 * Cloudflare plugin's dispatch middleware and before vite's own error page.
 * Registering from the function returned by `configureServer` puts it before
 * vite's; `order: "post"` puts it after every other plugin's regardless of
 * where this plugin is listed. A silent regression here looks exactly like no
 * plugin at all.
 */
export function reconnectPage(): Plugin {
  return {
    name: "noticeos:reconnect-page",
    apply: "serve",
    configureServer: {
      order: "post",
      handler(viteDevServer: ViteDevServer) {
        return () => {
          viteDevServer.middlewares.use(
            reconnectMiddleware((err, path) => {
              viteDevServer.config.logger.error(
                `[reconnect-page] ${path} could not be dispatched (${errorSummary(err)}). ` +
                  `Served the reconnecting page; that client retries every ${RETRY_SECONDS}s.`,
                { error: err instanceof Error ? err : undefined },
              );
            }),
          );
        };
      },
    },
  };
}
