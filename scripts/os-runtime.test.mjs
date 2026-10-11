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
  invokedDirectly,
  resolveHomeRoot,
  runtimeChildEnv,
  statePaths,
} from './os-runtime.mjs';

// Where the OS's code runs from vs where its state stays. Temp directories only.

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

test('home is the environment’s word, else the code’s own folder', () => {
  assert.equal(resolveHomeRoot('/opt/noticeos', {}), '/opt/noticeos');
  assert.equal(resolveHomeRoot('/opt/noticeos', { [HOME_ENV]: '/state' }), '/state');
  assert.equal(resolveHomeRoot('/opt/noticeos', { [HOME_ENV]: '   ' }), '/opt/noticeos');
});

test('from home, every state path is the one a runner has always used', () => {
  const home = '/state';
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
  const copy = path.join(tempDir('os-runtime-code-'), 'noticeos');
  mkdirSync(path.join(copy, 'workers', 'ingest'), { recursive: true });

  const first = await ensureSharedStateLinks({ codeRoot: copy, homeRoot: home });
  assert.deepEqual(first.created, SHARED_STATE.map((entry) => entry.path));
  assert.deepEqual(first.conflicts, []);
  const second = await ensureSharedStateLinks({ codeRoot: copy, homeRoot: home });
  assert.deepEqual([second.created, second.linked.length, second.conflicts], [[], SHARED_STATE.length, []]);

  // A code folder that grew its own store: reported, never deleted.
  rmSync(path.join(copy, '.wrangler'));
  mkdirSync(path.join(copy, '.wrangler', 'state'), { recursive: true });
  const third = await ensureSharedStateLinks({ codeRoot: copy, homeRoot: home });
  assert.equal(third.conflicts.length, 1);
  assert.match(third.conflicts[0].reason, /is a real directory, not a link to/u);
  assert.equal(existsSync(path.join(copy, '.wrangler', 'state')), true);

  // Home itself needs no links at all.
  assert.deepEqual(await ensureSharedStateLinks({ codeRoot: home, homeRoot: home }), { created: [], linked: [], conflicts: [] });
});

test('a script run through a symbolic link still knows it was invoked', () => {
  // Node resolves the link for import.meta.url but not for argv[1]; a plain
  // comparison would make the script exit silently.
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
