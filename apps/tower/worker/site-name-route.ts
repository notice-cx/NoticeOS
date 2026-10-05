// `GET /api/site-name?domain=…` — a site's own name, for the add screen (bead
// `ro-ujb9.96.7.5`).
//
// The add screen asks for a domain alone; this reads the name the site gives
// itself, so shop.example.com is saved as "Example Shop" rather than the
// domain's own words, "Shop Example". It is
// a nicety, never a gate: every failure — a refused host, a slow site, a
// redirect elsewhere, no usable title — answers `{ name: null }` with 200, and
// the screen keeps the name it already derived from the domain. Add never waits
// on it.
//
// WHAT IT WILL FETCH. Only `https://<the domain>/`, only for a public-looking
// DNS name (`isLookupHost`: no IP literal, no `localhost`, no internal top
// level), and it follows at most three redirects by hand, checking each hop
// the same way — so the route cannot be pointed at the machine it runs on by a
// redirect either. It reads at most 64 KB, waits at most three seconds, sends
// no cookie and no credential, and returns one short string.

import { assetIdFromDomain } from "../shared/asset-wizard";
import { SITE_NAME_PATH, type SiteNameAnswer, isLookupHost, siteNameFromHtml } from "../shared/site-name";
import { JSON_HEADERS, jsonError } from "./http";

export { SITE_NAME_PATH };

const MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 3_000;

function answer(name: string | null): Response {
  const body: SiteNameAnswer = { name };
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

/** The first `MAX_BYTES` of a response body, as text. */
async function head(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, MAX_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    const room = bytes.byteLength - at;
    if (room <= 0) break;
    bytes.set(chunk.subarray(0, room), at);
    at += Math.min(chunk.byteLength, room);
  }
  return new TextDecoder().decode(bytes);
}

/** The site's home page, following redirects only to hosts the lookup would
 * have fetched in the first place. null for anything else. */
async function fetchHome(domain: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string | null> {
  let url = new URL(`https://${domain}/`);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || !isLookupHost(url.hostname)) return null;
    const response = await fetcher(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "text/html", "user-agent": "NoticeOS site name lookup" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) return null;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("html")) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return head(response);
  }
  return null;
}

export async function handleSiteNameRequest(
  request: Request,
  url: URL,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  const domain = assetIdFromDomain(url.searchParams.get("domain") ?? "");
  if (!isLookupHost(domain)) return answer(null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const html = await fetchHome(domain, fetcher, controller.signal);
    return answer(html === null ? null : siteNameFromHtml(html, domain));
  } catch {
    // Unreachable, refused, timed out or not HTML: the domain's own name
    // stands. Nothing about the failure is the operator's to act on here.
    return answer(null);
  } finally {
    clearTimeout(timer);
  }
}
