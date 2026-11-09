// The fixture Ntasks's address: a name under `.test`, which never resolves.
// No request reaches it: a journey's own route answers it from the fixture
// server (ntasks-route.mjs), and the server's CSP names it so the Tower's page
// may call it, as an installation's Tower calls its own Ntasks.
export const JOURNEY_NTASKS_ORIGIN = "https://ntasks.journey.test";
/** Where the fixture server answers what the browser sends to that address. */
export const JOURNEY_NTASKS_PATH = "/__journey/ntasks-origin";
