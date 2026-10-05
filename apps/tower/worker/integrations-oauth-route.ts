// Google integration entry. Explicit standalone installs keep their existing
// signed-state GET navigation. Hosted start is an authenticated POST; its
// receiver commits durable person/session/workspace custody before returning
// the consent URL. Only the fixed callback replaces browser Origin checks with
// that single-use custody. It revalidates current authority before exchange.
// Provider secrets and token exchange stay inside the ingest Worker. Callback
// results use a closed vocabulary and never echo provider or transport text.

import type {
  GoogleOAuthCompletion,
  GoogleOAuthStart,
  GooglePropertyDiscovery,
} from "@noticeos/contract";
import {
  GOOGLE_OAUTH_CONNECTED,
  GOOGLE_OAUTH_RESULT_PARAM,
  googleOAuthRedirectUri,
} from "@noticeos/contract";
import { JSON_HEADERS, jsonError } from "./http";
import { googleOAuthRequest } from '../../../scripts/workspace-operations.mjs';

/** The three ingest RPCs these routes call, declared structurally so the test
 * project can bind a double — the same trick every route file here uses. */
export interface GoogleOAuthIngest {
  beginGoogleOAuth(input: { origin: string }, proof?: Request): Promise<GoogleOAuthStart>;
  completeGoogleOAuth(input: {
    code: string;
    state: string;
    redirectUri: string;
    error?: string | null;
  }, proof?: Request): Promise<GoogleOAuthCompletion>;
  discoverGoogleProperties(proof?: Request): Promise<GooglePropertyDiscovery>;
}

/** Where every outcome of this flow lands the operator. */
const INTEGRATIONS_PAGE = "/integrations";

/**
 * A navigation that did not start on this Tower.
 *
 * `none` PASSES, deliberately: it is what a browser sends for an address the
 * person typed or opened from a bookmark, which is a decision they made rather
 * than one a page made for them. What is refused is `cross-site` and
 * `same-site` — a link or a form on some other page aiming at this route.
 *
 * Deliberately not `http.ts`'s `crossOrigin`, which is the guard for a
 * same-origin `fetch` and treats a missing `Origin` as a pass. A top-level
 * navigation never sends `Origin` for a GET, so that guard would check nothing
 * here; this one reads the header that a navigation actually carries.
 */
function crossSiteNavigation(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

function backToPage(url: URL, result: string): Response {
  const target = new URL(INTEGRATIONS_PAGE, url.origin);
  // Back to the connect panel (bead ro-ujb9.96.7.7): on the account's sites
  // once signed in, on the sign-in again when it did not finish.
  target.searchParams.set("connect", "google");
  target.searchParams.set(GOOGLE_OAUTH_RESULT_PARAM, result);
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

/**
 * Standalone GET redirects to Google; hosted POST returns the consent URL.
 *
 * In standalone, the redirect URI is derived from this request's origin,
 * because the operator opens the Tower at some address and Google has to be
 * told that exact string. A configured copy would be a second answer, and the
 * one that lost would produce `redirect_uri_mismatch` — the single most common
 * way an OAuth setup fails.
 */
export async function handleGoogleOAuthStartRequest(
  request: Request,
  url: URL,
  ingest: GoogleOAuthIngest,
  hostedOrigin?: string,
): Promise<Response> {
  if (hostedOrigin !== undefined) {
    try {
      await googleOAuthRequest(request, hostedOrigin, 'start');
      const result = await ingest.beginGoogleOAuth({ origin: hostedOrigin }, request.clone());
      return Response.json(result, { status: result.ok ? 200 : 409, headers: { ...JSON_HEADERS, 'cache-control': 'no-store' } });
    } catch { return jsonError('workspace_entry_unavailable', 403); }
  }
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  if (crossSiteNavigation(request)) return jsonError("forbidden", 403);

  let start: GoogleOAuthStart;
  try {
    start = await ingest.beginGoogleOAuth({ origin: url.origin });
  } catch {
    return backToPage(url, "store_failed");
  }
  if (!start.ok) return backToPage(url, start.error);
  return new Response(null, {
    status: 302,
    headers: {
      location: start.authorizeUrl,
      // A consent URL carries a one-time state. Nothing may cache it, and no
      // referrer may carry it onward.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * `GET /api/integrations/google/oauth/callback` — finish, and go back to the
 * page.
 *
 * The code is read off the query string, handed straight to ingest, and never
 * touched again: it is not logged, not stored, and not echoed into the redirect
 * this route answers with. `error=access_denied` on the query is the operator
 * pressing Cancel on Google's screen — an answer, not a failure, and it gets
 * its own word so the page can say "you cancelled" rather than "something went
 * wrong".
 */
export async function handleGoogleOAuthCallbackRequest(
  request: Request,
  url: URL,
  ingest: GoogleOAuthIngest,
  hostedOrigin?: string,
): Promise<Response> {
  if (hostedOrigin !== undefined) {
    const returnUrl = new URL(hostedOrigin);
    try {
      const parsed = googleOAuthRequest(request, hostedOrigin, 'callback');
      const completion = await ingest.completeGoogleOAuth({ code: parsed.code ?? '', state: parsed.state,
        redirectUri: googleOAuthRedirectUri(hostedOrigin), error: parsed.error }, request.clone());
      return backToPage(returnUrl, completion.ok ? GOOGLE_OAUTH_CONNECTED : completion.error);
    } catch { return backToPage(returnUrl, 'state_invalid'); }
  }
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  // Explicit standalone compatibility: signed state guards this navigation.

  if (url.searchParams.get("error") !== null) return backToPage(url, "denied");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) return backToPage(url, "state_invalid");

  let completion: GoogleOAuthCompletion;
  try {
    completion = await ingest.completeGoogleOAuth({
      code,
      state,
      // Re-derived from THIS request rather than taken from the state, so the
      // two have to agree — that agreement is what binds a state to the origin
      // it was minted for.
      redirectUri: googleOAuthRedirectUri(url.origin),
    });
  } catch {
    return backToPage(url, "store_failed");
  }
  return backToPage(url, completion.ok ? GOOGLE_OAUTH_CONNECTED : completion.error);
}

/**
 * `GET /api/integrations/google/properties` — the GA4 properties and Search
 * Console sites the connected account can see.
 *
 * 200 whichever way it went, like the connection test beside it: "Search
 * Console would not answer" is the ANSWER to the question the button asked. It
 * Standalone retains its existing local door. Hosted entry requires current
 * provider-read admission and original browser evidence at both receivers.
 * Discovery records technical connection health, never a business outcome.
 */
export async function handleGooglePropertiesRequest(
  request: Request,
  ingest: Pick<GoogleOAuthIngest, 'discoverGoogleProperties'>,
): Promise<Response> {
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  let discovery: GooglePropertyDiscovery;
  try {
    discovery = await ingest.discoverGoogleProperties();
  } catch {
    return jsonError("google_properties_failed", 500);
  }
  return Response.json(discovery, { headers: JSON_HEADERS });
}
