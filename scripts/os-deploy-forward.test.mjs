// The OS's own deploys reach the store as annotations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_DEPLOY_SOURCE, OS_DEPLOY_NOTES, osDeployAnnotation, osDeployOutcome } from './os-deploy-events.mjs';
import {
  createDeployForwardState,
  deployLogSource,
  forwardOsDeploys,
  forwardOsDeploysToStore,
} from './os-deploy-forward.mjs';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const FAILED = 'a'.repeat(40);
const PREVIOUS = 'b'.repeat(40);
const SLOT = '/Users/someone/home/.local/runtime/b';

/** What `record()` writes for a deploy whose restart failed and went back by itself. */
const LOG = [
  { at: '2026-09-23T10:00:00.000Z', action: 'deploy', from: PREVIOUS, to: FAILED, slot: SLOT, result: 'prepared' },
  { at: '2026-09-23T10:01:00.000Z', action: 'deploy', from: PREVIOUS, to: FAILED, slot: SLOT, result: 'failed' },
  { at: '2026-09-23T10:02:30.000Z', action: 'rollback', automatic: true, from: FAILED, to: PREVIOUS, slot: SLOT, result: 'healthy' },
  { at: '2026-09-23T11:00:00.000Z', action: 'deploy', from: PREVIOUS, to: 'c'.repeat(40), slot: SLOT, result: 'healthy' },
];

/** A file read that returns the log as the host holds it, plus one torn line. */
const fsp = { readFile: async () => `${LOG.map((row) => JSON.stringify(row)).join('\n')}\n{"at": "2026-09-23T11:3\n` };

/** The ingest's annotation route, as its writer behaves: idempotent on
 * (asset, at, kind, ref), 201 when filed and 200 when already there. */
function store() {
  const rows = new Map();
  const posts = [];
  const post = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ url, body, auth: init.headers.authorization });
    const key = `${body.asset}|${body.at}|${body.kind}|${body.ref}`;
    const created = !rows.has(key);
    if (created) rows.set(key, body);
    return { ok: true, status: created ? 201 : 200 };
  };
  return { rows, posts, post };
}

const base = (s, state) => ({
  source: deployLogSource('/unused', fsp),
  osAsset: 'os.example.com',
  url: 'http://door.test/api/annotations',
  readToken: async () => 'operator-token',
  post: s.post,
  state,
  nowMs: NOW,
});

test('a deploy and an automatic rollback each become one annotation with the recorded time and commit', async () => {
  const s = store();
  const result = await forwardOsDeploys(base(s, createDeployForwardState()));
  assert.deepEqual(result, { sent: 3, pending: 0 });
  assert.deepEqual([...s.rows.values()], [
    { asset: 'os.example.com', at: '2026-09-23T10:01:00.000Z', kind: 'deploy', ref: FAILED, note: OS_DEPLOY_NOTES.failed },
    { asset: 'os.example.com', at: '2026-09-23T10:02:30.000Z', kind: 'deploy', ref: PREVIOUS, note: OS_DEPLOY_NOTES['rolled-back'] },
    { asset: 'os.example.com', at: '2026-09-23T11:00:00.000Z', kind: 'deploy', ref: 'c'.repeat(40), note: OS_DEPLOY_NOTES.deployed },
  ]);
  assert.equal(s.posts[0].url, 'http://door.test/api/annotations');
  assert.equal(s.posts[0].auth, 'Bearer operator-token');
});

test('a replay does not duplicate them', async () => {
  const s = store();
  const state = createDeployForwardState();
  await forwardOsDeploys(base(s, state));
  // The same runner a minute later: nothing new, nothing sent.
  assert.deepEqual(await forwardOsDeploys(base(s, state)), { sent: 0, pending: 0 });
  assert.equal(s.posts.length, 3);
  // A restarted runner re-sends; the store keeps one row each.
  await forwardOsDeploys(base(s, createDeployForwardState()));
  assert.equal(s.posts.length, 6);
  assert.equal(s.rows.size, 3);
});

test('no secret or local path reaches the annotation', async () => {
  const s = store();
  await forwardOsDeploys(base(s, createDeployForwardState()));
  for (const { body } of s.posts) {
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /\/|runtime|token|Users/);
    assert.deepEqual(Object.keys(body).sort(), ['asset', 'at', 'kind', 'note', 'ref']);
  }
});

test('a store that is down, or no token, leaves every deploy for the next pass', async () => {
  const state = createDeployForwardState();
  const down = { post: async () => { throw new Error('connect ECONNREFUSED'); } };
  assert.deepEqual(await forwardOsDeploys(base(down, state)), { sent: 0, pending: 3 });
  assert.equal(await forwardOsDeploys({ ...base(store(), state), readToken: async () => null }), null);
  const s = store();
  assert.deepEqual(await forwardOsDeploys(base(s, state)), { sent: 3, pending: 0 });
});

// The runner asks the STORE which asset is the OS
// (`GET /api/os-asset`, `assets.is_os`) and files the deploys against that id —
// an installation whose OS asset is called something else still gets them.
test('the runner files deploys against whichever asset the store names as the OS', async () => {
  const s = store();
  const door = (osAsset) => async (url, init) => {
    if (url.endsWith('/api/os-asset')) {
      assert.equal(init.headers.authorization, 'Bearer operator-token');
      return { ok: true, status: 200, json: async () => ({ asset: osAsset }) };
    }
    return s.post(url, init);
  };
  const pass = (osAsset) =>
    forwardOsDeploysToStore({
      source: deployLogSource('/unused', fsp),
      config: { ingestHost: '127.0.0.1', ingestPort: 8791 },
      readToken: async () => 'operator-token',
      request: door(osAsset),
      state: createDeployForwardState(),
      nowMs: NOW,
    });

  assert.deepEqual(await pass('home-os.example'), { sent: 3, pending: 0 });
  assert.deepEqual([...new Set([...s.rows.values()].map((row) => row.asset))], ['home-os.example']);
  assert.equal(s.posts[0].url, 'http://127.0.0.1:8791/api/annotations');

  // A store that names no OS asset gets nothing filed, not a guessed id.
  assert.equal(await pass(null), null);
  assert.equal(s.posts.length, 3);
});

test('only the window is forwarded, and an install with no deploy log forwards nothing', async () => {
  const s = store();
  const later = { ...base(s, createDeployForwardState()), nowMs: NOW + 8 * 86_400_000 };
  assert.deepEqual(await forwardOsDeploys(later), { sent: 0, pending: 0 });
  assert.deepEqual(await forwardOsDeploys({ ...base(s, createDeployForwardState()), source: NO_DEPLOY_SOURCE }), { sent: 0, pending: 0 });
  const missing = deployLogSource('/nope', { readFile: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.deepEqual(await missing.read(), []);
  assert.equal(s.posts.length, 0);
});

test('the note is how the feed tells the three apart, and nothing else reads as a deploy', () => {
  for (const [outcome, note] of Object.entries(OS_DEPLOY_NOTES)) assert.equal(osDeployOutcome(note), outcome);
  assert.equal(osDeployOutcome('Shipped the new menu'), null);
  assert.equal(osDeployOutcome(null), null);
  assert.equal(osDeployAnnotation({ ...LOG[3], to: '../../etc' }, 'os.example.com'), null);
  assert.equal(osDeployAnnotation(LOG[0], 'os.example.com'), null);
  assert.equal(osDeployAnnotation(LOG[3], ''), null);
});

test('a deploy the store refuses as unprocessable is not re-sent, while a server error is', async () => {
  const state = createDeployForwardState();
  const posts = [];
  const refusing = (status) => async (url, init) => {
    posts.push(JSON.parse(init.body).at);
    return { ok: false, status };
  };
  assert.deepEqual(await forwardOsDeploys(base({ post: refusing(500) }, state)), { sent: 0, pending: 3 });
  assert.deepEqual(await forwardOsDeploys(base({ post: refusing(422) }, state)), { sent: 0, pending: 0 });
  assert.equal(posts.length, 6);
  assert.deepEqual(await forwardOsDeploys(base({ post: refusing(422) }, state)), { sent: 0, pending: 0 });
  assert.equal(posts.length, 6);
});
