// A read a test rewrites before the page sees it. The page keeps a copy of
// each read and sends its validator back (apps/tower/src/lib/read-copies.ts),
// so a rewritten reply must be fetched in full, never answered 304 against
// the server's content, and must not carry the server's validator, or the page
// would later reuse a copy the server never sent.

/** The server's full reply to the intercepted read, and the headers to
 * fulfill the rewritten one with. */
export async function fetchToRewrite(route) {
  const headers = { ...route.request().headers() };
  delete headers["if-none-match"];
  const response = await route.fetch({ headers });
  const reply = { ...response.headers() };
  delete reply.etag;
  return { response, headers: reply };
}
