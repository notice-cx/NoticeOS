// THE JOURNEYS' `test`: EVERY PLAYWRIGHT WORKER OWNS ITS OWN FIXTURE SERVER
// (bead ro-ujb9.167).
//
// The journeys ran one at a time against one shared server, because they all
// reset the same store. Now each worker starts its own server.mjs — its own
// in-memory store, its own synthetic config, its own isolation guard, on its
// own loopback port (fixture-server.mjs) — and every page, context and request
// of that worker's tests reaches only that server: the base URL is the
// worker's server's origin and nothing else. So the tests run in parallel and
// no test ever sees another's store. A test still starts from
// POST /__journey/reset (journeys.spec.ts), so it never depends on the test
// its worker ran before it either.
//
// After every test, any JOURNEY_ISOLATION_VIOLATION the server printed while
// it ran fails that test by name: a read of the operator's secrets or config,
// or an attempt on an owner port (isolation-guard.mjs).
//
// And no page leaves that server, not even by following a redirect: the
// offline guard (offline-guard.mjs, bead ro-o3hv) aborts every request to
// another origin and fails the test that was redirected to one, naming the URL.
import { test as base, expect } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./fixture-server.mjs";
import { pinnedPort } from "./journey-port.mjs";
import { installOfflineGuard, startOfflineProxy, type OfflineGuard, type OfflineProxy } from "./offline-guard.mjs";

export const test = base.extend<{ isolationCheck: void; offlineGuard: OfflineGuard; offlineTransport: OfflineProxy }, { fixtureServer: FixtureServer }>({
  offlineTransport: async ({ fixtureServer }, use) => {
    const transport = await startOfflineProxy(fixtureServer.origin);
    try { await use(transport); } finally { await transport.close(); }
  },
  proxy: async ({ offlineTransport }, use) => { await use(offlineTransport.proxy); },
  offlineGuard: [async ({ context, fixtureServer, offlineTransport }, use) => {
    const guard = await installOfflineGuard(context, fixtureServer.origin, { transport: offlineTransport });
    try { await use(guard); } finally {
      await guard.close();
      expect(guard.check(), "the browser attempted to leave the fixture").toBeNull();
    }
  }, { auto: true }],
  fixtureServer: [async ({}, use, workerInfo) => {
    const server = await startFixtureServer({ port: pinnedPort(workerInfo.parallelIndex) });
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  }, { scope: "worker", timeout: 90_000 }],
  // Deliberately never read from BASE_URL or the config: a journey never
  // attaches to the managed owner service, an existing browser or a remote site.
  baseURL: async ({ fixtureServer }, use) => {
    await use(fixtureServer.origin);
  },
  isolationCheck: [async ({ fixtureServer }, use, testInfo) => {
    const from = fixtureServer.output().length;
    await use();
    // A failing test carries why each fixture call it made failed, in the
    // server's own words (bead ro-ujb9.76.56): the answer alone says 500.
    const failures = fixtureServer.failures(from);
    if (failures.length > 0 && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("fixture server failures", { body: failures.join("\n"), contentType: "text/plain" });
    }
    expect(fixtureServer.violations(from), "the fixture server touched an owner secret, config file or port during this test").toEqual([]);
  }, { auto: true }],
});

export { expect };
