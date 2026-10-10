import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as fixtureServerModule from '../apps/tower/e2e/fixture-server.mjs';
import * as journeyPortModule from '../apps/tower/e2e/journey-port.mjs';

const { JOURNEY_PORT_ENV, OWNER_PORTS, checkedPort, freeLoopbackPort, journeyOrigin, pinnedPort } = journeyPortModule;
const { parallelServers } = fixtureServerModule;

// Two journey runs on one machine must not collide, and neither may two
// workers of one run.
//
// A fixed port would make a second run in another worktree fail at once with
// "already used", and the flow gate puts the journeys in front of every Tower
// change. Every fixture server binds a free loopback port from apps/tower/e2e/journey-port.mjs,
// started the one way apps/tower/e2e/fixture-server.mjs starts it, and each
// Playwright worker owns its own server (journey-test.ts), so the journeys run
// in parallel without ever sharing a store.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E = path.join(REPO_ROOT, 'apps/tower/e2e');
const read = (file) => readFileSync(path.join(E2E, file), 'utf8');

test('a free loopback port is one the OS will bind, never an owner port', async () => {
  const port = freeLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535);
  assert.ok(!OWNER_PORTS.includes(port));
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise((resolve) => server.close(resolve));
});

test('a pinned run gives each worker its own port from the first; an unpinned one takes free ports', () => {
  assert.equal(pinnedPort(0, {}), null, 'nothing pinned: each server takes a free port');
  assert.equal(pinnedPort(0, { [JOURNEY_PORT_ENV]: '47123' }), 47123, 'worker 0 takes the pinned port');
  assert.equal(pinnedPort(3, { [JOURNEY_PORT_ENV]: '47123' }), 47126, 'worker 3 takes the fourth');
  assert.throws(() => pinnedPort(3, { [JOURNEY_PORT_ENV]: '5170' }), /Unsafe journey port/, 'a worker that would land on an owner port is refused');
  assert.equal(journeyOrigin(47123), 'http://127.0.0.1:47123');
});

test('a run keeps half the cores busy, at most 4 servers, unless JOURNEY_WORKERS says otherwise', () => {
  assert.equal(parallelServers({}, 14), 4);
  assert.equal(parallelServers({}, 4), 2);
  assert.equal(parallelServers({}, 1), 1);
  assert.equal(parallelServers({ JOURNEY_WORKERS: '6' }, 4), 6);
  for (const value of ['0', '2.5', 'many', '17']) assert.throws(() => parallelServers({ JOURNEY_WORKERS: value }, 4), /JOURNEY_WORKERS/);
});

test('an owner port or a nonsense port is refused however it arrives', () => {
  for (const port of [...OWNER_PORTS, 80, 0, 70000, Number.NaN]) {
    assert.throws(() => checkedPort(port), /Unsafe journey port/);
    assert.throws(() => pinnedPort(0, { [JOURNEY_PORT_ENV]: String(port) }), /Unsafe journey port/);
  }
});

test('every runner starts its server through fixture-server.mjs, each worker its own; no journey file hard-codes a port', () => {
  const config = read('playwright.config.ts');
  assert.doesNotMatch(config, /webServer/, 'no one server shared by every worker');
  assert.doesNotMatch(config, /baseURL/, 'the base URL is each worker\'s own server, never the config\'s');
  assert.match(config, /fullyParallel: true, workers: parallelServers\(\)/);
  const fixture = read('journey-test.ts');
  assert.match(fixture, /startFixtureServer\(\{ port: pinnedPort\(workerInfo\.parallelIndex\) \}\)/);
  assert.match(fixture, /\{ scope: "worker"/, 'one server per worker, not per run');
  assert.match(fixture, /baseURL: async \(\{ fixtureServer \}, use\) => \{\s*await use\(fixtureServer\.origin\);/);
  assert.match(fixture, /fixtureServer\.violations\(from\)/, 'a test fails on an isolation violation during it');
  const spec = read('journeys.spec.ts');
  assert.match(spec, /import \{ test, expect \} from "\.\/journey-test";/, 'the spec runs on the worker-owned server');
  assert.doesNotMatch(spec, /import \{[^}]*\btest\b[^}]*\} from "@playwright\/test"/, 'no test on a server nobody started');
  // The offline guard keeps every test's context on the
  // worker's own origin, and the flow gate's walks on theirs.
  assert.match(fixture, /startOfflineProxy\(fixtureServer\.origin\)/, 'the journey owns a transport limited to its fixture origin');
  assert.match(fixture, /await use\(offlineTransport\.proxy\)/, 'the context receives the owned proxy before pages are created');
  assert.match(fixture, /installOfflineGuard\(context, fixtureServer\.origin, \{ transport: offlineTransport \}\)/, 'the origin guard takes the worker\'s owned transport');
  const flowGate = read('flow-gate.mjs');
  assert.match(flowGate, /startOfflineProxy\(base\)/);
  assert.match(flowGate, /proxy: transport\.proxy/);
  assert.match(flowGate, /installOfflineGuard\(context, base, \{ transport \}\)/, 'the flow gate guards each walk on its lane\'s origin');
  for (const file of ['flow-gate.mjs', 'harness.test.mjs']) {
    assert.match(read(file), /startFixtureServer\(/, `${file} starts its server through fixture-server.mjs`);
    assert.doesNotMatch(read(file), /spawn\(/, `${file} starts a server some other way`);
  }
  for (const file of ['playwright.config.ts', 'journey-test.ts', 'fixture-server.mjs', 'journeys.spec.ts', 'flow-gate.mjs', 'ux-walk.mjs', 'ux-flows.mjs', 'harness.test.mjs']) {
    assert.doesNotMatch(read(file), /127\.0\.0\.1:\d{2,5}/, `${file} hard-codes a journey port`);
  }
});

test("a started server gets PATH, its port and the run's throwaway Postgres only, and refuses to start without its isolation guard", () => {
  const starter = read('fixture-server.mjs');
  assert.match(starter, /env: \{ PATH: process\.env\.PATH, JOURNEY_PORT: String\(port\), \[JOURNEY_POSTGRES\]: JSON\.stringify\(postgres\) \}/);
  assert.match(starter, /includes\(ARMED_MARK\)/);
});

test('the hand-written types declare exactly what journey-port.mjs and fixture-server.mjs export', () => {
  for (const [file, module] of [['journey-port', journeyPortModule], ['fixture-server', fixtureServerModule]]) {
    const declared = [...read(`${file}.d.mts`).matchAll(/export declare (?:const|function) (\w+)/g)].map((match) => match[1]).sort();
    assert.deepEqual(declared, Object.keys(module).sort(), `${file}.d.mts`);
  }
});
