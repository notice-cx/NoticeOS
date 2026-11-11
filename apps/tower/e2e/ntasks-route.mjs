import { JOURNEY_NTASKS_ORIGIN, JOURNEY_NTASKS_PATH } from "./ntasks-origin.mjs";

// The fixture Ntasks, for the journeys that sign a person in to it. Every
// request the browser sends to its address, a page's call or a full-page trip
// to its sign-in, is sent instead to the fixture server, which answers it as
// that Ntasks (ntasks-fixture.ts) from the same state the Tower's own server
// reaches with the installation's credential. The browser follows Ntasks's
// redirect back to the Tower itself, so no hop leaves the fixture.

/** Install the fixture Ntasks on a browser context, or one page of it, whose
 * Tower is at `base`. A page's own route answers before its context's, so a
 * page opened at the Tower's second address installs its own. */
export async function installFixtureNtasks(target, base) {
  await target.route(`${JOURNEY_NTASKS_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const asked = new URL(request.url());
    // A page's call carries its origin, which Ntasks answers only for a
    // registered app; a navigation carries none.
    try {
      const headers = { ...(await request.allHeaders()), ...(request.isNavigationRequest() ? {} : { origin: base }) };
      const response = await route.fetch({ url: `${base}${JOURNEY_NTASKS_PATH}${asked.pathname}${asked.search}`, headers, maxRedirects: 0 });
      return await route.fulfill({ response });
    } catch (error) {
      // A page still polling Ntasks when its test ends: the offline guard's
      // own close cancels the call (offline-guard.mjs). Any other failure fails the test.
      if (String(error?.message).includes("offline-guard-close-")) return;
      throw error;
    }
  });
}
