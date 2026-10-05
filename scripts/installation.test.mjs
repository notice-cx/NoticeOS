// One resolver for "this installation's folder" (bead ro-ujb9.125).
//
// config/ holds the product's generic defaults; the installation folder
// (`installation/`, or NOTICEOS_INSTALLATION_DIR) holds one installation's own
// documents, change history and host files. Every reader and writer goes
// through scripts/installation.mts. These cases pin the resolver, and that the
// local runner's readers — the task projects, the host's repository links and
// the pull list — read the installation's files when it has them, in the real
// files' shapes (example-named), and the defaults when it does not.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_INSTALLATION_DIR,
  INSTALLATION_DIR_ENV,
  checkoutRelative,
  fileName,
  installationDir,
  installationPath,
  productDefaultPath,
  readablePath,
} from './installation.mjs';
import { readDocumentFile } from './config-apply-core.mjs';
import { readTaskHost, readTaskProjects, taskHostFile } from './task-project-config.mjs';
import { statePaths } from './os-runtime.mjs';

/** A throwaway checkout: `defaults` into config/, `installed` into installation/. */
async function checkout(t, { defaults = {}, installed = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'installation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [dir, files] of [['config', defaults], ['installation', installed]]) {
    for (const [name, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, dir, name)), { recursive: true });
      await fs.writeFile(path.join(root, dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
    }
  }
  return root;
}

// The real files' shapes, example-named.
const PULL = [{ asset: 'shop.example', url: 'https://shop.example/api/internal/metrics', enabled: true, format: 'prometheus', metrics: { signups: { counter: 'profiles' } } }];
const HOST = { repositories: [{ asset: 'shop.example', prefix: 'shop', repo: '../shop.example', database: 'shop' }] };
const BEADS = { hub: { host: '127.0.0.1', port: 3308, user: 'root', dataDir: '.local/beads-dolt' }, spokes: [{ asset: 'shop.example', prefix: 'shop', database: 'shop', repo: '../shop.example' }] };

test('the folder is installation/ in the checkout unless the variable moves it', () => {
  const root = '/srv/noticeos';
  assert.equal(DEFAULT_INSTALLATION_DIR, 'installation');
  assert.equal(installationDir({ root, env: {} }), '/srv/noticeos/installation');
  assert.equal(installationDir({ root, env: { [INSTALLATION_DIR_ENV]: '  ' } }), '/srv/noticeos/installation');
  assert.equal(installationDir({ root, env: { [INSTALLATION_DIR_ENV]: '/var/lib/noticeos' } }), '/var/lib/noticeos');
  assert.equal(installationDir({ root, env: { [INSTALLATION_DIR_ENV]: '../mine' } }), '/srv/mine');
});

test('a document keeps its store name and finds its file in either folder', () => {
  const root = '/srv/noticeos';
  const env = {};
  assert.equal(fileName('config/pull.json'), 'pull.json');
  assert.equal(fileName('task-host.json'), 'task-host.json');
  assert.equal(installationPath('config/pull.json', { root, env }), '/srv/noticeos/installation/pull.json');
  assert.equal(installationPath('changesets', { root, env }), '/srv/noticeos/installation/changesets');
  assert.equal(productDefaultPath('config/pull.json', { root }), '/srv/noticeos/config/pull.json');
  for (const bad of ['', '../x.json', 'config/../x.json', '/etc/passwd', 'a//b']) {
    assert.throws(() => fileName(bad), /not an installation file name/);
  }
  assert.equal(checkoutRelative('/srv/noticeos/installation/pull.json', { root }), 'installation/pull.json');
  assert.equal(checkoutRelative('/var/lib/noticeos/pull.json', { root }), '/var/lib/noticeos/pull.json');
});

test('a read takes the installation\'s copy, else the product default', async (t) => {
  const fresh = await checkout(t, { defaults: { 'pull.json': [] } });
  assert.equal(readablePath('config/pull.json', { root: fresh, env: {} }), path.join(fresh, 'config', 'pull.json'));
  assert.deepEqual(await readDocumentFile('config/pull.json', { repoRoot: fresh }), []);

  const owned = await checkout(t, { defaults: { 'pull.json': [] }, installed: { 'pull.json': PULL } });
  assert.equal(readablePath('config/pull.json', { root: owned, env: {} }), path.join(owned, 'installation', 'pull.json'));
  assert.deepEqual(await readDocumentFile('config/pull.json', { repoRoot: owned }), PULL);
});

test('the host\'s repository links come from the installation, and a fresh clone has none', async (t) => {
  const fresh = await checkout(t, { defaults: { 'task-host.json': { repositories: [] } } });
  assert.equal(taskHostFile(fresh), path.join(fresh, 'config', 'task-host.json'));
  assert.deepEqual(await readTaskHost({ repoRoot: fresh }), { repositories: [] });
  assert.equal(statePaths(fresh).taskHost, path.join(fresh, 'config', 'task-host.json'));

  const home = await checkout(t, { defaults: { 'task-host.json': { repositories: [] } }, installed: { 'task-host.json': HOST } });
  assert.equal(taskHostFile(home), path.join(home, 'installation', 'task-host.json'));
  assert.deepEqual(await readTaskHost({ repoRoot: home }), HOST);
  assert.equal(statePaths(home).taskHost, path.join(home, 'installation', 'task-host.json'));
});

test('the runner resolves the stored task projects against the installation\'s links', async (t) => {
  const home = await checkout(t, { defaults: { 'task-host.json': { repositories: [] } }, installed: { 'task-host.json': HOST } });
  const store = async () => Response.json({ ready: true, documents: [{ file: 'config/beads.json', version: 3, body: BEADS }] });
  assert.deepEqual(await readTaskProjects({ repoRoot: home, token: 'op', fetchImpl: store }), [
    { asset: 'shop.example', prefix: 'shop', database: 'shop', repo: '../shop.example' },
  ]);

  // The same stored projects on a clone with no installation links: every
  // project reports that it needs local setup instead of opening a checkout.
  const fresh = await checkout(t, { defaults: { 'task-host.json': { repositories: [] } } });
  const [project] = await readTaskProjects({ repoRoot: fresh, token: 'op', fetchImpl: store });
  assert.equal(project.repo, '');
  assert.match(project.unavailableReason, /no checkout linked on this host/);
});

test('a folder pnpm start made, with no inventory at all, links no checkouts rather than failing', async (t) => {
  // bead ro-ujb9.174: not a checkout, so neither its own copy nor a default.
  const started = await checkout(t);
  assert.deepEqual(await readTaskHost({ repoRoot: started, absentLinksNone: true }), { repositories: [] });
  // The managed host's backup reads a lost inventory as lost, not as empty.
  await assert.rejects(readTaskHost({ repoRoot: started }), { code: 'ENOENT' });
  const store = async () => Response.json({ ready: true, documents: [{ file: 'config/beads.json', version: 1, body: BEADS }] });
  const [project] = await readTaskProjects({ repoRoot: started, token: 'op', fetchImpl: store });
  assert.match(project.unavailableReason, /no checkout linked on this host/);
  // A file that is there but broken still fails.
  await fs.mkdir(path.join(started, 'installation'), { recursive: true });
  await fs.writeFile(path.join(started, 'installation', 'task-host.json'), '{broken');
  await assert.rejects(readTaskHost({ repoRoot: started, absentLinksNone: true }));
});
