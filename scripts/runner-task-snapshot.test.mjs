import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BEADS_OPTIONAL_READS,
  beadsPollArgs,
  collectBeadsSnapshot,
  handoffEntries,
  runBeadsPoll,
  summarizeBeadsProject,
} from './runner/task-snapshot.mjs';

// scripts/runner/task-snapshot.mjs: the task-board
// snapshot. `bd` is answered here and the snapshot is filed at a recorded door;
// nothing reaches a real hub or ingest.

const PROJECT = { asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' };
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

/** A `bd` that answers every poll read with `answers[key]`, or an empty list. */
function bdAnswering(answers = {}) {
  const keys = Object.entries(beadsPollArgs('/r', '2026-09-17'));
  return async (argv) => {
    const [key] = keys.find(([, args]) => args.slice(2).join(' ') === argv.slice(2).join(' ')) ?? ['unknown'];
    return answers[key] ?? ok([]);
  };
}

test('one project is read with four required and six optional reads', () => {
  const args = beadsPollArgs('/r', '2026-09-17');
  assert.deepEqual(Object.keys(args).filter((key) => !BEADS_OPTIONAL_READS.includes(key)), ['active', 'ready', 'blocked', 'closed']);
  assert.ok(args.closed.includes('2026-09-17'));
});

test('a failed required read costs that project only, and says why', () => {
  const entry = summarizeBeadsProject(PROJECT, { active: { code: 1, stderr: 'no database', stdout: '' } });
  assert.deepEqual([entry.ok, entry.error], [false, 'bd active exited 1: no database']);
});

test('epics are not work, and a gate is titled by the ask it holds', () => {
  const task = { id: 'shop-1', title: 'Ship', status: 'open', priority: 1, issue_type: 'task' };
  const epic = { id: 'shop-2', title: 'Epic', status: 'open', priority: 1, issue_type: 'epic' };
  const gate = { id: 'shop-3', title: 'Gate: human', status: 'open', issue_type: 'gate', await_type: 'human',
    description: 'Ad-hoc gate blocking shop-1\n\nReason: Approve the price change' };
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok([task, epic]), ready: ok([task, epic]), blocked: ok([]), closed: ok([]),
    human: ok([]), gates: ok([gate]),
  });
  assert.equal(entry.counts.ready, 1);
  assert.equal(entry.counts.open, 1);
  assert.deepEqual(entry.waiting.map((row) => row.title), ['Approve the price change']);
});

test('the handoff join keeps one bead per finding, open first, and only this site’s', () => {
  const rows = [
    { id: 'shop-9', status: 'closed', closed_at: '2026-09-01T00:00:00Z', metadata: { noticeos_key: 'k1', noticeos_kind: 'finding' } },
    { id: 'shop-8', status: 'open', metadata: { noticeos_key: 'k1', noticeos_kind: 'finding' } },
    { id: 'shop-7', status: 'open', metadata: { noticeos_key: 'k2', noticeos_kind: 'finding', noticeos_asset: 'other.example' } },
  ];
  assert.deepEqual(handoffEntries(rows, 'shop.example').map((entry) => [entry.key, entry.beadId]), [['k1', 'shop-8']]);
});

test('projects keep their saved order, and an unlinked one is a named error', async () => {
  const body = await collectBeadsSnapshot({
    projects: [{ ...PROJECT, asset: 'blog.example', unavailableReason: 'not linked on this host' }, PROJECT],
    run: bdAnswering(),
    nowMs: Date.parse('2026-09-24T00:00:00Z'),
    repoRoot: '/host',
  });
  assert.deepEqual(body.projects.map((entry) => [entry.asset, entry.ok]), [['blog.example', false], ['shop.example', true]]);
});

test('a snapshot is filed at the given door, and a down runtime is one line, not one per tick', async () => {
  const lines = [];
  const posted = [];
  const deps = {
    probe: async () => true,
    readConfig: async () => JSON.stringify({ spokes: [PROJECT] }),
    readToken: async () => 'example-bearer',
    run: bdAnswering(),
    post: async (url, init) => (posted.push({ url, body: JSON.parse(init.body) }), new Response('{}', { status: 201 })),
    now: () => Date.parse('2026-09-24T00:00:00Z'),
    state: { skipping: null },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
    url: 'http://127.0.0.1:8857/api/beads-snapshot',
    repoRoot: '/host',
  };
  assert.equal(await runBeadsPoll({ running: false, ready: false }, deps), null);
  assert.equal(await runBeadsPoll({ running: false, ready: false }, deps), null);
  assert.equal(lines.length, 1);
  await runBeadsPoll({ running: true, ready: true }, deps);
  assert.equal(posted[0].url, 'http://127.0.0.1:8857/api/beads-snapshot');
  assert.deepEqual(posted[0].body.projects.map((entry) => entry.asset), ['shop.example']);
  assert.match(lines[1], /beads snapshot resumed/u);
});
