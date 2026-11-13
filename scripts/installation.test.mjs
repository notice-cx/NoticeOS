// One resolver for "this installation's folder".
//
// config/ holds the product's generic defaults; the installation folder
// (`installation/`, or NOTICEOS_INSTALLATION_DIR) holds one installation's own
// documents, change history and host files. Every reader and writer goes
// through scripts/installation.mts. These cases pin the resolver and that
// local file readers use the installation's copy when it has one and the
// defaults when it does not.

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
  assert.equal(fileName('host-backup.json'), 'host-backup.json');
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
