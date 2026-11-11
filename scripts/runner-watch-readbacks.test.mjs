import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runWatchReadbackFiler } from './runner/watch-readbacks.mjs';

// scripts/runner/watch-readbacks.mjs: a closed bet's verdict is commented on
// its task in Ntasks, and only then stamped in the store. The door and Ntasks
// are scripted here; nothing reaches a real store or tracker.

const PROJECTS = JSON.stringify({ spokes: [{ asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' }] });
const PENDING = [
  { windowId: 'w1', asset: 'shop.example', taskId: 'shop-1', outcome: 'won', comment: 'Verdict: won' },
  { windowId: 'w2', asset: 'blog.example', taskId: 'blog-1', outcome: 'lost', comment: 'Verdict: lost' },
];

/**
 * An Ntasks holding the shop project's `tasks` by id, as the lane's register
 * reads, comments, files and links them. `state.read(id)` answers a task read
 * instead, as `{ status, body }`.
 */
function ntasks(tasks = []) {
  const state = { tasks: new Map(tasks.map((task) => [task.id, structuredClone(task)])), comments: [], creates: [], keys: new Map(), links: [], read: null };
  const service = {
    backend: async () => 'ntasks',
    projects: async () => [{ projectId: 'p-shop', logicalKey: 'shop.example', displayName: 'Shop', prefix: 'shop' }],
    async tool(name, args) {
      assert.equal(name, 'link_tasks');
      state.links.push([args.task, args.to, args.type]);
      return {};
    },
    async call({ method, path, body, idempotencyKey }) {
      const url = new URL(path, 'https://ntasks.example.com');
      const one = /^\/api\/tasks\/([^/]+)$/u.exec(url.pathname);
      if (method === 'GET' && one) {
        const id = decodeURIComponent(one[1]);
        if (state.read) return state.read(id);
        return state.tasks.has(id) ? { status: 200, body: { task: state.tasks.get(id) } } : { status: 404, body: { detail: 'no task' } };
      }
      const comment = /^\/api\/tasks\/([^/]+)\/comments$/u.exec(url.pathname);
      if (method === 'POST' && comment) {
        if (!state.keys.has(idempotencyKey)) state.comments.push({ task: decodeURIComponent(comment[1]), text: body.text });
        state.keys.set(idempotencyKey, true);
        return { status: 201, body: {} };
      }
      if (method === 'POST' && url.pathname === '/api/tasks') {
        if (state.keys.has(idempotencyKey)) return { status: 201, body: { id: state.keys.get(idempotencyKey) } };
        const id = `shop-review-${state.creates.length + 1}`;
        state.keys.set(idempotencyKey, id);
        state.creates.push(body);
        state.tasks.set(id, { id, status: 'open', title: body.title, labels: body.labels, metadata: body.metadata, description: body.description });
        return { status: 201, body: { id } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { service, state };
}

function lane(tasks = [{ id: 'shop-1', status: 'open', labels: [], metadata: {} }]) {
  const requests = [];
  const lines = [];
  const { service, state } = ntasks(tasks);
  const deps = {
    taskService: service,
    config: { ingestHost: '127.0.0.1', ingestPort: 8858 },
    readToken: async () => 'example-bearer',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ pending: PENDING }), { status: 200 });
    },
    readConfig: async () => PROJECTS,
    emit: (level, text) => lines.push(`${level} ${text}`),
  };
  return { deps, requests, ntasks: state, lines };
}

test('no bearer, no reads', async () => {
  const { deps, requests, lines } = lane();
  const result = await runWatchReadbackFiler({ ...deps, readToken: async () => null });
  assert.deepEqual(result, { posted: [], failed: [] });
  assert.deepEqual(requests, []);
  assert.match(lines[0], /no operator token/u);
});

const REVIEW = { flagNumber: 12, windowId: 'w3', asset: 'shop.example', taskId: 'shop-2', postedAt: '2026-08-21T04:00:00.000Z' };
const CHECKED = '2026-08-22T04:00:00.000Z';
const CLOSED = '2026-08-22T03:00:00.000Z';
const CLOSE_RECORD = { noticeos_closed_by: 'reviewer', noticeos_closed_at: CLOSED, noticeos_resolution: 'done' };

/** The lane with only `queue` owed and the review task as Ntasks answers it:
 * `task` is the row, null when Ntasks has no such task. */
function reviewLane(task, { queue = [REVIEW] } = {}) {
  const fixture = lane(task ? [{ labels: [], metadata: CLOSE_RECORD, ...task }] : []);
  fixture.deps.now = () => Date.parse(CHECKED);
  fixture.deps.fetchImpl = async (url, init = {}) => {
    fixture.requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    return Response.json(init.method === 'POST' ? { reviewed: [12], skipped: [] } : { pending: [], reviews: queue });
  };
  return fixture;
}

test('a fresh completed readback task acknowledges exactly its associated outcome', async () => {
  const f = reviewLane({ id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Keep; evidence in abc1234' });
  assert.deepEqual(await runWatchReadbackFiler(f.deps), { posted: [], failed: [] });
  assert.deepEqual(f.requests[1].body, { reviewed: [{ ...REVIEW, closedAt: CLOSED, checkedAt: CHECKED, reason: 'Keep; evidence in abc1234' }] });
  assert.match(f.lines.at(-1), /1 alert\(s\) marked read from completed tasks/);
});

test('a failed acknowledgement is reported and retried from the unchanged queue', async () => {
  const f = reviewLane({ id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Keep' });
  const fetchImpl = f.deps.fetchImpl;
  f.deps.fetchImpl = (url, init) => init?.method === 'POST' ? Promise.resolve(new Response(null, { status: 503 })) : fetchImpl(url, init);
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 1);
  assert.equal(f.lines.some(line => /marked read/.test(line)), false);
  f.deps.fetchImpl = fetchImpl;
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 0);
  assert.match(f.lines.at(-1), /marked read/);
});

for (const [name, task] of [
  ['an earlier implementation closure', { id: 'shop-2', status: 'closed', closedAt: '2026-08-20T04:00:00Z', closeReason: 'Implementation done' }],
  ['an open task', { id: 'shop-2', status: 'open', closedAt: CLOSED, closeReason: 'Old close' }],
  ['a close without a reason', { id: 'shop-2', status: 'closed', closedAt: CLOSED }],
  ['an unreadable close', { id: 'shop-2', status: 'closed', closedAt: 'invalid', closeReason: 'Done' }],
  ['a future close', { id: 'shop-2', status: 'closed', closedAt: '2026-08-23T04:00:00Z', closeReason: 'Done' }],
  ['a close missing its completion record', { id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Done', metadata: null }],
  ['an older completion record', { id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Done', metadata: {
    ...CLOSE_RECORD, noticeos_closed_at: '2026-08-20T04:00:00Z' } }],
  ['a duplicate retirement', { id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Duplicate', metadata: {
    ...CLOSE_RECORD, noticeos_resolution: 'duplicate', noticeos_duplicate_of: 'shop-3' } }],
]) {
  test(`${name} does not acknowledge an outcome`, async () => {
    const f = reviewLane(task);
    await runWatchReadbackFiler(f.deps);
    assert.equal(f.requests.filter(r => r.body?.reviewed).length, 0);
  });
}

test('an absent, unread or different task never acknowledges an outcome', async () => {
  const absent = reviewLane(null);
  assert.equal((await runWatchReadbackFiler(absent.deps)).failed.length, 1);
  const unread = reviewLane({ id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Done' });
  unread.ntasks.read = () => ({ status: 503, body: { detail: 'unavailable' } });
  assert.equal((await runWatchReadbackFiler(unread.deps)).failed.length, 1);
  const other = reviewLane({ id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Done' });
  other.ntasks.read = () => ({ status: 200, body: { task: { id: 'shop-3', status: 'closed', closedAt: CLOSED, closeReason: 'Done', metadata: CLOSE_RECORD } } });
  assert.equal((await runWatchReadbackFiler(other.deps)).failed.length, 1);
  for (const f of [absent, unread, other]) assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('an unfinished earlier page does not hide later completed reviews', async () => {
  const f = reviewLane({ id: 'shop-2', status: 'closed', closedAt: CLOSED, closeReason: 'Keep' });
  f.ntasks.tasks.set('shop-1', { id: 'shop-1', status: 'open', labels: [], metadata: {} });
  f.deps.fetchImpl = async (url, init = {}) => {
    f.requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') return Response.json({ reviewed: [12] });
    return Response.json(url.includes('reviewsAfter=11') ? { pending: [], reviews: [REVIEW], nextReviewAfter: null }
      : { pending: [], reviews: [{ ...REVIEW, flagNumber: 11, taskId: 'shop-1' }], nextReviewAfter: 11 });
  };
  await runWatchReadbackFiler(f.deps);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(f.requests.at(-1).body.reviewed[0].flagNumber, 12);
});

function closedImplementationLane({ alreadyPosted = false, failFirstLink = false, reviewRequired = true } = {}) {
  const original = { id: 'shop-1', status: 'closed', closedAt: '2026-08-20T04:00:00.000Z',
    closeReason: 'Implementation shipped in abc1234', labels: [], metadata: { implementation: 'abc1234' } };
  const f = lane([original]);
  let linkedTask = 'shop-1', postedAt = alreadyPosted ? REVIEW.postedAt : null, acknowledged = !reviewRequired;
  const entry = () => ({ ...PENDING[0], taskId: linkedTask, reviewRequired, outcome: 'inconclusive', closedAt: '2026-08-21T03:30:00.000Z' });
  f.deps.now = () => Date.parse(CHECKED);
  f.deps.fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    f.requests.push({ url, method: init.method ?? 'GET', body });
    if (init.method !== 'POST') return Response.json({
      pending: postedAt === null ? [entry()] : [],
      reviews: postedAt !== null && !acknowledged ? [{ ...entry(), flagNumber: 12, postedAt }] : [],
    });
    if (body.linked) {
      if (failFirstLink) { failFirstLink = false; return new Response(null, { status: 503 }); }
      const link = body.linked[0];
      assert.equal(link.previousTaskId, linkedTask); assert.equal(link.previousPostedAt, postedAt);
      linkedTask = link.taskId; postedAt = null;
      return Response.json({ linked: ['w1'], skipped: [] });
    }
    if (body.posted) {
      assert.equal(body.expectedTasks.w1, linkedTask);
      postedAt = REVIEW.postedAt;
      return Response.json({ posted: ['w1'], skipped: [] });
    }
    assert.equal(body.reviewed[0].taskId, 'shop-review-1');
    acknowledged = true;
    return Response.json({ reviewed: [12], skipped: [] });
  };
  return { ...f, original, state: () => ({ linkedTask, postedAt, acknowledged }) };
}

for (const alreadyPosted of [false, true]) {
  test(`a pre-closed implementation produces open review work (${alreadyPosted ? 'earlier delivery' : 'new delivery'})`, async () => {
    const f = closedImplementationLane({ alreadyPosted });
    assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 0);
    const review = f.ntasks.tasks.get('shop-review-1');
    assert.equal(review.status, 'open');
    assert.deepEqual(review.labels, ['outcome-review']);
    assert.match(review.description, /Outcome window w1; related task shop-1/);
    assert.deepEqual(f.ntasks.links, [['shop-review-1', 'shop-1', 'related']]);
    assert.deepEqual(f.ntasks.tasks.get('shop-1'), f.original);
    assert.equal(f.state().acknowledged, false);
    if (alreadyPosted) {
      assert.equal(f.state().postedAt, null);
      await runWatchReadbackFiler(f.deps);
    }
    assert.deepEqual(f.ntasks.comments.map(row => row.task), ['shop-review-1']);
    assert.equal(f.ntasks.creates.length, 1);
    // An open review remains actionable; original implementation completion is insufficient.
    await runWatchReadbackFiler(f.deps);
    assert.equal(f.state().acknowledged, false);
    Object.assign(review, { status: 'closed', closedAt: CLOSED, closeReason: 'Keep; measured result reviewed in abc1234', metadata: CLOSE_RECORD });
    await runWatchReadbackFiler(f.deps);
    assert.equal(f.state().acknowledged, true);
    assert.deepEqual(f.ntasks.tasks.get('shop-1'), f.original);
  });
}

test('a link failure retries the same review without creating duplicate work', async () => {
  const f = closedImplementationLane({ failFirstLink: true });
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 1);
  assert.equal(f.state().postedAt, null);
  assert.equal(f.ntasks.comments.length, 0);
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 0);
  assert.equal(f.ntasks.creates.length, 1);
  assert.equal(f.ntasks.tasks.size, 2);
});

test('manual acknowledgement remains terminal and does not create another review obligation', async () => {
  const f = closedImplementationLane({ reviewRequired: false });
  await runWatchReadbackFiler(f.deps);
  assert.equal(f.ntasks.creates.length, 0);
  assert.equal(f.ntasks.tasks.size, 1);
  assert.equal(f.state().acknowledged, true);
  assert.deepEqual(f.ntasks.tasks.get('shop-1'), f.original);
});
