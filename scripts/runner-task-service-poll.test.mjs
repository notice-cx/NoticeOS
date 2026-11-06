import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boardResults, FEED_PAGE, FEED_PAGES, readFeed, syncTaskService } from './runner/task-service-poll.mjs';
import { runBeadsPoll } from './runner/task-snapshot.mjs';
import { runPanelReviewFiler } from './runner/panel-review.mjs';
import { runTaskMapCheck } from './runner/task-map.mjs';
import { runWatchReadbackFiler } from './runner/watch-readbacks.mjs';
import { summarizeBeadsProject } from './task-snapshot-summary.mjs';
import { readSyncState } from './task-service-cache.mjs';
import { TaskServiceUnavailable } from './task-service.mjs';

// scripts/runner/task-service-poll.mjs: the task snapshot from Ntasks's change
// feed. Ntasks is a scripted task service here; `bd` and the hub probe must never run.

const PROJECT = { projectId: 'p-example', logicalKey: 'example.com', displayName: 'Example', prefix: 'ex' };
const SPOKES = [{ asset: 'example.com', prefix: 'ex' }, { asset: 'shop.example', prefix: 'shop' }];
const task = (fields) => ({ title: fields.id, status: 'open', priority: 2, issueType: 'task', assignee: null, labels: [], ready: false,
  dependencies: [], metadata: {}, updatedAt: '2026-11-06T09:00:00.000Z', createdAt: '2026-11-01T09:00:00.000Z', closedAt: null, ...fields });
const BOARD = { project: 'example.com', prefix: 'ex', readAt: '2026-11-06T10:00:00.000Z', tasks: [
  task({ id: 'ex-1', ready: true, priority: 1 }),
  task({ id: 'ex-2', dependencies: [{ id: 'ex-1', type: 'blocks', title: null, status: 'open' }] }),
  task({ id: 'ex-3', status: 'in_progress', assignee: 'agent' }),
  task({ id: 'ex-4', ready: true, labels: ['human'] }),
  task({ id: 'ex-5', issueType: 'gate', awaitType: 'human', title: 'Approve the launch' }),
  task({ id: 'ex-6', status: 'deferred', deferUntil: '2026-12-01T00:00:00.000Z' }),
], epics: [{ id: 'ex-9', title: 'Rebuild', status: 'open', priority: 2, total: 4, closed: 1, eligibleForClose: false }] };
const CLOSES = { project: 'example.com', prefix: 'ex', readAt: '2026-11-06T10:00:00.000Z', tasks: [
  task({ id: 'ex-7', status: 'closed', closedAt: '2026-11-05T09:00:00.000Z', closeReason: 'Shipped' }),
], epics: null };

async function cacheDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-service-poll-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A task service whose feed is `feed(after, limit)`; `down` answers nothing. */
function ntasks({ feed = () => ({ events: [], lastSeq: 0 }), connected = true, backend, labelled = {}, labelStatus = 200 } = {}) {
  const calls = [];
  const state = { down: false, failBoards: false };
  const service = {
    connected: async () => connected,
    backend: async () => backend ?? (connected ? 'ntasks' : 'local'),
    origin: async () => 'https://ntasks.example.com',
    projects: async () => { if (state.down) throw new TaskServiceUnavailable('network'); return [PROJECT]; },
    tool: async () => { throw new Error('no tools'); },
    async call(call) {
      calls.push(call.path);
      if (state.down) throw new TaskServiceUnavailable('network');
      const url = new URL(call.path, 'https://ntasks.example.com');
      if (url.pathname === '/api/changes') return { status: 200, body: feed(Number(url.searchParams.get('after')), Number(url.searchParams.get('limit'))) };
      if (state.failBoards) return { status: 503, body: { error: 'unavailable' } };
      if (url.searchParams.has('label')) {
        if (labelStatus !== 200) return { status: labelStatus, body: { error: 'invalid_request', detail: 'unknown parameter label' } };
        return { status: 200, body: { tasks: labelled[url.searchParams.get('label')] ?? [], next: null } };
      }
      return { status: 200, body: url.searchParams.get('status') === 'closed' ? CLOSES : BOARD };
    },
  };
  return { service, calls, state };
}
const boardReads = (calls) => calls.filter((call) => call.startsWith('/api/tasks?') && !call.includes('label='));
const labelReads = (calls) => calls.filter((call) => call.startsWith('/api/tasks?') && call.includes('label='));

test('a board reads as the bd lists the snapshot summary was written for', () => {
  const entry = summarizeBeadsProject(SPOKES[0], boardResults(BOARD, CLOSES));
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.ready.map((row) => row.id), ['ex-1', 'ex-4']);
  assert.deepEqual(entry.blocked.map((row) => row.id), ['ex-2']);
  assert.deepEqual(entry.inProgress.map((row) => row.id), ['ex-3']);
  assert.deepEqual(entry.deferred.map((row) => row.id), ['ex-6']);
  assert.deepEqual(entry.recentlyClosed.map((row) => row.id), ['ex-7']);
  assert.deepEqual(entry.epics.map((epic) => [epic.id, epic.total, epic.closed]), [['ex-9', 4, 1]]);
  assert.ok(entry.waiting.some((row) => row.id === 'ex-5'), 'the open human gate waits on a person');
  assert.equal(Object.hasOwn(boardResults(BOARD, CLOSES), 'handoffs'), false);
});

test('the change feed is read at most a bounded number of pages per tick', async () => {
  const pages = [];
  const { service } = ntasks({ feed: (after, limit) => { pages.push(after); return {
    events: Array.from({ length: limit }, (_, index) => ({ seq: after + index + 1, projectId: index === 0 ? PROJECT.projectId : 'p-other' })),
    lastSeq: after + limit } ; } });
  const read = await readFeed(service, 40);
  assert.equal(pages.length, FEED_PAGES);
  assert.deepEqual(pages, Array.from({ length: FEED_PAGES }, (_, index) => 40 + index * FEED_PAGE));
  assert.equal(read.cursor, 40 + FEED_PAGES * FEED_PAGE);
  assert.equal(read.complete, false);
  assert.deepEqual([...read.changed].sort(), ['p-example', 'p-other']);
});

test('a project\'s boards are reread when the feed names it, and otherwise kept', async (t) => {
  const dir = await cacheDir(t);
  let events = [{ seq: 1, projectId: PROJECT.projectId }];
  const { service, calls } = ntasks({ feed: (after) => ({ events: events.filter((event) => event.seq > after), lastSeq: Math.max(after, ...events.map((event) => event.seq)) }) });
  let clock = Date.parse('2026-11-06T12:00:00.000Z');
  const sync = () => syncTaskService({ service, spokes: SPOKES, cacheDir: dir, now: () => clock });

  const first = await sync();
  assert.equal(boardReads(calls).length, 2);
  assert.deepEqual(first.body.projects.map((entry) => [entry.asset, entry.ok, entry.error ?? null]),
    [['example.com', true, null], ['shop.example', false, 'No Ntasks project has the prefix shop']]);
  assert.equal((await readSyncState(dir, 'https://ntasks.example.com')).cursor, 1);

  calls.length = 0; clock += 60_000;
  const quiet = await sync();
  assert.deepEqual(boardReads(calls), []);
  assert.equal(quiet.body.projects[0].ok, true, 'the kept boards still make the snapshot');

  events = [...events, { seq: 2, projectId: PROJECT.projectId }];
  calls.length = 0; clock += 60_000;
  await sync();
  assert.equal(boardReads(calls).length, 2);

  calls.length = 0; clock += 16 * 60_000;
  await sync();
  assert.equal(boardReads(calls).length, 2, 'boards older than the bound are reread with no event');
});

test('the snapshot lane files the Ntasks snapshot and never runs bd', async (t) => {
  const dir = await cacheDir(t);
  const { service, state } = ntasks();
  const posted = [], lines = [];
  const deps = { taskService: service, cacheDir: dir, // A site with tasks in Ntasks has no bd link on this host.
    readConfig: async () => JSON.stringify({ spokes: [{ ...SPOKES[0], database: 'ex', repo: '', unavailableReason: 'example.com has no matching task connection on this host' }] }),
    readToken: async () => 'operator-token', probe: async () => { throw new Error('the hub must not be probed'); },
    run: async () => { throw new Error('bd must not run'); }, url: 'http://door.test/api/beads-snapshot',
    post: async (_url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 201, text: async () => '' }; },
    now: () => Date.parse('2026-11-06T12:00:00.000Z'), state: { skipping: null }, emit: (level, text) => lines.push(`${level} ${text}`), stopped: () => false };
  const body = await runBeadsPoll({ running: true, ready: true }, deps);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].projects.map((entry) => [entry.asset, entry.ok]), [['example.com', true]]);
  assert.equal(body.projects[0].counts.ready, 2);

  state.down = true;
  assert.equal(await runBeadsPoll({ running: true, ready: true }, deps), null);
  assert.equal(posted.length, 1, 'nothing is filed while Ntasks does not answer');
  assert.match(lines.at(-1), /Ntasks did not answer \(network\)/u);
});

test('a board read that failed is read again on the next tick, quiet feed or not', async (t) => {
  const dir = await cacheDir(t);
  let events = [{ seq: 1, projectId: PROJECT.projectId }];
  const { service, calls, state } = ntasks({ feed: (after) => ({ events: events.filter((event) => event.seq > after), lastSeq: Math.max(after, ...events.map((event) => event.seq)) }) });
  let clock = Date.parse('2026-11-06T12:00:00.000Z');
  const sync = () => syncTaskService({ service, spokes: SPOKES, cacheDir: dir, now: () => clock });
  await sync();
  // The feed names the project, and its board read fails.
  events = [...events, { seq: 2, projectId: PROJECT.projectId }];
  clock += 60_000; state.failBoards = true;
  const failed = await sync();
  assert.equal(failed.body.projects[0].ok, false);
  assert.equal((await readSyncState(dir, 'https://ntasks.example.com')).boards[PROJECT.projectId], undefined);
  calls.length = 0; clock += 60_000; state.failBoards = false;
  const next = await sync();
  assert.equal(boardReads(calls).length, 2, 'the failed project is reread with no event naming it');
  assert.equal(next.body.projects[0].ok, true);
});

test('nothing runs against the bd hub while the ingest has never said where the tasks live', async (t) => {
  const dir = await cacheDir(t);
  const { service } = ntasks({ backend: 'unknown' });
  const lines = [], posted = [];
  const never = () => { throw new Error('must not run'); };
  const snapshot = await runBeadsPoll({ running: true, ready: true }, { taskService: service, cacheDir: dir,
    readConfig: async () => JSON.stringify({ spokes: [{ ...SPOKES[0], database: 'ex', repo: '', unavailableReason: 'no link' }] }),
    readToken: async () => 'operator-token', probe: never, run: never, url: 'http://door.test/api/beads-snapshot',
    post: async () => { posted.push(1); return { ok: true, status: 201, text: async () => '' }; },
    state: { skipping: null }, emit: (_level, text) => lines.push(text), stopped: () => false });
  assert.equal(snapshot, null);
  assert.deepEqual(posted, []);
  assert.match(lines.at(-1), /the ingest has not said whether tasks live in Ntasks/u);
  assert.equal(await runPanelReviewFiler({ running: true, ready: true }, { taskService: service, probe: never, readConfig: never, run: never,
    state: { skipping: null, unmapped: new Set(), waiting: new Set() }, emit: (_level, text) => lines.push(text), stopped: () => false }), null);
  assert.equal(await runTaskMapCheck({ taskService: service, readConfig: never, run: never, state: { skipping: null },
    emit: (_level, text) => lines.push(text), stopped: () => false }), null);
  const readbacks = await runWatchReadbackFiler({ taskService: service, readToken: async () => 'operator-token', run: never, readConfig: never,
    fetchImpl: async () => Response.json({ pending: [{ bead: 'ex-1', asset: 'example.com' }], reviews: [] }), emit: (_level, text) => lines.push(text) });
  assert.deepEqual(readbacks, { posted: [], failed: [] });
  assert.ok(lines.some((line) => /watch readbacks wait — the ingest has not said/u.test(line)));
});

test('the snapshot carries handoffs and panel triage from Ntasks, closes of any age included', async (t) => {
  const dir = await cacheDir(t);
  const handoff = task({ id: 'ex-20', status: 'closed', labels: ['noticeos-handoff'], closedAt: '2026-06-01T09:00:00.000Z',
    metadata: { noticeos_source: 'noticeos-handoff', noticeos_asset: 'example.com', noticeos_kind: 'finding', noticeos_rule: 'thin-content', noticeos_key: 'thin-content:/recipes' } });
  const legacy = task({ id: 'ex-21', labels: ['reindex-handoff'],
    metadata: { reindex_source: 'reindex-handoff', reindex_asset: 'example.com', reindex_kind: 'query', reindex_rule: 'striking-distance', reindex_key: 'striking:recipes' } });
  const review = task({ id: 'ex-22', status: 'closed', labels: ['panel-review'], closedAt: '2026-05-10T09:00:00.000Z', title: 'Triage the 2026-05-04 serp panel for example.com',
    metadata: { noticeos_panel_date: '2026-05-04' } });
  const { service, calls } = ntasks({ labelled: { 'noticeos-handoff': [handoff], 'reindex-handoff': [legacy], 'panel-review': [review] } });
  const { body } = await syncTaskService({ service, spokes: SPOKES, cacheDir: dir, now: () => Date.parse('2026-11-06T12:00:00.000Z') });
  assert.equal(labelReads(calls).length, 3);
  const [entry] = body.projects;
  assert.deepEqual(entry.handoffs.map((row) => [row.beadId, row.status, row.key]).sort(),
    [['ex-20', 'closed', 'thin-content:/recipes'], ['ex-21', 'open', 'striking:recipes']]);
  assert.equal(entry.handoffs.find((row) => row.beadId === 'ex-20').closedAt, '2026-06-01T09:00:00.000Z', 'a close five months old');
  assert.ok(entry.panelReview, 'panel triage reads as asked');
});

test('a label read Ntasks does not answer is shown as not asked, and the project still reads', async (t) => {
  const dir = await cacheDir(t);
  const { service } = ntasks({ labelStatus: 400 });
  const { body } = await syncTaskService({ service, spokes: SPOKES, cacheDir: dir, now: () => Date.parse('2026-11-06T12:00:00.000Z') });
  const [entry] = body.projects;
  assert.equal(entry.ok, true);
  assert.equal(Object.hasOwn(entry, 'handoffs'), false);
  assert.equal(Object.hasOwn(entry, 'panelReview'), false);
});
