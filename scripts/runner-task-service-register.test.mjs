import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileNtasksPanelReview, PANEL_REVIEW_ACTOR, panelReviewDueDate, runPanelReviewFiler } from './runner/panel-review.mjs';
import { runTaskMapCheck } from './runner/task-map.mjs';
import { runWatchReadbackFiler } from './runner/watch-readbacks.mjs';
import { withNoticeosRecords } from './task-service.mjs';

// The runner's filing lanes while tasks live in Ntasks: panel reviews,
// verdict comments and outcome reviews are read and written there, each named
// for its lane. Ntasks is a scripted task service here; `bd` and the hub probe
// must never run.

const PROJECT = { projectId: 'p-shop', logicalKey: 'shop.example', displayName: 'Shop', prefix: 'shop' };
// A site whose tasks are in Ntasks has no bd link on this host.
const SPOKES = JSON.stringify({ spokes: [{ asset: 'shop.example', prefix: 'shop', repo: '', database: 'shop',
  unavailableReason: 'shop.example has no matching task connection on this host' }] });
const VERSION = '00000004-2026-09-22T13-10-04-637Z-4f83dc';
const UP = { running: true, ready: true };
const never = () => { throw new Error('bd and the hub must not be reached'); };

/** An Ntasks that keeps tasks, comments, retry keys and links, as the HTTP routes and add_dependency answer. */
function ntasks(tasks = []) {
  const state = { tasks: [...tasks], comments: [], links: [], creates: [], keys: new Map() };
  const service = {
    connected: async () => true,
    backend: async () => 'ntasks',
    origin: async () => 'https://ntasks.example.com',
    projects: async () => [PROJECT],
    async tool(name, args, actor) {
      assert.equal(name, 'add_dependency');
      state.links.push({ ...args, actor });
      return {};
    },
    async call({ method, path, body, idempotencyKey, onBehalfOf }) {
      const url = new URL(path, 'https://ntasks.example.com');
      if (method === 'GET' && url.pathname === '/api/tasks') {
        assert.equal(url.searchParams.get('project'), PROJECT.projectId);
        const label = url.searchParams.get('label');
        if (label !== null) return { status: 200, body: { tasks: state.tasks.filter(task => task.labels.includes(label)), next: null } };
        const closedOnly = url.searchParams.get('status') === 'closed';
        return { status: 200, body: { tasks: state.tasks.filter(task => closedOnly ? task.status === 'closed' : true) } };
      }
      const one = /^\/api\/tasks\/([^/]+)$/u.exec(url.pathname);
      if (method === 'GET' && one) {
        const task = state.tasks.find(entry => entry.id === one[1]);
        return task ? { status: 200, body: { task } } : { status: 404, body: { error: 'not_found', detail: 'no task' } };
      }
      if (method === 'POST' && url.pathname === '/api/tasks') {
        assert.equal(body.projectId, PROJECT.projectId);
        if (state.keys.has(idempotencyKey)) return { status: 201, body: { id: state.keys.get(idempotencyKey) } };
        const id = `shop-${state.tasks.length + 1}`;
        state.keys.set(idempotencyKey, id);
        state.creates.push({ body, idempotencyKey, onBehalfOf });
        state.tasks.push({ id, title: body.title, status: 'open', labels: body.labels ?? [], metadata: body.metadata ?? {}, priority: 2, issueType: 'task' });
        return { status: 201, body: { id } };
      }
      const comment = /^\/api\/tasks\/([^/]+)\/comments$/u.exec(url.pathname);
      if (method === 'POST' && comment) {
        if (!state.keys.has(idempotencyKey)) state.comments.push({ taskId: comment[1], text: body.text, idempotencyKey, onBehalfOf });
        state.keys.set(idempotencyKey, comment[1]);
        return { status: 201, body: { comment: { id: 'c1' } } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { service, state };
}

function panelDeps(service) {
  const lines = [];
  return { lines, deps: { taskService: service, probe: never, run: never, readConfig: async () => SPOKES, readToken: async () => 'operator-token',
    get: async () => Response.json({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }] }),
    readPublished: async (asset) => ({ asset, sources: [{ key: 'dataforseo', integration: 'dataforseo', collected: true, newestReportDate: '2026-09-21', reports: [] }] }),
    readVersion: async () => VERSION, createReview: never,
    state: { skipping: null, unmapped: new Set(), waiting: new Set() }, emit: (level, text) => lines.push(`${level} ${text}`), stopped: () => false } };
}

test('a panel review is filed in Ntasks once per collection, under the filer\'s own name', async () => {
  const { service, state } = ntasks();
  const { deps } = panelDeps(service);
  assert.deepEqual((await runPanelReviewFiler(UP, deps)).filed, [{ asset: 'shop.example', panelDate: '2026-09-21', beadId: 'shop-1' }]);
  for (let poll = 0; poll < 2; poll += 1) assert.deepEqual((await runPanelReviewFiler(UP, deps)).filed, []);
  assert.equal(state.creates.length, 1);
  const [{ body, idempotencyKey, onBehalfOf }] = state.creates;
  assert.equal(onBehalfOf, PANEL_REVIEW_ACTOR);
  assert.match(idempotencyKey, /^panel-review:[0-9a-f]{64}$/u);
  assert.deepEqual(body.labels, ['panel-review']);
  assert.deepEqual(body.metadata, { noticeos_panel_asset: 'shop.example', noticeos_panel_date: '2026-09-21', noticeos_panel_version: VERSION });
  assert.match(body.title, /2026-09-21/u);
  assert.equal(body.dueAt, panelReviewDueDate('2026-09-21'));
  assert.match(body.dueAt, /^\d{4}-\d{2}-\d{2}$/u);

  // An invalidated review permits exactly one replacement, under another key.
  state.tasks[0].labels.push('invalid-automation');
  await runPanelReviewFiler(UP, deps);
  await runPanelReviewFiler(UP, deps);
  assert.equal(state.creates.length, 2);
  assert.notEqual(state.creates[1].idempotencyKey, idempotencyKey);
});

test('a panel day that gives no due date files the review without one', async () => {
  const bodies = [];
  const register = { create: async (_project, body) => { bodies.push(body); return 'shop-9'; } };
  assert.equal(await fileNtasksPanelReview(register, { prefix: 'shop' }, { asset: 'shop.example', panelDate: 'not-a-date', version: VERSION }), 'shop-9');
  assert.equal(Object.hasOwn(bodies[0], 'dueAt'), false);
});

test('a review closed long ago still counts as filed', async () => {
  const { service, state } = ntasks([{ id: 'shop-9', title: 'Triage the shop.example SERP panel (2026-09-21)', status: 'closed',
    labels: ['panel-review'], metadata: { noticeos_panel_date: '2026-09-21' }, closedAt: '2025-12-25T10:00:00.000Z' }]);
  assert.deepEqual((await runPanelReviewFiler(UP, panelDeps(service).deps)).filed, []);
  assert.equal(state.creates.length, 0);
});

const OPEN = { id: 'shop-1', title: 'Rewrite the pricing copy', status: 'open', labels: [], metadata: {} };
function readbackDeps(service, queue) {
  const requests = [], lines = [];
  return { requests, lines, deps: { taskService: service, run: never, createReview: never, readConfig: async () => SPOKES,
    config: { ingestHost: '127.0.0.1', ingestPort: 8858 }, readToken: async () => 'operator-token', now: () => Date.parse('2026-08-22T04:00:00.000Z'),
    fetchImpl: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, method: init.method ?? 'GET', body });
      if ((init.method ?? 'GET') === 'GET') return Response.json(queue);
      if (body?.linked) return Response.json({ linked: body.linked.map(entry => entry.windowId) });
      return Response.json({ reviewed: (body?.reviewed ?? []).map(entry => entry.flagNumber) });
    },
    emit: (level, text) => lines.push(`${level} ${text}`) } };
}

test('a verdict is commented in Ntasks once, as Outcome task updates, then stamped', async () => {
  const { service, state } = ntasks([OPEN]);
  const entry = { windowId: 'w1', asset: 'shop.example', bead: 'shop-1', outcome: 'won', comment: 'Verdict: won' };
  const lane = readbackDeps(service, { pending: [entry], reviews: [] });
  assert.deepEqual(await runWatchReadbackFiler(lane.deps), { posted: ['w1'], failed: [] });
  await runWatchReadbackFiler(lane.deps);
  assert.equal(state.comments.length, 1, 'the same window and task comment once');
  assert.deepEqual(state.comments.map(row => [row.taskId, row.text, row.onBehalfOf]), [['shop-1', 'Verdict: won', 'outcome-task-updates']]);
  assert.match(state.comments[0].idempotencyKey, /^readback:[0-9a-f]{64}$/u);
  assert.deepEqual(lane.requests.find(request => request.body?.posted)?.body, { posted: ['w1'], expectedTasks: { w1: 'shop-1' } });
});

test('a verdict for a closed task files an outcome review in Ntasks, linked to it, and comments there', async () => {
  const { service, state } = ntasks([{ ...OPEN, status: 'closed', closedAt: '2026-08-20T00:00:00.000Z' }]);
  const entry = { windowId: 'w2', asset: 'shop.example', bead: 'shop-1', outcome: 'inconclusive', comment: 'Verdict: inconclusive' };
  const lane = readbackDeps(service, { pending: [entry], reviews: [] });
  assert.deepEqual(await runWatchReadbackFiler(lane.deps), { posted: ['w2'], failed: [] });
  assert.equal(state.creates.length, 1);
  const [{ body, onBehalfOf, idempotencyKey }] = state.creates;
  assert.equal(onBehalfOf, 'outcome-review-filer');
  assert.match(idempotencyKey, /^outcome-review:[0-9a-f]{64}$/u);
  assert.deepEqual(body.labels, ['outcome-review']);
  assert.deepEqual(body.metadata, { noticeos_source: 'outcome-review', noticeos_asset: 'shop.example', noticeos_rule: 'watch-window-closed', noticeos_key: 'w2' });
  assert.deepEqual(state.links.map(link => [link.task, link.depends_on, link.type, link.actor]), [['shop-2', 'shop-1', 'related', 'outcome-review-filer']]);
  assert.deepEqual(state.comments.map(row => row.taskId), ['shop-2']);
  assert.ok(lane.requests.some(request => request.body?.linked?.[0]?.bead === 'shop-2'));
});

test('a review task Ntasks closed as done marks its outcome read, from the close Ntasks records', async () => {
  const review = { flagNumber: 12, windowId: 'w3', asset: 'shop.example', bead: 'shop-2', postedAt: '2026-08-21T04:00:00.000Z' };
  const { service } = ntasks([{ id: 'shop-2', title: 'Review', status: 'closed', labels: [], metadata: {}, closedAt: '2026-08-22T03:00:00.000Z',
    closedBy: 'service:noticeos/claude', closedModel: 'claude-opus-5-5', resolution: 'done', closeReason: 'Keep; evidence in abc1234' }]);
  const lane = readbackDeps(service, { pending: [], reviews: [review] });
  assert.deepEqual(await runWatchReadbackFiler(lane.deps), { posted: [], failed: [] });
  assert.deepEqual(lane.requests.find(request => request.body?.reviewed)?.body.reviewed,
    [{ ...review, closedAt: '2026-08-22T03:00:00.000Z', checkedAt: '2026-08-22T04:00:00.000Z', reason: 'Keep; evidence in abc1234' }]);
});

test('the task map check is retired while tasks live in Ntasks', async () => {
  const { service } = ntasks();
  const lines = [];
  assert.equal(await runTaskMapCheck({ taskService: service, readConfig: never, run: never, state: { skipping: null },
    emit: (_level, text) => lines.push(text), stopped: () => false }), null);
  assert.match(lines.at(-1), /tasks live in Ntasks, which keeps no task databases to check/u);
});

test('Ntasks\'s close and claim read under the NoticeOS keys', () => {
  assert.deepEqual(withNoticeosRecords({ id: 'ex-1', status: 'closed', metadata: { noticeos_card: { valuePerMonth: 1 } }, closedAt: '2026-11-06T10:00:00.000Z',
    closedBy: 'service:noticeos/claude', closedModel: 'claude-opus-5-5', resolution: 'duplicate', duplicateOf: 'ex-2', assigneeModel: 'claude-opus-5-5' }).metadata, {
    noticeos_card: { valuePerMonth: 1 }, noticeos_closed_by: 'service:noticeos/claude', noticeos_closed_at: '2026-11-06T10:00:00.000Z',
    noticeos_closed_model: 'claude-opus-5-5', noticeos_resolution: 'duplicate', noticeos_duplicate_of: 'ex-2', noticeos_claimed_model: 'claude-opus-5-5' });
  const imported = { id: 'ex-3', status: 'closed', metadata: {}, closedAt: '2026-01-01T00:00:00.000Z', closedBy: null, resolution: 'done' };
  assert.equal(withNoticeosRecords(imported), imported, 'a close imported without a closer gains no record');
});
