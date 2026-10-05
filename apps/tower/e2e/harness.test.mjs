// HTTP integration tests of the same disposable server the browser suite uses.
// This is deliberately a subprocess: its fixed clock/network refusal cannot
// leak into the test runner or an owner's runtime.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startTestCluster } from "../../../scripts/postgres-test-cluster.mjs";
import { HANDLER_FAILURE_MARK } from "./handler-failure.mjs";
import { ARMED_MARK, VIOLATION_MARK } from "./isolation-guard.mjs";
import { JOURNEY_POSTGRES, startFixtureServer } from "./fixture-server.mjs";

let cluster;
let server;
let base;
before(async () => {
  // This process starts the run's Postgres itself, as Playwright's global
  // setup does, so it holds the owner's way in (a refused reset, below).
  cluster = await startTestCluster();
  process.env[JOURNEY_POSTGRES] = JSON.stringify(cluster.handle);
  // Started the one way every journey runner starts it (fixture-server.mjs,
  // bead ro-ujb9.167): a free loopback port, PATH and that port only.
  server = await startFixtureServer();
  base = server.origin;
});
after(async () => {
  await server?.stop();
  cluster?.close();
});

async function request(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json", origin: base } }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
const asset = "journey.example";
const setup = { ops: [
  { kind: "file-json-insert", file: "config/integrations.json", pointer: `/assets/${asset}`,
    value: { "bing-webmaster": { status: "needs-setup", since: "2026-09-06" } } },
  { kind: "file-json-insert", file: "config/signal-panels.json", pointer: `/assets/${asset}`,
    value: { enabled: false, reason: "no-lane-yet", since: "2026-09-06" } },
] };

test("the isolated standalone profile survives repeated workspace resets", async () => {
  for (let reset = 0; reset < 2; reset += 1) {
    assert.equal((await request("/__journey/reset", "POST")).status, 200);
    const state = await request("/__journey/status");
    assert.equal(state.status, 200);
    assert.equal(state.body.isolated, true);
    assert.equal(state.body.connected, false);
    assert.deepEqual(state.body.assets, []);
    const wall = await request("/api/wall");
    assert.equal(wall.status, 200);
    assert.deepEqual(wall.body.assets, []);
  }
});

test("real handlers support an isolated fresh-install journey and exact task/gate actions", async () => {
  await request("/__journey/reset", "POST");
  assert.deepEqual((await request("/api/wall")).body.assets, []);
  assert.equal((await request("/__journey/receive", "POST")).status, 409);
  assert.equal((await request("/api/assets", "POST", { id: "invalid/asset", displayName: "Invalid" })).status, 422);
  const created = await request("/api/assets", "POST", { id: asset, domain: asset, displayName: "Journey Example" });
  assert.equal(created.status, 201);
  assert.equal(created.body.asset.status, "onboarding");
  await request("/__journey/fail-next-save", "POST");
  assert.equal((await request("/api/config", "PUT", setup)).status, 503);
  let state = (await request("/__journey/status")).body;
  assert.equal(state.assets.length, 1);
  assert.equal(state.documents["config/integrations.json"].assets[asset], undefined);
  assert.equal((await request("/api/config", "PUT", setup)).status, 200);
  assert.equal((await request("/api/config", "PUT", setup)).status, 409);
  assert.equal((await request("/api/assets", "POST", { id: asset, displayName: "Duplicate" })).status, 409);
  assert.equal((await request("/api/integrations/bing-webmaster/credential", "PUT", { fields: { BING_WEBMASTER_API_KEY: "journey-only-not-a-real-key" } })).status, 204);
  // The credential cards are the ingest's own read of the row the production
  // store sealed (bead ro-ujb9.90): field names from that row, and no verdict
  // until a test stamps one, exactly as a fresh Save reads on an install.
  const card = async (provider) => (await request("/api/integrations/providers")).body.providers
    .find((row) => row.provider.id === provider).credential;
  let bing = await card("bing-webmaster");
  assert.deepEqual([bing.source, bing.fields, bing.missingFields, bing.createdAt, bing.lastOkAt],
    ["store", ["BING_WEBMASTER_API_KEY"], [], "2026-09-06T12:00:00.000Z", null]);
  assert.equal((await request("/api/integrations/bing-webmaster/test", "POST", {})).body.ok, true);
  bing = await card("bing-webmaster");
  assert.deepEqual([bing.lastOkAt, bing.lastError], ["2026-09-06T12:00:00.000Z", null]);
  const accounts = (await request("/api/integrations/providers")).body;
  assert.equal(accounts.keyPresent, true);
  assert.deepEqual(accounts.blockers, []);
  assert.equal(JSON.stringify(accounts).includes("journey-only-not-a-real-key"), false, "A card never carries the credential");
  const untouched = accounts.providers.find((row) => row.provider.id === "google");
  assert.equal(untouched.credential.source, "none");
  assert.equal(untouched.credential.createdAt, null);
  assert.equal(untouched.credential.lastOkAt, null);
  // Integration health is the ingest's own read over this store (bead
  // ro-ujb9.86): the saved connection, the asset, and the test just recorded.
  let health = await request("/api/integrations/health");
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.equal(health.body.available, true);
  const states = (provider, capability) => health.body.items
    .filter((item) => item.provider === provider && item.capability === capability).map((item) => item.state);
  assert.deepEqual(states("bing-webmaster", "bing-discovery"), ["idle"]);
  assert.deepEqual(states("bing-webmaster", "bing-daily"), ["never-run"]);
  assert.deepEqual(states("google", "ga4-daily"), ["disconnected"]);
  assert.equal(health.body.items.find((item) => item.capability === "bing-discovery").lastAttemptAt, "2026-09-06T12:00:00.000Z");
  assert.equal((await request("/__journey/receive", "POST")).status, 409);
  assert.equal((await request("/api/config", "PUT", { ops: [{ kind: "file-json-set", file: "config/integrations.json",
    pointer: `/assets/${asset}/bing-webmaster/siteUrl`, expectAbsent: true, value: "https://journey.example/" }] })).status, 200);
  assert.equal((await request("/__journey/receive", "POST")).status, 200);
  // The collection's own monitoring result makes the mapped site's daily
  // reports Working; the report archive has still never run.
  health = await request("/api/integrations/health");
  assert.deepEqual(health.body.items.filter((item) => item.capability === "bing-daily")
    .map((item) => [item.asset, item.detail, item.state, item.lastSuccessAt]), [[asset, "https://journey.example/", "healthy", "2026-09-06T12:00:00.000Z"]]);
  assert.ok(states("bing-webmaster", "bing-archive").length > 0);
  assert.ok(states("bing-webmaster", "bing-archive").every((state) => state === "never-run"));
  assert.equal(JSON.stringify(health.body).includes("journey-only-not-a-real-key"), false, "Health never carries the credential");
  // A recorded zero-project snapshot retains its timestamp and zero coverage.
  // Publishing the fixture project makes its recorded tasks available.
  assert.deepEqual((await request("/api/task-source")).body,
    { connected: null, sources: [{ id: "beads", connected: false, projects: 0, readAt: null, failing: 0 }] });
  assert.deepEqual((await request("/api/wall")).body.operator, { waiting: 0, urgent: 0, measuredProjects: 0, urgentMeasuredProjects: 0, projectCount: 0, capturedAt: "2026-09-06T12:00:00.000Z" });
  assert.deepEqual((await request("/api/work")).body.projects, []);
  assert.equal((await request("/__journey/task-source", "POST")).status, 200);
  assert.deepEqual((await request("/api/task-source")).body,
    { connected: "beads", sources: [{ id: "beads", connected: true, projects: 1, readAt: "2026-09-06T12:00:00.000Z", failing: 0 }] });
  const wall = await request("/api/wall");
  assert.equal(wall.status, 200);
  assert.equal(wall.body.assets[0].id, asset);
  assert.equal(wall.body.operator.waiting, 2);
  const detail = await request(`/api/assets/${asset}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.asset.id, asset);
  const clicks = detail.body.performance.webSearchClicks.bing.series;
  assert.equal(clicks.length, 35);
  assert.deepEqual(clicks.at(-1), { t: "2026-09-05", v: 35 });
  assert.equal(clicks.slice(-7).reduce((total, point) => total + point.v, 0), 224);
  assert.equal(clicks.slice(-28).reduce((total, point) => total + point.v, 0), 602);
  assert.deepEqual(detail.body.performance.webSearchClicks.google.series, []);
  // A saved project cannot authorize a different database on this host.
  const commandsBefore = (await request("/__journey/status")).body.taskCommands;
  const changeDatabase = (expect, value) => request("/api/config", "PUT", { ops: [{ kind: "file-json-set",
    file: "config/beads.json", pointer: "/spokes/0/database", expect, value }] });
  assert.equal((await changeDatabase("journey_fixture", "unlinked_fixture")).status, 200);
  const unlinked = await request(`/api/tasks?project=${asset}`);
  assert.equal(unlinked.status, 409);
  assert.equal(unlinked.body.error, "project_not_linked");
  assert.deepEqual((await request("/__journey/status")).body.taskCommands, commandsBefore);
  assert.equal((await changeDatabase("unlinked_fixture", "journey_fixture")).status, 200);
  const list = await request(`/api/tasks?project=${asset}`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.tasks.map((row) => row.id).sort(), ["jt-approve", "jt-review"]);
  const task = await request("/api/tasks/jt-review");
  assert.equal(task.status, 200);
  assert.equal(task.body.task.id, "jt-review");
  assert.equal((await request("/api/gates/jt-approve/resolve", "POST", { reason: "Fixture only" })).status, 200);
  state = (await request("/__journey/status")).body;
  assert.equal(state.tasks.find((row) => row.id === "jt-approve").status, "closed");
  assert.equal(state.assets.length, 1);
  assert.equal(JSON.stringify(state).includes("journey-only-not-a-real-key"), false, "Credential sentinel must never appear in reads/journals");
});

test("fixture rejects cross-origin writes and unsupported external operations", async () => {
  const foreign = await fetch(`${base}/__journey/reset`, { method: "POST", headers: { origin: "https://external.example" } });
  assert.equal(foreign.status, 403);
  assert.equal((await request("/api/integrations/bing-webmaster/credential", "PUT", { fields: { BING_WEBMASTER_API_KEY: "anything-else" } })).status, 422);
  assert.equal((await request("/api/runner/scheduled", "POST", {})).status, 404);
  assert.equal((await request("/api/tasks/jt-review/delete", "POST", {})).status, 400);
  const state = (await request("/__journey/status")).body;
  assert.equal(state.isolated, true);
  assert.equal(state.assets.length, 1);
});

// The fixture's own clock, end to end (bead ro-ujb9.89). Its config store saves
// UTC; the checkout this runs from may save anything. Provider report dates
// retain their declared Pacific clock; neither clock comes from owner files.
test("operator UTC and provider Pacific revenue clocks remain distinct without owner configuration", async () => {
  await request("/__journey/reset", "POST");
  assert.equal((await request("/api/assets", "POST", { id: asset, domain: asset, displayName: "Journey Example" })).status, 201);
  assert.equal((await request("/api/config", "PUT", { ops: [{ kind: "file-json-insert", file: "config/integrations.json",
    pointer: `/assets/${asset}`, value: { "ad-network": { status: "needs-setup", since: "2026-09-06" } } }] })).status, 200);
  const settings = await request("/api/settings");
  assert.equal(settings.body.clock.timeZone, "UTC");
  const seeded = await request("/__journey/revenue-history", "POST");
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  // Sep6T12Z is 05:00 Pacific, before the provider's 06:10 cutoff. Sep5's
  // report is not expected yet; Sep4 is retained without replacing yesterday.
  assert.deepEqual([seeded.body.timeZone, seeded.body.today, seeded.body.reportingTimeZone,
    seeded.body.reportingToday, seeded.body.through], ["UTC", "2026-09-06", "America/Los_Angeles", "2026-09-06", "2026-09-04"]);
  const card = (await request("/api/wall")).body.assets.find((row) => row.id === asset);
  assert.deepEqual(card.dailyRevenue, { date: "2026-09-05", amountMinor: null, reportedThrough: "2026-09-04", timeZone: "America/Los_Angeles" });
  assert.equal(card.revenueProjection.status, "ready", JSON.stringify(card.revenueProjection));
  assert.equal(card.revenueProjection.reportedThrough, "2026-09-04");
});

// A refused reset says why, in the answer and on the one line the runner
// attaches to the failing test (bead ro-ujb9.76.56), and never names an
// address or the run's database password (what is withheld:
// scripts/journey-handler-failure.test.mjs).
test("a reset Postgres refuses answers 500 naming the refusal, and the server prints it on its marked line", async () => {
  const from = server.output().length;
  // The owner stops the application role logging in, so the reset's copy
  // cannot be reached.
  const scratch = await cluster.createDatabase("noticeos_harness_owner_dev");
  await cluster.asOwner(scratch, "ALTER ROLE noticeos_app NOLOGIN;");
  try {
    const refused = await fetch(`${base}/__journey/reset`, { method: "POST" });
    const body = await refused.text();
    assert.equal(refused.status, 500);
    assert.match(body, /^Isolated journey handler failed: .*role "noticeos_app" is not permitted to log in/u);
    const password = decodeURIComponent(new URL(cluster.handle.appUrl).password);
    const port = new URL(cluster.handle.appUrl).port;
    const lines = server.failures(from);
    assert.equal(lines.length, 1, server.output().slice(from));
    assert.match(lines[0], new RegExp(`${HANDLER_FAILURE_MARK} POST /__journey/reset: .*role "noticeos_app" is not permitted to log in`, "u"));
    for (const text of [body, server.output().slice(from)]) {
      assert.equal(text.includes(password), false, "no password");
      assert.equal(text.includes(`:${port}`), false, "no address");
    }
  } finally {
    await cluster.asOwner(scratch, "ALTER ROLE noticeos_app LOGIN;");
    await cluster.dropDatabase(scratch);
  }
  // With the role let in again, the same server resets again.
  assert.equal((await request("/__journey/reset", "POST")).status, 200);
});

// Runs last: by now the fresh-install journey above has listed tasks, read one
// and resolved a gate through the real task lane, saved config and read money
// days on its clock. The server refuses and reports every read of `.dev.vars` /
// `.dev.secrets.json`, every read of the checkout's `config/` (the owner's
// settings, time zone included — bead ro-ujb9.89) and every attempt on an owner
// port (e2e/isolation-guard.mjs; its own refusals are pinned by
// scripts/journey-isolation-guard.test.mjs), so an armed guard with no
// violation line proves the harness needed none of them (bead ro-ujb9.81).
test("the harness never reads the operator's secrets files or config, or contacts 5173/8791", () => {
  const output = server.output();
  assert.ok(output.includes(ARMED_MARK), `The isolation guard was not installed:\n${output}`);
  assert.equal(output.includes(VIOLATION_MARK), false, `The journey touched an owner secret, config file or port:\n${output}`);
});
