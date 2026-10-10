import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installationDir } from './installation.mjs';
import { HOME_ENV, resolveHomeRoot } from './os-runtime.mjs';
import { PRODUCT_ENV, readProductEnv } from './product-env.mjs';

// The working installation keeps running through the rename. A launchd plist
// installed before the product became NoticeOS is operator-only to change, so
// it still hands the runner REINDEX_OS_MANAGED=1 and REINDEX_OS_HOME. These prove every legacy
// name still reaches the same answer, and that the NoticeOS name wins.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** What a plist installed before the rename sets. */
const INSTALLED_PLIST_ENV = Object.freeze({ REINDEX_OS_MANAGED: '1', REINDEX_OS_HOME: '/Users/operator/dev/reindex-os' });

test('product variables preserve their legacy aliases; new server inputs have none', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(PRODUCT_ENV).map(([key, { name, legacy }]) => [key, [name, legacy]])),
    {
      home: ['NOTICEOS_HOME', 'REINDEX_OS_HOME'],
      installationDir: ['NOTICEOS_INSTALLATION_DIR', 'REINDEX_OS_INSTALLATION_DIR'],
      managed: ['NOTICEOS_MANAGED', 'REINDEX_OS_MANAGED'],
      workerConfigRoot: ['NOTICEOS_WORKER_CONFIG_ROOT', 'REINDEX_OS_WORKER_CONFIG_ROOT'],
      operatorToken: ['NOTICEOS_OPERATOR_TOKEN', 'REINDEX_OPERATOR_TOKEN'],
      workspaceProfile: ['NOTICEOS_WORKSPACE_PROFILE', undefined],
      workspaceOrigin: ['NOTICEOS_WORKSPACE_ORIGIN', undefined],
      workspaceDatabase: ['NOTICEOS_WORKSPACE_DATABASE_URL', undefined],
      identityDatabase: ['NOTICEOS_IDENTITY_DATABASE_URL', undefined],
      identitySecret: ['NOTICEOS_IDENTITY_SESSION_SECRET', undefined],
      identityEdge: ['NOTICEOS_IDENTITY_EDGE', undefined],
      identityEmailFrom: ['NOTICEOS_IDENTITY_EMAIL_FROM', undefined],
      demoWorkspace: ['NOTICEOS_DEMO_WORKSPACE_ID', undefined],
      demoActivityService: ['NOTICEOS_DEMO_ACTIVITY_SERVICE_ID', undefined],
      demoScenarioHash: ['NOTICEOS_DEMO_SCENARIO_HASH', undefined],
      demoStatcounter: ['NOTICEOS_DEMO_STATCOUNTER', undefined],
    },
  );
  assert.equal(HOME_ENV, 'NOTICEOS_HOME');
});

test('a legacy-named variable still works: the installed plist is still the managed service with its home', () => {
  assert.equal(readProductEnv(INSTALLED_PLIST_ENV, 'managed'), '1');
  assert.equal(readProductEnv(INSTALLED_PLIST_ENV, 'home'), '/Users/operator/dev/reindex-os');
  const runtimeCopy = path.join('/Users/operator/dev/reindex-os', '.local', 'runtime', 'runtime-a');
  assert.equal(resolveHomeRoot(runtimeCopy, INSTALLED_PLIST_ENV), '/Users/operator/dev/reindex-os');
  assert.equal(readProductEnv({ REINDEX_OPERATOR_TOKEN: 'op' }, 'operatorToken'), 'op');
  assert.equal(readProductEnv({ REINDEX_OS_WORKER_CONFIG_ROOT: '/srv/one' }, 'workerConfigRoot'), '/srv/one');
});

test('the NoticeOS name wins over the legacy one, and blank means unset', () => {
  const both = { NOTICEOS_HOME: '/srv/notice', REINDEX_OS_HOME: '/Users/operator/dev/reindex-os' };
  assert.equal(readProductEnv(both, 'home'), '/srv/notice');
  assert.equal(readProductEnv({ NOTICEOS_HOME: '  ', REINDEX_OS_HOME: ' /srv/legacy ' }, 'home'), '/srv/legacy');
  assert.equal(readProductEnv({ NOTICEOS_HOME: '' }, 'home'), undefined);
  assert.equal(readProductEnv(undefined, 'home'), undefined);
  assert.equal(readProductEnv({}, 'managed'), undefined);
});

test("a legacy-named installation folder is still this installation's folder", () => {
  assert.equal(installationDir({ root: REPO_ROOT, env: { REINDEX_OS_INSTALLATION_DIR: '/srv/owner' } }), '/srv/owner');
  assert.equal(
    installationDir({ root: REPO_ROOT, env: { NOTICEOS_INSTALLATION_DIR: 'mine', REINDEX_OS_INSTALLATION_DIR: '/srv/owner' } }),
    path.join(REPO_ROOT, 'mine'),
  );
  assert.equal(installationDir({ root: REPO_ROOT, env: {} }), path.join(REPO_ROOT, 'installation'));
});

test("the secrets a lane reads follow a legacy-named home, the way a runtime copy under the installed plist runs", () => {
  const home = '/tmp/a-legacy-home';
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { DEFAULT_DEV_VARS } from './scripts/dev-secrets.mjs'; process.stdout.write(DEFAULT_DEV_VARS);"], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, REINDEX_OS_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, path.join(home, 'workers', 'ingest', '.dev.vars'));
});
