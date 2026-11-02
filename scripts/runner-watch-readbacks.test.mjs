import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileOutcomeReview, runWatchReadbackFiler, watchReadbacksUrl } from './runner/watch-readbacks.mjs';
import { openStandaloneTasks } from './standalone-mcp.mjs';
import { standaloneProjectId } from './standalone-tasks.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

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
    run: async (argv) => {
      ran.push(argv);
      return argv[2] === 'show' ? { code: 0, stdout: JSON.stringify([{ id: argv[3], status: 'open' }]), stderr: '' }
        : { code: bdCode, stdout: '', stderr: bdCode ? 'no such issue' : '' };
    },
    readConfig: async () => PROJECTS,
    emit: (level, text) => lines.push(`${level} ${text}`),
    repoRoot: '/host',
  };
  return { deps, requests, ran, lines };
}

test('a verdict is commented on its bead, then stamped; an unmapped asset is named', async () => {
  const { deps, requests, ran } = lane();
  const result = await runWatchReadbackFiler(deps);
  assert.deepEqual(ran, [['-C', '/shop', 'show', 'shop-1', '--json'], ['-C', '/shop', 'comment', 'shop-1', 'Verdict: won']]);
  assert.deepEqual(result.posted, ['w1']);
  assert.deepEqual(result.failed, ['blog-1: no beads spoke is configured for blog.example']);
  assert.deepEqual(requests.map((request) => [request.url, request.method]), [
    [watchReadbacksUrl(deps.config), 'GET'],
    [watchReadbacksUrl(deps.config), 'POST'],
  ]);
  assert.deepEqual(requests[1].body, { posted: ['w1'], expectedTasks: { w1: 'shop-1' } });
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
  fixture.deps.createReview = async () => { throw new Error('Review creation not available in this fixture'); };
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

function closedImplementationLane({ alreadyPosted = false, failFirstLink = false, reviewRequired = true } = {}) {
  const f = lane();
  const original = { id: 'shop-1', status: 'closed', closed_at: '2026-08-20T04:00:00.000Z',
    close_reason: 'Implementation shipped in abc1234', metadata: { implementation: 'abc1234' } };
  const tasks = new Map([['shop-1', structuredClone(original)]]);
  const receipts = new Map();
  const comments = [];
  let created = 0, closed = 0, linkedTask = 'shop-1', postedAt = alreadyPosted ? REVIEW.postedAt : null, acknowledged = !reviewRequired;
  const entry = () => ({ ...PENDING[0], bead: linkedTask, reviewRequired, outcome: 'inconclusive', closedAt: '2026-08-21T03:30:00.000Z' });
  const filing = {
    readBindings: async () => ({ bindings: {} }),
    open: async () => ({ workspaceId: 'fixture-workspace', close: async () => { closed++; }, operations: {
      async write(_proof, _workspace, request, key) {
        if (receipts.has(key)) {
          assert.deepEqual(request, receipts.get(key).request);
          return { status: 'done', value: { id: 'shop-review' } };
        }
        const operation = request.operation;
        assert.equal(operation.kind, 'create');
        assert.deepEqual(operation.links, [{ type: 'related', taskId: 'shop-1' }]);
        tasks.set('shop-review', { id: 'shop-review', status: 'open', ...operation });
        receipts.set(key, { request }); created++;
        return { status: 'done', value: { id: 'shop-review' } };
      },
    } }),
  };
  f.deps.createReview = (project, pending) => fileOutcomeReview(project, pending, filing);
  f.deps.now = () => Date.parse(CHECKED);
  f.deps.run = async argv => {
    f.ran.push(argv);
    const task = tasks.get(argv[3]);
    if (!task) return { code: 1, stdout: '', stderr: 'missing task' };
    if (argv[2] === 'show') return { code: 0, stdout: JSON.stringify([task]), stderr: '' };
    assert.equal(argv[2], 'comment'); comments.push({ task: argv[3], text: argv[4] });
    return { code: 0, stdout: '', stderr: '' };
  };
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
      assert.equal(link.previousBead, linkedTask); assert.equal(link.previousPostedAt, postedAt);
      linkedTask = link.bead; postedAt = null;
      return Response.json({ linked: ['w1'], skipped: [] });
    }
    if (body.posted) {
      assert.equal(body.expectedTasks.w1, linkedTask);
      postedAt = REVIEW.postedAt;
      return Response.json({ posted: ['w1'], skipped: [] });
    }
    assert.equal(body.reviewed[0].bead, 'shop-review');
    acknowledged = true;
    return Response.json({ reviewed: [12], skipped: [] });
  };
  return { ...f, original, tasks, comments, receipts, entry, filing,
    state: () => ({ created, closed, linkedTask, postedAt, acknowledged }) };
}

for (const alreadyPosted of [false, true]) {
  test(`a pre-closed implementation produces open review work (${alreadyPosted ? 'earlier delivery' : 'new delivery'})`, async () => {
    const f = closedImplementationLane({ alreadyPosted });
    assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 0);
    assert.equal(f.tasks.get('shop-review').status, 'open');
    assert.deepEqual(f.tasks.get('shop-review').labels, ['outcome-review']);
    assert.match(f.tasks.get('shop-review').description, /Outcome window w1; related task shop-1/);
    assert.deepEqual(f.tasks.get('shop-1'), f.original);
    assert.equal(f.state().acknowledged, false);
    if (alreadyPosted) {
      assert.equal(f.state().postedAt, null);
      await runWatchReadbackFiler(f.deps);
    }
    assert.deepEqual(f.comments.map(row => row.task), ['shop-review']);
    assert.equal(f.state().created, 1);
    // An open review remains actionable; original implementation completion is insufficient.
    await runWatchReadbackFiler(f.deps);
    assert.equal(f.state().acknowledged, false);
    Object.assign(f.tasks.get('shop-review'), { status: 'closed', closed_at: CLOSED,
      close_reason: 'Keep; measured result reviewed in abc1234', metadata: CLOSE_RECORD });
    await runWatchReadbackFiler(f.deps);
    assert.equal(f.state().acknowledged, true);
    assert.deepEqual(f.tasks.get('shop-1'), f.original);
  });
}

test('a link failure retries the same durable review without creating duplicate work', async () => {
  const f = closedImplementationLane({ failFirstLink: true });
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 1);
  assert.equal(f.state().postedAt, null);
  assert.equal(f.comments.length, 0);
  assert.equal((await runWatchReadbackFiler(f.deps)).failed.length, 0);
  assert.equal(f.state().created, 1);
  assert.equal(f.state().closed, 2);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.tasks.size, 2);
});

test('manual acknowledgement remains terminal and does not create another review obligation', async () => {
  const f = closedImplementationLane({ reviewRequired: false });
  await runWatchReadbackFiler(f.deps);
  assert.equal(f.state().created, 0);
  assert.equal(f.tasks.size, 1);
  assert.equal(f.state().acknowledged, true);
  assert.deepEqual(f.tasks.get('shop-1'), f.original);
});

test('the shared task workflow recovers a lost create across concurrent review filing', async () => {
  const project = { asset: 'shop.example', prefix: 'shop', database: 'shop' };
  const projects = async () => [{ ...project, projectId: standaloneProjectId('shop'), cwd: '/fixture' }];
  const rows = [], commands = [], receipts = memoryReceipts(Date.now);
  let creates = 0, closes = 0, loseResponse = true;
  const store = { onlyWorkspace: async () => '5f42e967-bb21-4e9b-9c69-8b082e8491a6', close: async () => { closes++; },
    inWorkspace: async (_workspace, work) => work({ query: async sql => sql.includes('pg_try_advisory') ? [{ acquired: true }] : [] }) };
  const run = async (argv, cwd) => {
    assert.equal(cwd, '/fixture'); commands.push(argv);
    if (argv.includes('--id=shop-1') || argv.includes('show') && argv.includes('shop-1')) return { code: 0, stdout: JSON.stringify([
      { id: 'shop-1', status: 'closed', issue_type: 'task', close_reason: 'Implementation abc1234' },
    ]) };
    if (argv.includes('--status=closed')) return { code: 0, stdout: '[]' };
    const flag = name => argv.find(word => word.startsWith(name + '='))?.slice(name.length + 1);
    if (argv.includes('create')) {
      creates++;
      assert.equal(flag('--deps'), 'related:shop-1');
      rows.push({ id: 'shop-review', title: flag('--title'), status: 'open', issue_type: 'task',
        labels: ['outcome-review'], metadata: JSON.parse(flag('--metadata')), created_at: CHECKED });
      if (loseResponse) { loseResponse = false; return { code: 1, stdout: '' }; }
    }
    return { code: 0, stdout: JSON.stringify(argv.includes('create') ? rows.at(-1) : rows) };
  };
  const deps = { readBindings: async () => ({ bindings: { DATABASE_URL: 'synthetic-bootstrap-address' } }),
    open: async options => {
      assert.equal(options.databaseUrl, 'synthetic-bootstrap-address');
      return openStandaloneTasks({ store, projects, receipts, run });
    } };
  await Promise.allSettled([fileOutcomeReview(project, PENDING[0], deps), fileOutcomeReview(project, PENDING[0], deps)]);
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(await fileOutcomeReview(project, PENDING[0], deps), 'shop-review');
  assert.equal(creates, 1); assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].metadata.noticeos_key, 'w1');
  assert.equal(closes, 5);
  assert.ok(commands.some(argv => argv.includes('list') && argv.includes('--limit=0')));
});
