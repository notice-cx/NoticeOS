// @vitest-environment node
//
// The hole this closes is invisible to a healthy system, so the tests have to
// manufacture the outage.
//
// Two layers, and the second is the one that matters. The unit tests below pin
// the decisions — who gets a page, who gets the error, what the page contains.
// But the failure that shipped the bug in the first place was not a wrong
// decision, it was a middleware sitting one position too early in a Connect
// stack: Connect walks forward only, so an error handler registered before the
// throwing middleware never runs, and a plugin in that position is
// indistinguishable from no plugin at all. No fake request can catch that. So
// the last describe boots a real vite dev server with a throwing dispatch
// middleware shaped like @cloudflare/vite-plugin's, and asks over TCP.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import {
  RETRY_SECONDS,
  errorSummary,
  failingPath,
  isDocumentRequest,
  reconnectMiddleware,
  reconnectPage,
  reconnectPageHtml,
} from "../vite/reconnect-page";

/** What a TV sends on a full page load. */
const DOCUMENT_HEADERS = {
  "sec-fetch-dest": "document",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** What the Wall's TanStack Query pollers send. */
const POLL_HEADERS = {
  "sec-fetch-dest": "empty",
  accept: "application/json",
};

function req(url: string, headers: Record<string, string | string[]> = {}) {
  return { url, headers } as unknown as IncomingMessage & { originalUrl?: string };
}

function res(headersSent = false) {
  return {
    statusCode: 200,
    headersSent,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      this.body = chunk ?? "";
      this.ended = true;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Who gets a page. This is the only judgement call in the plugin: everything
// downstream of a wrong answer here is either a frozen TV or a poller trying to
// JSON.parse a holding page.
// ─────────────────────────────────────────────────────────────────────────────

describe("document detection", () => {
  it("reads a navigation off Fetch Metadata", () => {
    expect(isDocumentRequest({ "sec-fetch-dest": "document" })).toBe(true);
  });

  it.each(["empty", "script", "style", "image", "font", "iframe", "worker"])(
    "does not treat sec-fetch-dest: %s as a page",
    (dest) => {
      expect(isDocumentRequest({ "sec-fetch-dest": dest })).toBe(false);
    },
  );

  // The rule that protects the pollers: when Fetch Metadata is present it is the
  // ONLY thing consulted. A `fetch()` whose accept header happens to mention
  // html must still get the rejection its caller is written to handle.
  it("believes sec-fetch-dest alone, even when accept says html", () => {
    expect(
      isDocumentRequest({ "sec-fetch-dest": "empty", accept: "text/html,application/json" }),
    ).toBe(false);
  });

  it("falls back to accept for a browser that sends no Fetch Metadata", () => {
    expect(isDocumentRequest({ accept: DOCUMENT_HEADERS.accept })).toBe(true);
  });

  it.each([
    ["application/json", "a poller"],
    ["*/*", "a bare fetch()"],
    ["text/event-stream", "an EventSource"],
    ["", "a client that said nothing"],
  ])("does not serve a page to accept: %s (%s)", (accept) => {
    expect(isDocumentRequest({ accept })).toBe(false);
  });

  it("serves nothing to a request with no headers at all", () => {
    expect(isDocumentRequest({})).toBe(false);
  });

  it("ignores header casing and stray whitespace", () => {
    expect(isDocumentRequest({ "sec-fetch-dest": " Document " })).toBe(true);
    expect(isDocumentRequest({ accept: "TEXT/HTML" })).toBe(true);
  });

  // Node hands a repeated header over as an array, and reading `.toLowerCase()`
  // off one of those throws — which inside an ERROR middleware would replace the
  // outage with a second, more confusing crash. The cast is the point rather
  // than a workaround: @types/node narrows these two names to `string`, so the
  // shape that would crash is the one the compiler cannot warn about.
  it("survives a repeated header", () => {
    const asHeaders = (h: Record<string, string[]>) => h as unknown as IncomingHttpHeaders;
    expect(isDocumentRequest(asHeaders({ "sec-fetch-dest": ["document", "empty"] }))).toBe(true);
    expect(isDocumentRequest(asHeaders({ accept: ["text/html", "application/json"] }))).toBe(true);
    // The first value is the one read, so this one is a poller, not a page.
    expect(isDocumentRequest(asHeaders({ accept: ["application/json", "text/html"] }))).toBe(false);
  });
});

describe("the failing path", () => {
  it("drops the query — on a TV, which page died is the whole question", () => {
    expect(failingPath("/wall?since=2026-08-08")).toBe("/wall");
  });

  it("keeps a plain path", () => {
    expect(failingPath("/wall")).toBe("/wall");
  });

  it("names something rather than nothing when there is no url", () => {
    expect(failingPath(undefined)).toBe("/");
    expect(failingPath("")).toBe("/");
    expect(failingPath("?x=1")).toBe("/");
  });

  it("truncates a path long enough to push the message off the screen", () => {
    const shown = failingPath(`/${"a".repeat(500)}`);
    expect(shown.length).toBeLessThan(130);
    expect(shown.endsWith("…")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The page itself. Every assertion here is something the TV needs in order to
// come back without a human: the retry, the other retry, and no dependency on
// the pipeline that just failed.
// ─────────────────────────────────────────────────────────────────────────────

describe("the reconnecting page", () => {
  const html = reconnectPageHtml("/wall");

  it("is a whole document — vite's html pipeline is not in play", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Tower reconnecting</title>");
  });

  it("says what is happening, calmly and specifically", () => {
    expect(html).toContain("Tower reconnecting");
    expect(html).toContain(`Retrying every ${RETRY_SECONDS}s`);
    expect(html).toContain("/wall");
  });

  it("carries BOTH retries — the parser one and the script one", () => {
    expect(html).toContain(`<meta http-equiv="refresh" content="${RETRY_SECONDS}" />`);
    expect(html).toContain("location.reload()");
    expect(html).toContain(String(RETRY_SECONDS * 1000));
  });

  it("sits on the wall's own darkness rather than flashing white", () => {
    expect(html).toContain("#0a0a0a");
  });

  // Anything fetched would be fetched through the pipeline that is down, so a
  // single external reference turns the holding page into a second failure.
  it("references nothing it would have to fetch", () => {
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("import ");
    expect(html).not.toContain('type="module"');
  });

  // The Tower's listener is on the LAN, and this page is served for ANY failing
  // navigation — so the path is attacker-supplied text going onto a page.
  it("escapes the path instead of reflecting it", () => {
    const injected = reconnectPageHtml("/<script>alert(1)</script>");
    expect(injected).not.toContain("<script>alert(1)");
    expect(injected).toContain("&lt;script&gt;alert(1)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The middleware's three answers: serve the page, stand aside, stand aside.
// ─────────────────────────────────────────────────────────────────────────────

describe("the error middleware", () => {
  it("answers a failed document load with the reconnecting page", () => {
    const next = vi.fn();
    const response = res();
    reconnectMiddleware()(
      new Error("fetch failed"),
      req("/wall", DOCUMENT_HEADERS),
      response as unknown as ServerResponse,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["retry-after"]).toBe(String(RETRY_SECONDS));
    expect(response.body).toContain("Tower reconnecting");
    expect(response.body).toContain("location.reload()");
    expect(response.body).toContain("/wall");
  });

  it("names the path that arrived, not a rewritten one", () => {
    const response = res();
    const request = req("/index.html", DOCUMENT_HEADERS);
    request.originalUrl = "/wall?tv=1";
    reconnectMiddleware()(
      new Error("fetch failed"),
      request,
      response as unknown as ServerResponse,
      vi.fn(),
    );
    expect(response.body).toContain("/wall");
    expect(response.body).not.toContain("/index.html");
  });

  // Answering the request means vite's error middleware never runs, so it never
  // logs either. Without this the outage would leave no record anywhere.
  it("logs the error it swallowed, cause included", () => {
    const logged = vi.fn();
    const err = new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    reconnectMiddleware(logged)(
      err,
      req("/wall", DOCUMENT_HEADERS),
      res() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(logged).toHaveBeenCalledWith(err, "/wall");
  });

  // THE ASYMMETRY. The pollers are written against a rejected request; hand one
  // of them a 503 full of HTML and it blanks the panel it was holding.
  it("lets a poller's failure keep failing, untouched", () => {
    const next = vi.fn();
    const response = res();
    const err = new Error("fetch failed");
    reconnectMiddleware()(
      err,
      req("/api/wall", POLL_HEADERS),
      response as unknown as ServerResponse,
      next,
    );

    expect(next).toHaveBeenCalledWith(err);
    expect(response.ended).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({});
  });

  it("stays out of the way of an asset request", () => {
    const next = vi.fn();
    reconnectMiddleware()(
      new Error("fetch failed"),
      req("/src/main.tsx", { "sec-fetch-dest": "script", accept: "*/*" }),
      res() as unknown as ServerResponse,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  // A response already committed to the wire cannot be replaced; writing a
  // second status line throws inside the error path and turns a blank screen
  // into a crashed request.
  it("passes a half-sent response straight on, document or not", () => {
    const next = vi.fn();
    const err = new Error("fetch failed mid-stream");
    const response = res(true);
    reconnectMiddleware()(
      err,
      req("/wall", DOCUMENT_HEADERS),
      response as unknown as ServerResponse,
      next,
    );
    expect(next).toHaveBeenCalledWith(err);
    expect(response.ended).toBe(false);
  });

  it("does not log when it did not answer", () => {
    const logged = vi.fn();
    reconnectMiddleware(logged)(
      new Error("fetch failed"),
      req("/api/wall", POLL_HEADERS),
      res() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(logged).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "fetch failed" is undici's entire message; the diagnosis is on `cause`.
// ─────────────────────────────────────────────────────────────────────────────

describe("the log line", () => {
  it("unwraps undici's cause, which is where the reason lives", () => {
    const err = new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND office-mac") });
    expect(errorSummary(err)).toBe("fetch failed: getaddrinfo ENOTFOUND office-mac");
  });

  it("takes a string cause too", () => {
    expect(errorSummary(new Error("boom", { cause: "ECONNREFUSED" }))).toBe("boom: ECONNREFUSED");
  });

  it("survives a causeless error and a thrown non-error", () => {
    expect(errorSummary(new Error("plain"))).toBe("plain");
    expect(errorSummary("just a string")).toBe("just a string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stack position, on a real server.
//
// The stand-in below is shaped exactly like @cloudflare/vite-plugin's dispatch
// middleware — a plugin with NO `enforce` that registers its throwing handler
// from the function `configureServer` returns — and `reconnectPage()` is listed
// FIRST on purpose. That is the arrangement in which plain post-hook
// registration puts our handler in front of the throw, where Connect will never
// reach it; only `order: "post"` survives it.
// ─────────────────────────────────────────────────────────────────────────────

function failingDispatch(): Plugin {
  return {
    name: "test:failing-dispatch",
    apply: "serve",
    configureServer(server) {
      return () => {
        server.middlewares.use((_req, _res, next) => {
          next(new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }));
        });
      };
    },
  };
}

/** Reached only if the error travelled past our handler to the end of the stack.
 * In middleware mode vite's own error middleware defers to the host's `next`
 * rather than rendering its 500 page, so this sentinel is what "kept failing"
 * looks like here; on the real server it is vite's error page. */
const PAST_HANDLER = "past-the-reconnect-handler";

describe("stack position, on a real vite server", () => {
  let vite: ViteDevServer;
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    // The shared test-server helper: no page is loaded, so no optimizer, and
    // its cache is not the Tower's own node_modules/.vite (bead ro-ujb9.192).
    vite = await createTestViteServer(createServer, {
      configFile: false,
      appType: "custom",
      logLevel: "silent",
      server: { middlewareMode: true },
      plugins: [reconnectPage(), failingDispatch()],
    }, { pages: false });

    server = http.createServer((request, response) => {
      vite.middlewares(request, response, () => {
        response.statusCode = 500;
        response.end(PAST_HANDLER);
      });
    });
    // Port 0: the kernel picks from the ephemeral range, so this can never land
    // on the operator's live 5173 or the ingest door's 8791.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await vite?.close();
  }, 30_000);

  // THE REGRESSION TEST. Without `order: "post"` this is vite's error page,
  // because our handler was appended before the middleware that throws.
  it("catches the dispatch failure before vite does", async () => {
    const response = await fetch(`${origin}/wall`, { headers: DOCUMENT_HEADERS });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("Tower reconnecting");
    expect(body).toContain(`<meta http-equiv="refresh" content="${RETRY_SECONDS}" />`);
    expect(body).toContain("location.reload()");
    expect(body).toContain("/wall");
  });

  it("leaves a poller's request failing all the way through", async () => {
    const response = await fetch(`${origin}/api/wall`, { headers: POLL_HEADERS });
    const body = await response.text();

    expect(response.status).not.toBe(503);
    expect(body).not.toContain("Tower reconnecting");
    expect(body).toBe(PAST_HANDLER);
  });
});
