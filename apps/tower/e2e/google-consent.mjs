// Google's consent screen, for the isolated journeys. Continue with Google is a full-page trip to accounts.google.com, which no
// journey may make. This answers it as a person who pressed Allow: the
// Tower's own start runs — the production state, signed for this origin —
// and the redirect it answers with, to Google, is replaced by the one Google
// sends back after consent: the Tower's callback with the fixture's synthetic
// code and the same state. The callback, the token exchange (the fixture's
// Google network, harness.ts) and the account's lists are the product's own.
//
// The hop to Google is never made: a request that follows a redirect is not
// routable in Playwright, so letting the Tower's 302 through would take the
// browser off the fixture. It is rewritten before the browser sees it.

/** The code the fixture's Google token endpoint exchanges (harness.ts). */
export const GOOGLE_CONSENT_CODE = "journey-google-consent-code";

/** Install the consent answer on a browser context reaching `base`. */
export async function installGoogleConsent(context, base) {
  await context.route(`${base}/api/integrations/google/oauth/start`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers().location ?? "";
    if (!location.startsWith("https://accounts.google.com/")) return route.fulfill({ response });
    const asked = new URL(location);
    const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", GOOGLE_CONSENT_CODE);
    back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
}
