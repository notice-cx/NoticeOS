import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  TEST_VITE_CACHE_PREFIX,
  closeAfterOptimizer,
  createTestViteServer,
  optimizerIdle,
  optimizerOff,
  optimizerWork,
  testViteCacheDir,
  testViteConfig,
} from './test-vite-server.mjs';

// A Vite dev server a test starts waits for its dependency optimizer before it
// closes, runs none when no page is loaded, and keeps its cache in a folder of
// its own. The real Vite half of this lives in
// apps/tower/test/test-vite-server.test.ts; here are its parts, on fakes.

const REPO = fileURLToPath(new URL('../', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** A Vite-shaped server: a client optimizer with `discovered`, and a close that records its calls. */
function fakeServer({ scanProcessing, discovered = {} } = {}) {
  const calls = [];
  const optimizer = { scanProcessing, metadata: { discovered } };
  return {
    calls,
    optimizer,
    environments: { client: { depsOptimizer: optimizer }, ssr: {} },
    async close() { calls.push('close'); },
  };
}

test('the work in flight is a scan and every bundle a found dependency waits on', () => {
  const scan = deferred();
  const bundle = deferred();
  const server = fakeServer({ scanProcessing: scan.promise, discovered: { react: { processing: bundle.promise }, zod: {} } });
  assert.deepEqual(optimizerWork(server), [scan.promise, bundle.promise]);
  assert.deepEqual(optimizerWork(fakeServer()), []);
});

test('idle waits for the work in flight, and for work a run started meanwhile', async () => {
  const scan = deferred();
  const bundle = deferred();
  const server = fakeServer({ scanProcessing: scan.promise });
  let idle = false;
  const waiting = optimizerIdle(server, 5_000).then((result) => { idle = result; });
  // The scan finds a dependency and starts bundling it, then ends.
  server.optimizer.metadata.discovered.react = { processing: bundle.promise };
  scan.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle, false, 'still bundling');
  bundle.resolve();
  await waiting;
  assert.equal(idle, true);
});

test('a finished run left on a dependency counts as done, not as work', async () => {
  const server = fakeServer({ discovered: { react: { processing: Promise.resolve() } } });
  const started = Date.now();
  assert.equal(await optimizerIdle(server, 5_000), true);
  // Answered before its 5 s limit, which a loaded runner still meets (issue #12).
  assert.ok(Date.now() - started < 5_000);
});

test('idle gives up at its timeout', async () => {
  const server = fakeServer({ scanProcessing: new Promise(() => {}) });
  assert.equal(await optimizerIdle(server, 50), false);
});

test('a close waits for the optimizer, whoever calls it, and closes once', async () => {
  const bundle = deferred();
  const server = closeAfterOptimizer(fakeServer({ discovered: { react: { processing: bundle.promise } } }));
  // The test's own close and Vite's SIGTERM handler, at once.
  const first = server.close();
  const second = server.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(server.calls, []);
  bundle.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(server.calls, ['close']);
});

test('a close still closes when the optimizer never goes idle', async () => {
  const server = closeAfterOptimizer(fakeServer({ scanProcessing: new Promise(() => {}) }), 50);
  await server.close();
  assert.deepEqual(server.calls, ['close']);
});

test('the optimizer is off in the client environment only, whatever else set its includes', () => {
  const plugin = optimizerOff();
  const client = { optimizeDeps: { include: ['react/jsx-runtime'], exclude: ['x'] } };
  const ssr = { optimizeDeps: { include: ['y'] } };
  plugin.configEnvironment('client', client);
  plugin.configEnvironment('ssr', ssr);
  assert.equal(plugin.enforce, 'post');
  assert.deepEqual(client.optimizeDeps, { include: [], exclude: ['x'], noDiscovery: true });
  assert.deepEqual(ssr.optimizeDeps, { include: ['y'] });
});

test('a test server gets its own cache folder, no watcher, and no optimizer unless pages load', () => {
  const own = { name: 'own' };
  const throwaway = testViteConfig({ root: '/app', plugins: [own], server: { port: 0, hmr: false } }, { pages: false });
  assert.equal(path.dirname(throwaway.cacheDir), os.tmpdir());
  assert.ok(path.basename(throwaway.cacheDir).startsWith(`${TEST_VITE_CACHE_PREFIX}${process.pid}-`));
  assert.ok(existsSync(throwaway.cacheDir));
  assert.deepEqual(throwaway.server, { port: 0, hmr: false, watch: null });
  assert.equal(throwaway.root, '/app');
  assert.deepEqual(throwaway.plugins.map((plugin) => plugin.name), ['own', optimizerOff().name]);

  const pages = testViteConfig({}, { pages: true });
  assert.deepEqual(pages.plugins, []);
  assert.notEqual(pages.cacheDir, throwaway.cacheDir);
});

test("a cache folder whose process is gone is removed; a live process's is kept", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'test-vite-server-'));
  try {
    const gonePid = spawnSync(process.execPath, ['-e', '']).pid;
    const gone = path.join(parent, `${TEST_VITE_CACHE_PREFIX}${gonePid}-abc`);
    const live = path.join(parent, `${TEST_VITE_CACHE_PREFIX}${process.ppid}-def`);
    const other = path.join(parent, 'not-a-test-cache');
    for (const dir of [gone, live, other]) mkdirSync(dir);
    const made = testViteCacheDir(parent);
    assert.deepEqual(readdirSync(parent).sort(), [path.basename(live), path.basename(made), 'not-a-test-cache'].sort());
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('createTestViteServer starts Vite on the test config and hands back a server whose close waits', async () => {
  const bundle = deferred();
  let given;
  const server = await createTestViteServer(async (config) => {
    given = config;
    return fakeServer({ discovered: { react: { processing: bundle.promise } } });
  }, { root: '/app' }, { pages: false });
  assert.equal(given.root, '/app');
  assert.equal(given.server.watch, null);
  const closing = server.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(server.calls, []);
  bundle.resolve();
  await closing;
  assert.deepEqual(server.calls, ['close']);
});

// Every in-process Vite dev server the repo starts goes through the helper: a
// new one made straight from Vite's createServer would close without waiting.
test("every file that imports Vite's createServer starts its server through createTestViteServer", () => {
  const SKIP = new Set(['node_modules', 'dist', '.wrangler', 'test-results', 'playwright-report', 'ux-flows-results', 'fixture-repo']);
  const importsCreateServer = /import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*["']vite["']/u;
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name) && importsCreateServer.test(readFileSync(file, 'utf8'))) found.push(file);
    }
  };
  for (const top of ['apps', 'scripts', 'workers', 'packages']) walk(path.join(REPO, top));
  const relative = found.map((file) => path.relative(REPO, file)).sort();
  assert.ok(relative.includes(path.join('apps', 'tower', 'e2e', 'server.mjs')), `the scan finds the journey server: ${relative}`);
  const direct = relative.filter((file) => !/createTestViteServer\(\s*createServer\b/u.test(readFileSync(path.join(REPO, file), 'utf8')));
  assert.deepEqual(direct, [], 'these start a Vite server without scripts/test-vite-server.mjs');
});
