import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
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

function lane({ fetch = { code: 0, stdout: '', stderr: '' }, counts = '0\t2', open = [] } = {}) {
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
    exists: () => true,
    now: () => NOW,
    state: { skipping: null, degraded: new Map(), gates: new Map() },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
    repoRoot: '/host',
  };
  return { deps, bd, git, lines };
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

test('os-up.mjs still offers the same push-state names', () => {
  assert.equal(osUp.runPushStateFiler, runPushStateFiler);
  assert.equal(osUp.pushStateDecision, pushStateDecision);
  assert.equal(osUp.PUSH_STATE_LABEL, PUSH_STATE_LABEL);
});
