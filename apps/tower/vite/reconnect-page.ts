// The reconnecting page — what a wall-mounted TV gets when the request pipeline
// itself fails during a document load.
//
// WHY. The Tower runs its dev server AS production (local-first), so every
// request is dispatched into the one workerd child (bead ro-mad) through
// miniflare's `dispatchFetch`. During an internet outage that dispatch throws
// undici's "fetch failed", and if the throw lands on a full page load rather
// than on an XHR, vite answers with its own error page: the failure rendered,
// and nothing else. Nothing on that page ever retries.
//
// That is the whole hole. The Wall app is built for exactly this weather — the
// panels poll every 60s through TanStack Query and hold the last good payload
// on screen — but none of that code is running when the document never arrived.
// So the TV showing the wall sat on an undici error long after connectivity came
// back, and the only cure was a human walking over to the kiosk and reloading
// it. The app recovers from an outage; the document load was the one request
// with nothing watching it.
//
// This plugin closes that and nothing else. A failed DOCUMENT request gets a
// page whose only job is to reload itself; every other failure keeps failing
// exactly as loudly as it does today. That asymmetry is deliberate: the pollers
// behind the API requests already handle a 500 by keeping what they have, and a
// poller handed a friendly holding page instead of a rejection would read the
// outage as DATA — parse it, fail, and blank the panel it was successfully
// holding. The quiet page is only ever for the eyes on the far side of the room.

import type { IncomingHttpHeaders } from "node:http";
import type { Connect, Plugin, ViteDevServer } from "vite";

/** How long the page waits before trying again. The meta refresh, the script
 * timer and the `retry-after` header all read it, so they cannot drift apart. */
export const RETRY_SECONDS = 5;

/** The Wall's own background, near enough. The page cannot reference the app's
 * stylesheet — the app is precisely what failed to load — so the one colour that
 * matters is inlined: on a TV showing a black wall, a white flash is the most
 * alarming part of the whole event. */
const PAGE_BACKGROUND = "#0a0a0a";

/** A hex copy of the app's `--warn` token (oklch(0.79 0.16 75)). Hex, not oklch:
 * the kiosk browser is whatever the DietPi image shipped with, and this page's
 * entire value is that it renders on a browser having a bad day. */
const WARN = "#f5a623";

/** Long enough for any real route, short enough that a junk URL cannot push the
 * message off a TV. */
const MAX_PATH_LENGTH = 120;

/** Node hands a repeated header over as an array, and `.toLowerCase()` on an
 * array throws — inside an ERROR middleware that would replace a recoverable
 * blank screen with a second, stranger crash. The first value is the answer for
 * the same reason Node keeps only the first of most duplicated headers. */
function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Is a human waiting for a page, or is a poller waiting for JSON?
 *
 * Fetch Metadata answers this exactly, which no amount of `accept` sniffing
 * does: `sec-fetch-dest: document` is a navigation, `empty` is `fetch()`, and
 * every browser has sent it on every request for years. So when the header is
 * present it is believed ALONE — never softened by the `accept` fallback below.
 * That ordering is the important half: the Wall's pollers send
 * `sec-fetch-dest: empty`, and if one of them ever matched here it would be
 * handed HTML where it expected a payload, which is worse than the error it
 * asked for.
 *
 * The `accept` fallback exists for the kiosk. The wall runs whatever browser the
 * DietPi image carries, and a request with no Fetch Metadata at all is far more
 * likely to be that TV asking for a page than a poller asking for JSON — but
 * only if it says so: a wildcard `accept`, which is what a bare `fetch()` sends,
 * does not count.
 */
export function isDocumentRequest(headers: IncomingHttpHeaders): boolean {
  const dest = firstHeaderValue(headers["sec-fetch-dest"]).trim().toLowerCase();
  if (dest) return dest === "document";
  return firstHeaderValue(headers.accept).toLowerCase().includes("text/html");
}

/** The path the operator needs to read off the screen, without the query: on a
 * TV "which page died" is the whole question and the query string is noise. */
export function failingPath(url: string | undefined): string {
  const path = (url ?? "").split("?")[0] ?? "";
  if (!path) return "/";
  return path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}…` : path;
}

/**
 * The path is attacker-supplied text going onto a page, so it is escaped.
 *
 * Nothing on the trusted LAN is going to request `/<script>`, but the Tower's
 * listener IS on the LAN (0.0.0.0:5173) and this page is served for any failing
 * navigation — so without this, a broken dispatch turns the Tower into a
 * reflected-XSS surface for the duration of the outage. A hole that only opens
 * while everything else is already on fire is the kind nobody finds in time.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * MARKUP IS A TEMPLATE; THE WORDS ARE CONSTANTS (bead `ro-ujb9.96.6.17`).
 *
 * The page used to be one template literal holding the markup, the style sheet
 * and the two lines a person reads, so the UX text gate measured all of it as
 * one 160-word "string". What the TV shows is the two constants below, and the
 * gate measures exactly those; the markup is this tag, which ESCAPES every
 * value it is given — so the failing path can no longer be interpolated raw by
 * a future edit that forgets `escapeHtml`, the one bug this page must not have.
 */
function html(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  return strings.reduce(
    (out, part, index) => out + part + (index < values.length ? escapeHtml(String(values[index])) : ""),
    "",
  );
}

/** The two lines a person reads from across the room: what is happening, and
 * that it is being handled. "The wall comes back on its own" restated the
 * second, and the pulsing dot already says it is live. */
export const RECONNECT_TITLE = "Tower reconnecting";
export const RECONNECT_RETRY = `Retrying every ${RETRY_SECONDS}s`;

/**
 * The page. Self-contained by necessity — no stylesheet, no font, no image, no
 * module import, because the pipeline that would serve any of them is the thing
 * that just failed.
 *
 * BOTH retry paths ship, and neither is redundant. The `<meta http-equiv>` is
 * handled by the HTML parser, so it still fires on a kiosk with scripting off
 * or a JS context that has already wedged; the `setTimeout` covers the browser
 * (or the kiosk policy) that ignores meta refresh. Whichever wins, the other is
 * moot the instant the document unloads. Nobody is standing in front of this
 * screen to pick up the slack, so it gets both.
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
 * What actually went wrong, in one line.
 *
 * undici's message for a dead network is the useless string "fetch failed" and
 * the diagnosis — ENOTFOUND, ECONNREFUSED, a workerd that died — lives on
 * `err.cause`. Since this middleware ANSWERS the request, vite's error
 * middleware never runs and never logs; if the cause did not make it into our
 * one log line, swallowing the stack would have cost the operator the only
 * record that anything happened.
 */
export function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) return `${err.message}: ${cause.message}`;
  if (typeof cause === "string" && cause) return `${err.message}: ${cause}`;
  return err.message;
}

/**
 * The Connect ERROR middleware. Four arity is not a style choice: that is the
 * only signature Connect will hand an error to.
 *
 * `headersSent` first, before anything else is decided. A dispatch that failed
 * halfway through streaming a response has already committed a status line, and
 * writing a second one throws inside the error path — turning a recoverable
 * blank screen into a crashed request. There is no page to serve at that point;
 * the only honest move is to let it go.
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
    // `originalUrl` is what arrived; `url` may have been rewritten by a
    // middleware upstream, and the rewritten form is not what the operator will
    // recognise on the screen.
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
 * The plugin. Dev only, and deliberately NOT `enforce: "pre"` — unlike the
 * ingest door, which has to run before anything else, this one has to run after
 * everything else.
 *
 * WHERE IT SITS IN THE STACK, which is the entire mechanism:
 *
 * Connect walks its stack forward only. `next(err)` resumes at the layer AFTER
 * the one that failed and calls the first 4-arity handler it finds from there —
 * so an error handler registered BEFORE the failing middleware is never
 * consulted at all. Two facts decide where we have to be:
 *
 *   1. vite appends its own error middleware last, after it has run every
 *      function returned from a `configureServer` hook. Registering from that
 *      returned function is therefore what puts us in front of vite's 500 page.
 *   2. @cloudflare/vite-plugin registers the middleware that calls
 *      `dispatchFetch` — the one that throws in an outage — from a returned
 *      function TOO, and its plugin declares no `enforce`. So registering from
 *      a post-hook is necessary but NOT sufficient: post-hooks run in sorted
 *      plugin order, so a plugin listed before `cloudflare()` gets its handler
 *      appended BEFORE the dispatch middleware, and the dispatch error would
 *      walk straight past it to vite.
 *
 * `order: "post"` on the hook is what makes this independent of where the
 * plugin is listed: vite sorts `configureServer` hooks and pushes `order:
 * "post"` ones to the very end, so our handler is appended after every other
 * plugin's middleware whatever the config does. A silent regression here looks
 * exactly like no plugin at all, which is why the test boots a real vite server
 * with the plugin listed FIRST and a throwing dispatch stand-in listed second.
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
