import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runWatchReadbackFiler, watchReadbacksUrl } from './runner/watch-readbacks.mjs';

// scripts/runner/watch-readbacks.mjs: a closed bet's
// verdict is posted to its bead, and only then stamped in the store. The door
// and `bd` are recorded here; nothing reaches a real store or tracker.

const PROJECTS = JSON.stringify({ spokes: [{ asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' }] });
const PENDING = [
  { windowId: 'w1', asset: 'shop.example', bead: 'shop-1', outcome: 'won', comment: 'Verdict: won' },
  { windowId: 'w2', asset: 'blog.example', bead: 'blog-1', outcome: 'lost', comment: 'Verdict: lost' },
];

function lane({ bdCode = 0 } = {}) {
  const requests = [];
  const ran = [];
  const lines = [];
  const deps = {
    config: { ingestHost: '127.0.0.1', ingestPort: 8858 },
    readToken: async () => 'example-bearer',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ pending: PENDING }), { status: 200 });
    },
    run: async (argv) => (ran.push(argv), { code: bdCode, stdout: '', stderr: bdCode ? 'no such issue' : '' }),
    readConfig: async () => PROJECTS,
    emit: (level, text) => lines.push(`${level} ${text}`),
    repoRoot: '/host',
  };
  return { deps, requests, ran, lines };
}

test('a verdict is commented on its bead, then stamped; an unmapped asset is named', async () => {
  const { deps, requests, ran } = lane();
  const result = await runWatchReadbackFiler(deps);
  assert.deepEqual(ran, [['-C', '/shop', 'comment', 'shop-1', 'Verdict: won']]);
  assert.deepEqual(result.posted, ['w1']);
  assert.deepEqual(result.failed, ['blog-1: no beads spoke is configured for blog.example']);
  assert.deepEqual(requests.map((request) => [request.url, request.method]), [
    [watchReadbacksUrl(deps.config), 'GET'],
    [watchReadbacksUrl(deps.config), 'POST'],
  ]);
  assert.deepEqual(requests[1].body, { posted: ['w1'] });
});

test('a failed comment is never stamped as delivered', async () => {
  const { deps, requests } = lane({ bdCode: 1 });
  const result = await runWatchReadbackFiler(deps);
  assert.deepEqual(result.posted, []);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
});

test('no bearer, no reads', async () => {
  const { deps, requests, lines } = lane();
  const result = await runWatchReadbackFiler({ ...deps, readToken: async () => null });
  assert.deepEqual(result, { posted: [], failed: [] });
  assert.deepEqual(requests, []);
  assert.match(lines[0], /no operator token/u);
});

const REVIEW = { flagNumber: 12, windowId: 'w3', asset: 'shop.example', bead: 'shop-2', postedAt: '2026-08-21T04:00:00.000Z' };
const CHECKED = '2026-08-22T04:00:00.000Z';
const CLOSED = '2026-08-22T03:00:00.000Z';
const CLOSE_RECORD = { noticeos_closed_by: 'reviewer', noticeos_closed_at: CLOSED, noticeos_resolution: 'done' };

function reviewLane(task, { code = 0, queue = [REVIEW] } = {}) {
  const fixture = lane();
  fixture.deps.now = () => Date.parse(CHECKED);
  fixture.deps.fetchImpl = async (url, init = {}) => {
    fixture.requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    return Response.json(init.method === 'POST' ? { reviewed: [12], skipped: [] } : { pending: [], reviews: queue });
  };
  fixture.deps.run = async (argv) => {
    fixture.ran.push(argv);
    return { code, stdout: JSON.stringify([task ? { metadata: CLOSE_RECORD, ...task } : null]), stderr: code ? 'unavailable' : '' };
  };
  return fixture;
}

test('a fresh completed readback task acknowledges exactly its associated outcome', async () => {
  const f = reviewLane({ id: 'shop-2', status: 'closed', closed_at: CLOSED, close_reason: 'Keep; evidence in abc1234' });
  assert.deepEqual(await runWatchReadbackFiler(f.deps), { posted: [], failed: [] });
  assert.deepEqual(f.ran, [['-C', '/shop', 'show', 'shop-2', '--json']]);
  assert.deepEqual(f.requests[1].body, { reviewed: [{ ...REVIEW, closedAt: CLOSED, checkedAt: CHECKED, reason: 'Keep; evidence in abc1234' }] });
  assert.match(f.lines.at(-1), /1 alert\(s\) marked read from completed tasks/);
});

test('a failed acknowledgement is reported and retried from the unchanged queue', async () => {
  const f = reviewLane({ id: 'shop-2', status: 'closed', closed_at: CLOSED, close_reason: 'Keep' });
  const fetchImpl = f.deps.fetchImpl;
  f.deps.fetchImpl = (url, init) => init?.method === 'POST' ? Promise.resolve(new Response(null, { status: 503 })) : fetchImpl(url, init);
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 1);
  assert.equal(f.lines.some(line => /marked read/.test(line)), false);
  f.deps.fetchImpl = fetchImpl;
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 0);
  assert.match(f.lines.at(-1), /marked read/);
});

for (const [name, task] of [
  ['an earlier implementation closure', { id: 'shop-2', status: 'closed', closed_at: '2026-08-20T04:00:00Z', close_reason: 'Implementation done' }],
  ['an open task', { id: 'shop-2', status: 'open', closed_at: CLOSED, close_reason: 'Old close' }],
  ['an absent task', null],
  ['a different task', { id: 'shop-3', status: 'closed', closed_at: CLOSED, close_reason: 'Done' }],
  ['a close without a reason', { id: 'shop-2', status: 'closed', closed_at: CLOSED }],
  ['an unreadable close', { id: 'shop-2', status: 'closed', closed_at: 'invalid', close_reason: 'Done' }],
  ['a future close', { id: 'shop-2', status: 'closed', closed_at: '2026-08-23T04:00:00Z', close_reason: 'Done' }],
  ['a close missing its completion record', { id: 'shop-2', status: 'closed', closed_at: CLOSED, close_reason: 'Done', metadata: null }],
  ['an older completion record', { id: 'shop-2', status: 'closed', closed_at: CLOSED, close_reason: 'Done', metadata: {
    ...CLOSE_RECORD, noticeos_closed_at: '2026-08-20T04:00:00Z' } }],
  ['a duplicate retirement', { id: 'shop-2', status: 'closed', closed_at: CLOSED, close_reason: 'Duplicate', metadata: {
    ...CLOSE_RECORD, noticeos_resolution: 'duplicate', noticeos_duplicate_of: 'shop-3' } }],
]) {
  test(`${name} does not acknowledge an outcome`, async () => {
    const f = reviewLane(task);
    await runWatchReadbackFiler(f.deps);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  });
}

test('failed or malformed task reads never acknowledge an outcome', async () => {
  for (const code of [1, 0]) {
    const f = reviewLane(null, { code });
    if (code === 0) f.deps.run = async () => ({ code: 0, stdout: '{invalid', stderr: '' });
    const result = await runWatchReadbackFiler(f.deps);
    assert.equal(result.failed.length, 1);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  }
});

test('an unfinished earlier page does not hide later completed reviews', async () => {
  const f = reviewLane({ id: 'shop-2', status: 'closed', closed_at: CLOSED, close_reason: 'Keep' });
  f.deps.fetchImpl = async (url, init = {}) => {
    f.requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') return Response.json({ reviewed: [12] });
    return Response.json(url.includes('reviewsAfter=11') ? { pending: [], reviews: [REVIEW], nextReviewAfter: null }
      : { pending: [], reviews: [{ ...REVIEW, flagNumber: 11, bead: 'shop-1' }], nextReviewAfter: 11 });
  };
  await runWatchReadbackFiler(f.deps);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(f.requests.at(-1).body.reviewed[0].flagNumber, 12);
});
