import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTaskHost, readTaskProjects, readTaskProjectConfig, resolveTaskProjects } from './task-project-config.mjs';
import { collectBeadsSnapshot, parseBeadsProjects, parseBeadsSpokes, runBeadsPoll, runWatchReadbackFiler } from './os-up.mjs';

const old = { asset: 'old.example', prefix: 'old', database: 'old', repo: '../old' };
const current = { asset: 'current.example', prefix: 'cur', database: 'cur', repo: '../untrusted-request' };
const host = { repositories: [{ asset: current.asset, prefix: current.prefix, database: current.database, repo: '../linked-checkout' }] };

function options(body, extra = {}) {
  return { token: 'op', readHost: async () => JSON.stringify(host),
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).pathname, '/api/config-documents');
      assert.equal(init.method, 'GET');
      return Response.json({ ready: true, documents: [{ file: 'config/beads.json', version: 4, body }] });
    }, ...extra };
}

test('stored membership wins over exported map while repository paths come only from this host', async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-task-config-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(repoRoot, 'config'));
  await fs.writeFile(path.join(repoRoot, 'config/beads.json'), JSON.stringify({ spokes: [old] }));
  await fs.writeFile(path.join(repoRoot, 'config/task-host.json'), JSON.stringify(host));
  const config = options({ spokes: [current], hub: { host: 'untrusted.example' } }, { repoRoot, readHost: undefined });
  const projects = await readTaskProjects(config);
  assert.deepEqual(projects, [{ ...current, repo: '../linked-checkout' }]);
  assert.deepEqual(parseBeadsProjects(await readTaskProjectConfig(config)), projects);
  assert.equal(JSON.stringify(projects).includes('untrusted'), false);
});

test('unknown or reassigned project links cannot choose a directory, and do not hide linked projects', async () => {
  const projects = resolveTaskProjects({ spokes: [current, old] }, host);
  assert.equal(projects[0].repo, '../linked-checkout');
  assert.equal(projects[1].repo, '');
  assert.match(projects[1].unavailableReason, /no checkout linked on this host/);
  const moved = resolveTaskProjects({ spokes: [{ ...current, prefix: 'new' }] }, host);
  assert.equal(moved[0].repo, '');
  const otherDatabase = resolveTaskProjects({ spokes: [{ ...current, database: 'other' }] }, host);
  assert.equal(otherDatabase[0].repo, '');
  assert.match(otherDatabase[0].unavailableReason, /no checkout linked on this host/);
  const argv = [];
  const snapshot = await collectBeadsSnapshot({ projects, repoRoot: '/host',
    run: async (args) => { argv.push(args); return { code: 0, stdout: '[]', stderr: '' }; },
  });
  assert.ok(argv.length > 0);
  assert.ok(argv.every((args) => args[1] === '/linked-checkout'));
  assert.equal(snapshot.projects[0].ok, true);
  assert.equal(snapshot.projects[1].ok, false);
  assert.match(snapshot.projects[1].error, /no checkout linked on this host/);
});

test('empty membership stays empty; unavailable or invalid configuration never falls back to a file', async () => {
  assert.deepEqual(await readTaskProjects(options({ spokes: [] })), []);
  for (const config of [
    options({ spokes: [current] }, { fetchImpl: async () => Response.json({ ready: false }, { status: 503 }) }),
    options({ spokes: [current] }, { fetchImpl: async () => Response.json({ ready: true, documents: [] }) }),
    options({ spokes: null }),
    options({ spokes: [current, current] }),
    options({ spokes: [current] }, { readHost: async () => { throw new Error('host links missing'); } }),
  ]) await assert.rejects(readTaskProjects(config));
});

test('the runner polls the acknowledged map and publishes per-project setup errors without running unknown checkouts', async () => {
  const argv = [];
  const posted = [];
  const map = options({ spokes: [old, current] });
  await runBeadsPoll({ running: true, ready: true }, {
    probe: async () => true, readConfig: () => readTaskProjectConfig(map), readToken: async () => 'op',
    run: async (args) => { argv.push(args); return { code: 0, stdout: '[]', stderr: '' }; },
    post: async (_url, init) => { posted.push(JSON.parse(init.body)); return { ok: true }; },
    state: { skipping: null }, stopped: () => false, emit: () => {}, now: () => Date.parse('2026-09-09T12:00:00Z'),
  });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].projects.map((row) => [row.asset, row.ok]), [[old.asset, false], [current.asset, true]]);
  assert.ok(argv.every((args) => args[1].endsWith('/linked-checkout')));
});

test('physical backup inventory remains available without the workspace store and retains removed projects', async () => {
  const inventory = { repositories: [{ ...old }, { ...current, repo: '../linked-checkout' }] };
  const local = await readTaskHost({ readHost: async () => JSON.stringify(inventory) });
  assert.deepEqual(local.repositories, inventory.repositories);
  const active = resolveTaskProjects({ spokes: [current] }, local);
  assert.equal(active.length, 1);
  assert.equal(local.repositories.length, 2);
  const brokenCheckout = await readTaskHost({ readHost: async () => JSON.stringify({ repositories: [old, { ...current, repo: null }, { database: 'bad;sql' }] }) });
  assert.deepEqual(parseBeadsSpokes(JSON.stringify({ spokes: brokenCheckout.repositories })), ['old', 'cur']);
  await assert.rejects(readTaskHost({ readHost: async () => JSON.stringify({ repositories: null }) }));
});

test('an acknowledged empty map clears the board without a task hub; an unreadable map never clears it', async () => {
  const posted = [];
  const deps = { probe: async () => { throw new Error('must not probe'); }, readToken: async () => 'op',
    run: async () => { throw new Error('must not execute'); },
    post: async (_url, init) => { posted.push(JSON.parse(init.body)); return { ok: true }; },
    state: { skipping: null }, stopped: () => false, emit: () => {},
  };
  await runBeadsPoll({ running: true, ready: true }, { ...deps, readConfig: () => readTaskProjectConfig(options({ spokes: [] })) });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].projects, []);
  for (const readConfig of [async () => { throw new Error('store unavailable'); }, async () => '{}', async () => JSON.stringify({ spokes: [{}] })]) {
    await runBeadsPoll({ running: true, ready: true }, { ...deps, readConfig });
  }
  assert.equal(posted.length, 1);
});

test('pending readbacks report a configuration outage without claiming projects are unconfigured or executing commands', async () => {
  const emitted = [];
  const result = await runWatchReadbackFiler({ readToken: async () => 'op',
    fetchImpl: async (_url, init) => { assert.notEqual(init.method, 'POST'); return Response.json({ pending: [{ asset: 'current.example', bead: 'cur-aaa' }] }); },
    readConfig: async () => { throw new Error('store unavailable'); },
    run: async () => { throw new Error('must not execute'); }, emit: (_level, text) => emitted.push(text),
  });
  assert.deepEqual(result.posted, []);
  assert.match(result.failed[0], /configuration unavailable: store unavailable/);
  assert.match(emitted[0], /configuration unavailable/);
  assert.doesNotMatch(result.failed[0], /no beads spoke/);
});
