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

test('a verdict is commented on its bead, then stamped; an unmapped site is named', async () => {
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
