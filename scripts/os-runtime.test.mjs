import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  HOME_ENV,
  SHARED_STATE,
  ensureSharedStateLinks,
  homeOfRuntimeSlot,
  invokedDirectly,
  plistRunsFrom,
  postgresConfigRefusal,
  resolveHomeRoot,
  runtimeChildEnv,
  runtimeLayout,
  statePaths,
} from './os-runtime.mjs';

// Where the live OS's code runs from vs where its state stays. Temp
// directories only.

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

test('home is the environment’s word, else the runtime layout, else the code’s own checkout', () => {
  const home = '/Users/op/dev/reindex-os';
  const copy = path.join(home, '.local', 'runtime', 'runtime-b');
  assert.equal(homeOfRuntimeSlot(copy), home);
  assert.equal(homeOfRuntimeSlot(home), null);
  assert.equal(homeOfRuntimeSlot(path.join(home, '.local', 'runtime', 'current')), null, 'only the two copies');
  assert.equal(resolveHomeRoot(copy, {}), home);
  assert.equal(resolveHomeRoot(home, {}), home);
  assert.equal(resolveHomeRoot(copy, { [HOME_ENV]: '/elsewhere' }), '/elsewhere');
  assert.equal(resolveHomeRoot(home, { [HOME_ENV]: '   ' }), home);
});

test('from home, every state path is the one a runner has always used', () => {
  const home = '/Users/op/dev/reindex-os';
  const state = statePaths(home);
  assert.equal(state.persistState, path.join(home, '.wrangler', 'state'));
  assert.equal(state.logFile, path.join(home, '.local', 'logs', 'os-up.log'));
  assert.equal(state.jobRunsFile, path.join(home, '.local', 'logs', 'job-runs.jsonl'));
  assert.equal(state.runnerStateFile, path.join(home, '.local', 'runner-state.json'));
  assert.equal(state.devSecrets, path.join(home, 'workers', 'ingest', '.dev.secrets.json'));
  assert.equal(state.taskHost, path.join(home, 'config', 'task-host.json'));
  // The dev server's store: vite.config.ts defaults to exactly this path when
  // OS_UP_PERSIST_STATE is unset, and honors the variable when it is set.
  assert.deepEqual(runtimeChildEnv(home, {}), { [HOME_ENV]: home, OS_UP_PERSIST_STATE: state.persistState });
  assert.equal(runtimeChildEnv(home, { OS_UP_PERSIST_STATE: '/harness/state' }).OS_UP_PERSIST_STATE, '/harness/state');
});

test('links are created once, left alone when right, and never replace real data', async () => {
  const home = tempDir('os-runtime-home-');
  const copy = path.join(runtimeLayout(home).dir, 'runtime-a');
  mkdirSync(path.join(copy, 'workers', 'ingest'), { recursive: true });

  const first = await ensureSharedStateLinks({ codeRoot: copy, homeRoot: home });
  assert.deepEqual(first.created, SHARED_STATE.map((entry) => entry.path));
  assert.deepEqual(first.conflicts, []);
  const second = await ensureSharedStateLinks({ codeRoot: copy, homeRoot: home });
  assert.deepEqual([second.created, second.linked.length, second.conflicts], [[], SHARED_STATE.length, []]);

  // A copy that grew its own store: reported, never deleted.
  rmSync(path.join(copy, '.wrangler'));
  mkdirSync(path.join(copy, '.wrangler', 'state'), { recursive: true });
  const third = await ensureSharedStateLinks({ codeRoot: copy, homeRoot: home });
  assert.equal(third.conflicts.length, 1);
  assert.match(third.conflicts[0].reason, /is a real directory, not a link to/u);
  assert.equal(existsSync(path.join(copy, '.wrangler', 'state')), true);

  // Home itself needs no links at all.
  assert.deepEqual(await ensureSharedStateLinks({ codeRoot: home, homeRoot: home }), { created: [], linked: [], conflicts: [] });
});

test('the installed plist says whether the service runs the runtime copy or the checkout', () => {
  const home = '/Users/op/dev/reindex-os';
  const plist = (runner) => `<plist><array><string>/opt/homebrew/bin/node</string><string>${runner}</string></array></plist>`;
  assert.equal(plistRunsFrom(plist(`${home}/.local/runtime/current/scripts/os-up.mjs`), home), 'runtime');
  assert.equal(plistRunsFrom(plist(`${home}/scripts/os-up.mjs`), home), 'checkout');
  assert.equal(plistRunsFrom(plist('/elsewhere/scripts/os-up.mjs'), home), 'other');
  assert.equal(plistRunsFrom(null, home), 'missing');
});

test('a script run through the runtime link still knows it was invoked', () => {
  // launchd runs <home>/.local/runtime/current/scripts/os-up.mjs; node resolves
  // the link for import.meta.url but not for argv[1]. A plain comparison made
  // the runner exit silently under launchd.
  const dir = tempDir('os-runtime-link-');
  const real = path.join(dir, 'runtime-a', 'scripts', 'os-up.mjs');
  mkdirSync(path.dirname(real), { recursive: true });
  writeFileSync(real, '');
  symlinkSync('runtime-a', path.join(dir, 'current'));
  const viaLink = path.join(dir, 'current', 'scripts', 'os-up.mjs');
  assert.equal(invokedDirectly(viaLink, pathToFileURL(real).href), true);
  assert.equal(invokedDirectly(real, pathToFileURL(real).href), true);
  assert.equal(invokedDirectly(path.join(dir, 'other.mjs'), pathToFileURL(real).href), false);
  assert.equal(invokedDirectly(undefined, pathToFileURL(real).href), false);
});

test('runtime configs require Postgres and refuse legacy, mixed or unknown stores', () => {
  const postgres = { hyperdrive: [{ binding: 'POSTGRES', id: 'fixture' }] };
  assert.equal(postgresConfigRefusal(JSON.stringify(postgres)), null);
  assert.equal(postgresConfigRefusal(JSON.stringify({ ...postgres, d1_databases: [] })), null);
  for (const config of [
    { d1_databases: [{ binding: 'DB', database_id: 'fixture' }] },
    { ...postgres, d1_databases: [{ binding: 'OTHER', database_id: 'fixture' }] },
    { ...postgres, d1_databases: {} },
    {}, { hyperdrive: [{ binding: 'OTHER' }] }, null, [], 'not-json',
  ]) {
    const text = typeof config === 'string' ? config : JSON.stringify(config);
    assert.equal(typeof postgresConfigRefusal(text), 'string', text);
  }
});
