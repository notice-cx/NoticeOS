// The tiny HTTP vocabulary every Tower API route shares. Extracted so the write
// routes (flag lifecycle, operator decisions, timeline annotations) cannot drift
// apart on the cross-origin guard or on the shape of an error body — one
// implementation, one behaviour.

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  // The Wall polls; never let an intermediary hand back a stale snapshot.
  "cache-control": "no-store",
};

/** An error body is always `{ error: <machine code> }` plus optional context —
 * the browser branches on the code, never on prose. */
export function jsonError(
  error: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: JSON_HEADERS,
  });
}

/**
 * Reject a write that did not come from this origin. Both signals are checked
 * only when the browser sent them: a same-origin `fetch` omits `origin`, and
 * older clients omit `sec-fetch-site`, so an absent header can never be read as
 * a failed check.
 */
export function crossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return (
    (origin !== null && origin !== url.origin) ||
    (fetchSite !== null && fetchSite !== "same-origin")
  );
}

/** True when the request declares a JSON body. */
export function isJsonRequest(request: Request): boolean {
  return Boolean(
    request.headers.get("content-type")?.toLowerCase().startsWith("application/json"),
  );
}
