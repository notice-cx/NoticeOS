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

test('snapshot approval titles use blocked context and preserve actual reasons', () => {
  const held = { id: 'shop-held', title: 'Publish the documentation', status: 'blocked', issue_type: 'task',
    dependencies: [{ depends_on_id: 'shop-gate', type: 'blocks' }] };
  for (const title of [undefined, '', '  ', 'Gate: human', 'gate : HUMAN']) {
    const gate = { id: 'shop-gate', title, status: 'open', issue_type: 'gate', await_type: 'human', description: 'Reason:   ' };
    const entry = summarizeBeadsProject(PROJECT, { active: ok([held]), ready: ok([]), blocked: ok([held]), closed: ok([]), human: ok([]), gates: ok([gate]) });
    assert.equal(entry.waiting[0].title, 'Review approval for Publish the documentation');
    assert.equal(Object.hasOwn(entry.waiting[0], 'reason'), false);
    assert.equal(gate.description, 'Reason:   ');
  }
  const gate = { id: 'shop-gate', title: 'Gate: human', status: 'open', issue_type: 'gate', await_type: 'human', description: 'Reason: Approve the exact scoped action\nAfter checking its result' };
  const entry = summarizeBeadsProject(PROJECT, { active: ok([]), ready: ok([]), blocked: ok([]), closed: ok([]), human: ok([]), gates: ok([gate]) });
  assert.equal(entry.waiting[0].title, 'Approve the exact scoped action\nAfter checking its result');
  assert.equal(gate.description, 'Reason: Approve the exact scoped action\nAfter checking its result');
});

test('work counts include blocked work once and exclude approval records in every state', () => {
  const task = (id, status = 'open', priority = 2) => ({ id, title: id, status, priority, issue_type: 'task' });
  const open = task('shop-open');
  const held = { ...task('shop-held', 'open', 0), dependencies: [{ depends_on_id: 'shop-gate', type: 'blocks' }] };
  const stored = task('shop-stored', 'blocked', 1);
  const working = task('shop-working', 'in_progress', 1);
  const done = task('shop-done', 'closed', 0);
  const parked = task('shop-parked', 'deferred', 0);
  const gate = { ...task('shop-gate', 'open', 0), await_type: 'human' };
  const closedGate = { ...gate, id: 'shop-approved', status: 'closed' };
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok([open, held, stored, working, gate]), ready: ok([open, gate]),
    // A blocked in-progress task stays in the in-progress segment. The stored
    // blocked task is also retained when the dependency query omits it.
    blocked: ok([held, { ...working, status: 'open' }, gate]), closed: ok([done, closedGate]), deferred: ok([parked, { ...gate, status: 'deferred' }]),
    human: ok([]), gates: ok([gate]),
  });
  assert.deepEqual(entry.counts, { open: 3, highPriority: 3, ready: 1, inProgress: 1, blocked: 2,
    closedRecent: 1, deferred: 1, waiting: 1 });
  assert.deepEqual(entry.blocked.map(row => row.id).sort(), ['shop-held', 'shop-stored']);
  assert.deepEqual(entry.recentlyClosed.map(row => row.id), ['shop-done']);
  assert.deepEqual(entry.waiting.map(row => row.id), ['shop-gate']);
  assert.deepEqual(entry.priorities, [1, 2, 1, 0, 0]);
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

test('a newly filed task names the filer and model the task tools recorded, and nobody else', () => {
  const filed = { id: 'shop-1', title: 'Found work', status: 'open', issue_type: 'task', created_at: '2026-10-16T09:00:00Z', created_by: 'claude',
    metadata: { noticeos_filed_by: 'claude', noticeos_filed_model: 'Opus 5.5' } };
  const noModel = { id: 'shop-2', title: 'Filed without a model', status: 'closed', issue_type: 'task', created_at: '2026-10-16T08:00:00Z',
    closed_at: '2026-10-16T08:30:00Z', metadata: { noticeos_filed_by: 'codex' } };
  // A runner filer's task: bd's own creator is an internal actor name, never a filer on the Wall.
  const unnamed = { id: 'shop-3', title: 'Push the waiting commits', status: 'deferred', issue_type: 'task', created_at: '2026-10-16T07:00:00Z',
    created_by: 'os-up-push-filer' };
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok([filed]), ready: ok([filed]), blocked: ok([]), closed: ok([noModel]), deferred: ok([unnamed]),
  });
  assert.deepEqual(entry.recentlyCreated.map((row) => [row.id, row.filedBy, row.filedModel]), [
    ['shop-1', 'claude', 'Opus 5.5'], ['shop-2', 'codex', undefined], ['shop-3', undefined, undefined],
  ]);
  assert.equal('filedModel' in entry.recentlyCreated[1], false);
  assert.equal('filedBy' in entry.recentlyCreated[2], false);
  // Only the new-task list carries a filer.
  assert.equal('filedBy' in entry.ready[0], false);
});

test('the snapshot names who did the work: each worker and model, and the newest claims and closes', async () => {
  const { beadsWork } = await import('./task-snapshot-summary.mjs');
  const active = [
    { id: 'ex-1', title: 'Fix the export', status: 'in_progress', issue_type: 'task', assignee: 'claude', started_at: '2026-10-15T09:00:00Z',
      metadata: { noticeos_claimed_model: 'Opus 5.5' } },
    { id: 'ex-2', title: 'Unclaimed', status: 'open', issue_type: 'task' },
    { id: 'ex-e', title: 'Epic', status: 'in_progress', issue_type: 'epic', assignee: 'claude' },
  ];
  const closed = [
    { id: 'ex-3', title: 'Ship the list', status: 'closed', issue_type: 'task', assignee: 'claude', started_at: '2026-10-14T08:00:00Z',
      closed_at: '2026-10-14T18:00:00Z', close_reason: 'Lists print · 3f2a91c',
      metadata: { noticeos_closed_by: 'codex', noticeos_closed_at: '2026-10-14T18:00:00.000Z', noticeos_closed_model: 'GPT-5-Codex' } },
    // A record for an earlier close does not name this one's closer.
    { id: 'ex-4', title: 'Reopened', status: 'closed', issue_type: 'task', assignee: 'Mara', closed_at: '2026-10-15T10:00:00Z',
      close_reason: 'x'.repeat(400), metadata: { noticeos_closed_by: 'claude', noticeos_closed_at: '2026-10-01T10:00:00Z' } },
  ];
  const { workers, recentWork } = beadsWork(active, closed);
  assert.deepEqual(workers, [
    { id: 'codex', model: 'GPT-5-Codex', closedRecent: 1, inProgress: 0 },
    { id: 'Mara', model: null, closedRecent: 1, inProgress: 0 },
    { id: 'claude', model: 'Opus 5.5', closedRecent: 0, inProgress: 1 },
  ]);
  assert.deepEqual(recentWork.map(event => [event.kind, event.taskId, event.by, event.model]), [
    ['closed', 'ex-4', 'Mara', null], ['claimed', 'ex-1', 'claude', 'Opus 5.5'], ['closed', 'ex-3', 'codex', 'GPT-5-Codex'], ['claimed', 'ex-3', 'claude', null],
  ]);
  assert.equal(recentWork[0].evidence.length, 300);
  assert.equal(recentWork[2].evidence, 'Lists print · 3f2a91c');
});

test('every close counts as work done while its row and event retain the resolution', async () => {
  const { beadsWork } = await import('./task-snapshot-summary.mjs');
  const closer = (resolution, at, extra = {}) => ({ noticeos_closed_by: 'Dana', noticeos_closed_at: at,
    ...(resolution === undefined ? {} : { noticeos_resolution: resolution }), ...extra });
  const closed = [
    { id: 'shop-1', title: 'Shipped', status: 'closed', issue_type: 'task', closed_at: '2026-10-16T10:00:00Z', close_reason: 'Landed in 3f2a91c',
      metadata: closer('done', '2026-10-16T10:00:00Z') },
    { id: 'shop-2', title: 'Not worth it', status: 'closed', issue_type: 'task', closed_at: '2026-10-16T11:00:00Z', close_reason: 'Nobody asked for it',
      metadata: closer('wont-do', '2026-10-16T11:00:00Z') },
    { id: 'shop-3', title: 'Same as shop-1', status: 'closed', issue_type: 'task', closed_at: '2026-10-16T12:00:00Z', close_reason: 'See shop-1',
      metadata: closer('duplicate', '2026-10-16T12:00:00Z', { noticeos_duplicate_of: 'shop-1' }) },
    // A resolution recorded for an earlier close, and a close recorded before resolutions existed, both read as done.
    { id: 'shop-4', title: 'Reopened', status: 'closed', issue_type: 'task', closed_at: '2026-10-16T13:00:00Z', close_reason: 'Fixed after all',
      metadata: closer('cant-reproduce', '2026-10-01T13:00:00Z') },
    { id: 'shop-5', title: 'Older close', status: 'closed', issue_type: 'task', closed_at: '2026-10-16T14:00:00Z', close_reason: 'Done',
      metadata: closer(undefined, '2026-10-16T14:00:00Z') },
  ];
  const entry = summarizeBeadsProject(PROJECT, { active: ok([]), ready: ok([]), blocked: ok([]), closed: ok(closed), deferred: ok([]) });
  const rows = Object.fromEntries(entry.recentlyClosed.map(row => [row.id, [row.resolution ?? null, row.duplicateOf ?? null]]));
  assert.deepEqual(rows, { 'shop-1': [null, null], 'shop-2': ['wont-do', null], 'shop-3': ['duplicate', 'shop-1'], 'shop-4': [null, null],
    'shop-5': [null, null] }, 'a done close carries no key, so its row reads as it always did');
  const { workers, recentWork } = beadsWork([], closed);
  // shop-4's record names an earlier close, and it has no holder, so its close is nobody's.
  assert.deepEqual(workers, [{ id: 'Dana', model: null, closedRecent: 4, inProgress: 0 }], 'all attributed closes count as work done');
  assert.deepEqual(recentWork.map(event => [event.taskId, event.resolution ?? null]), [['shop-5', null], ['shop-3', 'duplicate'],
    ['shop-2', 'wont-do'], ['shop-1', null]]);
});

test('the closed read reaches over this calendar week and last, carries every close, and keeps the recent lists to their week', async () => {
  const { beadsClosesSince } = await import('./task-snapshot-summary.mjs');
  const nowMs = Date.parse('2026-10-17T12:00:00Z');
  const close = (id, at, resolution) => ({ id, title: id, status: 'closed', issue_type: 'task', closed_at: at,
    metadata: resolution === undefined ? {} : { noticeos_closed_by: 'Dana', noticeos_closed_at: at, noticeos_resolution: resolution } });
  const closed = [
    close('shop-1', '2026-10-06T09:00:00Z'), // last week, before the recent week
    close('shop-2', '2026-10-12T09:00:00Z', 'wont-do'),
    close('shop-3', '2026-10-16T09:00:00Z'),
    { id: 'shop-e', title: 'Epic', status: 'closed', issue_type: 'epic', closed_at: '2026-10-16T09:00:00Z' },
  ];
  const asked = [];
  const run = async (argv) => { asked.push(argv); return argv.includes('--closed-after') ? ok(closed) : ok([]); };
  const { projects: [entry] } = await collectBeadsSnapshot({ projects: [PROJECT], run, nowMs, repoRoot: '/r' });
  // Fifteen days: last Monday in any zone, and the boundary day the client may leave out.
  assert.equal(beadsClosesSince(nowMs), '2026-10-02');
  assert.ok(asked.some((argv) => argv[argv.indexOf('--closed-after') + 1] === '2026-10-02'));
  assert.equal(entry.counts.closedRecent, 2);
  assert.deepEqual(entry.recentlyClosed.map((row) => row.id), ['shop-3', 'shop-2']);
  assert.deepEqual(entry.closes, { since: '2026-10-02', items: [
    { at: '2026-10-06T09:00:00.000Z' }, { at: '2026-10-12T09:00:00.000Z', resolution: 'wont-do' }, { at: '2026-10-16T09:00:00.000Z' }] });
});

test('a summary that cannot say how far its read reached, or that read more closes than the store keeps, carries none', async () => {
  const { BEADS_CLOSES_MAX } = await import('../packages/contract/src/task-snapshot.mjs');
  const close = (id) => ({ id, title: id, status: 'closed', issue_type: 'task', closed_at: '2026-10-16T09:00:00Z' });
  const reads = (rows) => ({ active: ok([]), ready: ok([]), blocked: ok([]), closed: ok(rows) });
  assert.equal(Object.hasOwn(summarizeBeadsProject(PROJECT, reads([close('shop-1')])), 'closes'), false);
  const many = summarizeBeadsProject(PROJECT, reads(Array.from({ length: BEADS_CLOSES_MAX + 1 }, (_, index) => close(`shop-${index}`))),
    { closedSince: '2026-10-10', closesSince: '2026-10-02' });
  assert.equal(Object.hasOwn(many, 'closes'), false, 'a week is never counted short');
  assert.equal(many.counts.closedRecent, BEADS_CLOSES_MAX + 1);
});

const PICK = { question: 'Which page keeps the traffic?', options: [{ key: 'a', label: 'Keep the old page' },
  { key: 'b', label: 'Redirect to the new page', recommended: true }] };

test('a task row carries its choices and a person\'s pick, and the pick is a line of who did the work', async () => {
  const { beadsWork } = await import('./task-snapshot-summary.mjs');
  const asking = { id: 'shop-4', title: 'Pick the page', status: 'open', issue_type: 'task', labels: ['human'], metadata: { noticeos_choices: PICK } };
  const handed = { id: 'shop-5', title: 'Pick the copy', status: 'open', issue_type: 'task', metadata: { noticeos_choices: PICK,
    noticeos_choice: { option: 'b', label: 'Redirect to the new page', by: 'Dana', at: '2026-10-16T09:30:00Z', note: 'Ship it Friday' } } };
  const decided = { id: 'shop-6', title: 'Pick the vendor', status: 'closed', issue_type: 'decision', closed_at: '2026-10-16T10:00:00Z',
    close_reason: 'Chose (a) Keep the old page', metadata: { noticeos_choices: PICK, noticeos_closed_by: 'Dana', noticeos_closed_at: '2026-10-16T10:00:00Z',
      noticeos_choice: { option: 'a', label: 'Keep the old page', by: 'Dana', at: '2026-10-16T10:00:00Z' } } };
  const broken = { id: 'shop-7', title: 'Hand-edited', status: 'open', issue_type: 'task', metadata: { noticeos_choices: 'a or b', noticeos_choice: 'b' } };
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok([asking, handed, broken]), ready: ok([asking, handed, broken]), blocked: ok([]), closed: ok([decided]), deferred: ok([]),
  });
  const ready = Object.fromEntries(entry.ready.map(row => [row.id, row]));
  assert.deepEqual([ready['shop-4'].choices, 'choice' in ready['shop-4']], [PICK, false]);
  assert.deepEqual([ready['shop-5'].choice.option, ready['shop-5'].choice.by, ready['shop-5'].choice.note], ['b', 'Dana', 'Ship it Friday']);
  assert.equal('choices' in ready['shop-7'] || 'choice' in ready['shop-7'], false, 'what cannot be read is left out');
  assert.equal(entry.recentlyClosed[0].choice.option, 'a');
  const { recentWork } = beadsWork([asking, handed, broken], [decided]);
  assert.deepEqual(recentWork.filter(event => event.kind === 'chosen').map(event => [event.taskId, event.by, event.at, event.option, event.label, event.model]), [
    ['shop-6', 'Dana', '2026-10-16T10:00:00.000Z', 'a', 'Keep the old page', null],
    ['shop-5', 'Dana', '2026-10-16T09:30:00.000Z', 'b', 'Redirect to the new page', null],
  ]);
  assert.deepEqual(recentWork.slice(0, 2).map(event => event.kind), ['closed', 'chosen'], 'a close is listed before a pick at the same time');
});

test('every row carries its links as the list read reports them, with the other task\'s status where a read holds it', async () => {
  const { BEADS_DEPENDENCIES_MAX } = await import('../packages/contract/src/task-snapshot.mjs');
  const edge = (from, to, type = 'blocks') => ({ issue_id: from, depends_on_id: to, type, created_at: '2026-10-16T09:00:00Z' });
  const row = (id, over = {}) => ({ id, title: `Task ${id}`, status: 'open', priority: 2, issue_type: 'task', ...over });
  const ask = row('shop-ask', { title: 'Pick the page' });
  const held = row('shop-held', { dependencies: [edge('shop-held', 'shop-ask'), edge('shop-held', 'shop-elsewhere', 'related'), edge('shop-held', 'shop-epic', 'parent-child')] });
  const free = row('shop-free', { dependencies: [edge('shop-free', 'shop-done')] });
  const busy = row('shop-busy', { dependencies: Array.from({ length: BEADS_DEPENDENCIES_MAX + 1 }, (_, index) => edge('shop-busy', `shop-x${index}`, 'related')) });
  // `bd ready` and `bd blocked` answer with rows that carry no links.
  const bare = ({ dependencies: _links, ...rest }) => rest;
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok([ask, held, free, busy, row('shop-epic', { issue_type: 'epic' })]),
    ready: ok([ask, free, busy].map(bare)),
    blocked: ok([{ ...bare(held), blocked_by: ['shop-ask'], blocked_by_count: 1 }]),
    closed: ok([row('shop-done', { status: 'closed', closed_at: '2026-10-16T10:00:00Z' })]),
    human: ok([ask]), gates: ok([]),
  });
  const ready = Object.fromEntries(entry.ready.map((issue) => [issue.id, issue]));
  assert.deepEqual(ready['shop-ask'].dependencies, [], 'a task with no links carries none, which is not "not recorded"');
  assert.deepEqual(ready['shop-free'].dependencies, [{ id: 'shop-done', type: 'blocks', status: 'closed' }]);
  assert.equal(Object.hasOwn(ready['shop-busy'], 'dependencies'), false, 'more links than the store keeps: none, never a short list');
  assert.deepEqual(entry.blocked.map((issue) => [issue.id, issue.dependencies]), [['shop-held', [
    { id: 'shop-ask', type: 'blocks', status: 'open' },
    // A task no read holds has no status, rather than a guessed one.
    { id: 'shop-elsewhere', type: 'related' },
    { id: 'shop-epic', type: 'parent-child', status: 'open' },
  ]]]);
  assert.deepEqual(entry.waiting.map((issue) => [issue.id, issue.dependencies]), [['shop-ask', []]]);
});

test('the blocked list is capped, and the tasks a listed decision holds lead it', async () => {
  const { BEADS_BLOCKED_LIMIT } = await import('./task-snapshot-summary.mjs');
  const row = (id, over = {}) => ({ id, title: id, status: 'open', priority: 2, issue_type: 'task', ...over });
  const ask = row('shop-ask');
  const others = Array.from({ length: BEADS_BLOCKED_LIMIT }, (_, index) => row(`shop-b${index}`, {
    dependencies: [{ issue_id: `shop-b${index}`, depends_on_id: 'shop-elsewhere', type: 'blocks' }] }));
  const held = ['shop-h1', 'shop-h2'].map((id) => row(id, { dependencies: [{ issue_id: id, depends_on_id: 'shop-ask', type: 'waits-for' }] }));
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok([ask, ...others, ...held]), ready: ok([ask]), blocked: ok([...others, ...held]), closed: ok([]),
    human: ok([ask]), gates: ok([]),
  });
  assert.equal(entry.counts.blocked, BEADS_BLOCKED_LIMIT + 2, 'the count is the whole answer');
  assert.equal(entry.blocked.length, BEADS_BLOCKED_LIMIT);
  assert.deepEqual(entry.blocked.slice(0, 3).map((issue) => issue.id), ['shop-h1', 'shop-h2', 'shop-b0']);
  assert.deepEqual(summarizeBeadsProject(PROJECT, { active: { code: 1, stdout: '', stderr: 'down' } }).blocked, []);
});
