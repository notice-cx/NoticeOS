import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  PUSH_STATE_LABEL,
  parseRevListCounts,
  parseUnpushedCommits,
  pushStateDecision,
  pushStateTitle,
  pushStateUnreadReason,
  runPushStateFiler,
} from './runner/push-state.mjs';

// scripts/runner/push-state.mjs: the push-state lane. Git and
// `bd` are answered here; nothing fetches a real remote or writes a tracker.

const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY_OLD = Math.floor((NOW - 30 * 3_600_000) / 1000);
const PROJECTS = JSON.stringify({ spokes: [{ asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' }] });

function lane({
  fetch = { code: 0, stdout: '', stderr: '' },
  counts = '0\t2',
  open = [],
  exists = () => true,
  repoRoot = '/host',
} = {}) {
  const bd = [];
  const git = [];
  const lines = [];
  const deps = {
    probe: async () => true,
    readConfig: async () => PROJECTS,
    run: async (argv) => {
      bd.push(argv);
      const verb = argv[2] === '--actor' ? argv[4] : argv[2];
      if (verb === 'list') return { code: 0, stdout: JSON.stringify(open), stderr: '' };
      if (verb === 'create') return { code: 0, stdout: '{"id":"shop-9"}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    git: async (argv) => {
      git.push(argv);
      if (argv.includes('fetch')) return fetch;
      if (argv.includes('rev-list')) return { code: 0, stdout: counts, stderr: '' };
      return { code: 0, stdout: `abc123\x1f${DAY_OLD}\x1fShip the thing\n`, stderr: '' };
    },
    exists,
    now: () => NOW,
    state: { skipping: null, degraded: new Map(), gates: new Map() },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
    repoRoot,
  };
  return { deps, bd, git, lines };
}

/** A real linked folder, `<tmp>/shop`, holding the given entries; the lane
 * reads it through the real `existsSync`. */
function linkedFolder(t, entries) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'push-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of entries) mkdirSync(path.join(root, 'shop', entry), { recursive: true });
  return { repoRoot: path.join(root, 'home'), repoDir: path.join(root, 'shop'), exists: existsSync };
}

test('the decision files, closes or does nothing only on facts it read', () => {
  const base = { fetchOk: true, ahead: 2, oldestUnpushedEpochMs: NOW - 30 * 3_600_000, openPushBeads: [], nowEpochMs: NOW };
  assert.equal(pushStateDecision(base).action, 'file');
  assert.equal(pushStateDecision({ ...base, fetchOk: false }).action, 'skip');
  assert.equal(pushStateDecision({ ...base, openPushBeads: null }).action, 'skip');
  assert.equal(pushStateDecision({ ...base, ahead: 0, openPushBeads: [{ beadId: 'shop-1' }] }).action, 'close');
  assert.equal(pushStateDecision({ ...base, oldestUnpushedEpochMs: NOW - 3_600_000 }).action, 'none');
});

test("git's answers are parsed strictly, and a refusal becomes a reason code", () => {
  assert.deepEqual(parseRevListCounts('3\t1\n'), { behind: 3, ahead: 1 });
  assert.equal(parseRevListCounts('fatal: bad revision'), null);
  assert.deepEqual(parseUnpushedCommits(`abc\x1f10\x1fone\nnot a line\n`), [{ hash: 'abc', committedAtMs: 10_000, subject: 'one' }]);
  assert.equal(pushStateUnreadReason('Permission denied (publickey).'), 'remote-sign-in-refused');
  assert.equal(pushStateUnreadReason('Could not resolve host: example.com'), 'remote-unreachable');
  assert.equal(pushStateUnreadReason('something else'), 'git-read-failed');
});

test('commits unpushed past the threshold file one bead; the gate check runs first', async () => {
  const { deps, bd } = lane();
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.filed, [{ asset: 'shop.example', beadId: 'shop-9', ahead: 2 }]);
  assert.deepEqual(bd[0], ['-C', '/shop', 'gate', 'check']);
  const create = bd.find((argv) => argv.includes('create'));
  assert.ok(create.includes(pushStateTitle('shop.example')));
  assert.ok(create.includes(`${PUSH_STATE_LABEL},human`));
});

test('a pushed project closes its open bead with the evidence', async () => {
  const { deps, bd } = lane({ counts: '0\t0', open: [{ id: 'shop-1', status: 'open', title: pushStateTitle('shop.example') }] });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.closed, [{ asset: 'shop.example', beadId: 'shop-1' }]);
  const close = bd.find((argv) => argv.includes('close'));
  assert.match(close.at(-1), /reports 0 ahead/u);
});

test('an unread remote files and closes nothing, and the run says why', async () => {
  const { deps, bd } = lane({ fetch: { code: 128, stdout: '', stderr: 'Permission denied (publickey).' } });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.failed, [{ asset: 'shop.example', reason: 'remote-sign-in-refused' }]);
  assert.deepEqual([result.filed, result.closed], [[], []]);
  assert.deepEqual(bd.map((argv) => argv[2]), ['gate'], 'only the gate check ran');
});

test('a folder with .beads and no .git is "not a checkout": one INFO line, then silence, and no git', async (t) => {
  const folder = linkedFolder(t, ['.beads']);
  const { deps, bd, git, lines } = lane({ ...folder, open: [{ id: 'shop-1', status: 'open', title: pushStateTitle('shop.example') }] });
  const first = await runPushStateFiler(deps);
  await runPushStateFiler(deps);
  await runPushStateFiler(deps);

  assert.deepEqual(first, { checked: 0, filed: [], closed: [], failed: [] }, 'not an unread spoke in the run record');
  assert.equal(deps.state.degraded.get('shop.example'), 'not-a-checkout');
  assert.deepEqual(git, [], 'no git command runs in a folder that is not a checkout');
  assert.deepEqual(
    bd.map((argv) => argv.slice(2)),
    [['gate', 'check'], ['gate', 'check'], ['gate', 'check']],
    'gates are still checked; nothing is listed, filed or closed',
  );
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    `INFO push state: shop.example — not a checkout: the task project folder ${folder.repoDir} holds no code checkout; ` +
      'link the code repository in task-host.json to read its push state. Nothing was filed or closed for this spoke ' +
      '(silent until it changes)',
  );
});

test('a folder with .git whose fetch fails still warns, once', async (t) => {
  const folder = linkedFolder(t, ['.beads', '.git']);
  const { deps, git, lines } = lane({ ...folder, fetch: { code: 128, stdout: '', stderr: 'Permission denied (publickey).' } });
  const result = await runPushStateFiler(deps);
  await runPushStateFiler(deps);

  assert.deepEqual(result.failed, [{ asset: 'shop.example', reason: 'remote-sign-in-refused' }]);
  assert.deepEqual(git[0], ['-C', folder.repoDir, 'fetch', 'origin', 'main']);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^WARN push state: shop\.example — `git fetch origin main` failed \(Permission denied \(publickey\)\.\); the push state is UNKNOWN/u,
  );
  assert.match(lines[0], /may have no SSH agent/u);
});
