import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_DOOR } from './ingest-door.mjs';
import { REMOTE_REFUSED, parseArgs, publishExecutiveSnapshot } from './signal-insights-publish.mjs';

const SNAPSHOT = {
  schemaVersion: 1,
  asset: 'meals.example',
  generatedAt: '2026-07-29T12:00:00.000Z',
  windowStart: '2026-07-25',
  windowEnd: '2026-07-28',
  sourceArchiveCount: 17,
  items: [],
  methodology: ['Missing rows remain unknown.'],
};

async function scratch(snapshot = SNAPSHOT) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-insight-publish-'));
  const file = path.join(dir, 'executive.json');
  await fs.writeFile(file, JSON.stringify(snapshot));
  return { dir, file };
}

/** The store's answer, as the ingest route gives it. */
function stubDoor({ created = true, status = created ? 201 : 200 } = {}) {
  const calls = [];
  const post = async (url, init) => {
    calls.push({ url, init });
    const contentSha256 = createHash('sha256').update(init.body).digest('hex');
    return {
      ok: true,
      status,
      json: async () => ({
        created,
        duplicate: !created,
        id: `insight:meals.example:${contentSha256.slice(0, 24)}`,
        asset: 'meals.example',
        contentSha256,
        generatedAt: JSON.parse(init.body).generatedAt,
      }),
    };
  };
  return { post, calls };
}

test('parseArgs: local by default, aimed at the loopback door', () => {
  const options = parseArgs(['--asset', 'meals.example']);
  assert.equal(options.door, DEFAULT_DOOR);
  assert.match(options.file, /reports\/meals\.example\/executive\.json$/);
});

test('parseArgs: rejects a malformed asset', () => {
  assert.throws(() => parseArgs(['--asset', 'NOT VALID']), /property id/);
});

test('publishes the reviewed snapshot through the operator-authed door', async () => {
  const { dir, file } = await scratch();
  const { post, calls } = stubDoor();

  const result = await publishExecutiveSnapshot({
    asset: 'meals.example',
    file,
    door: 'http://door.test',
    post,
    token: 'op',
  });

  assert.equal(result.itemCount, 0);
  assert.equal(result.created, true);
  assert.match(result.id, /^insight:meals\.example:[a-f0-9]{24}$/);

  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'http://door.test/api/insight-snapshot');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer op');
  assert.equal(init.headers['content-type'], 'application/json');
  // The body IS the row: the store content-addresses these exact bytes, so the
  // id the operator is told matches the file they reviewed.
  assert.deepEqual(JSON.parse(init.body), SNAPSHOT);
  assert.equal(
    result.contentSha256,
    createHash('sha256').update(init.body).digest('hex'),
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('a re-publish of an unchanged file reports that nothing changed', async () => {
  const { dir, file } = await scratch();
  const { post } = stubDoor({ created: false });
  const result = await publishExecutiveSnapshot({
    asset: 'meals.example',
    file,
    door: 'http://door.test',
    post,
    token: 'op',
  });
  assert.equal(result.created, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a rejected write fails loudly and carries the store’s reason', async () => {
  const { dir, file } = await scratch();
  const post = async () => ({
    ok: false,
    status: 422,
    text: async () => '{"error":"unknown_asset","detail":"meals.example"}',
  });
  await assert.rejects(
    publishExecutiveSnapshot({ asset: 'meals.example', file, post, token: 'op' }),
    /HTTP 422.*unknown_asset/s,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('a door that does not answer names os:up', async () => {
  const { dir, file } = await scratch();
  const post = async () => {
    throw new Error('fetch failed');
  };
  await assert.rejects(
    publishExecutiveSnapshot({ asset: 'meals.example', file, post, token: 'op' }),
    /os:up/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// The file is checked here, before anything leaves the machine, so the operator
// hears about the file they named rather than a 422 about a payload they never
// saw.
test('a malformed or foreign snapshot never reaches the store', async () => {
  for (const broken of [
    { ...SNAPSHOT, schemaVersion: 2 },
    { ...SNAPSHOT, asset: 'nosh.example' },
    { ...SNAPSHOT, sourceArchiveCount: -1 },
    { ...SNAPSHOT, items: 'none' },
    { ...SNAPSHOT, methodology: undefined },
    { ...SNAPSHOT, methodology: [17] },
    { ...SNAPSHOT, generatedAt: 'not a date' },
  ]) {
    const { dir, file } = await scratch(broken);
    await assert.rejects(
      publishExecutiveSnapshot({
        asset: 'meals.example',
        file,
        post: () => {
          throw new Error('nothing should have been sent');
        },
        token: 'op',
      }),
      /malformed, unsupported, or belongs to another property/,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('publishes the exact in-memory analysis without opening a shared output file', async () => {
  const { post, calls } = stubDoor();
  const result = await publishExecutiveSnapshot({ asset: SNAPSHOT.asset, snapshot: SNAPSHOT, post, token: 'op' });
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), SNAPSHOT);
  await assert.rejects(publishExecutiveSnapshot({ asset: SNAPSHOT.asset, snapshot: SNAPSHOT, file: '/must-not-read', post, token: 'op' }), /not both/);
  assert.equal(calls.length, 1);
});

test('does not claim publication from an empty or mismatched success acknowledgement', async () => {
  for (const replace of [
    () => ({}),
    (body) => ({ ...body, id: 'another-snapshot' }),
    (body) => ({ ...body, asset: 'nosh.example' }),
    (body) => ({ ...body, contentSha256: '0'.repeat(64) }),
    (body) => ({ ...body, created: undefined }),
    (body) => ({ ...body, generatedAt: '2026-01-01T00:00:00.000Z' }),
  ]) {
    const { post } = stubDoor();
    await assert.rejects(publishExecutiveSnapshot({
      asset: SNAPSHOT.asset, snapshot: SNAPSHOT, token: 'op',
      post: async (...args) => {
        const response = await post(...args);
        return { ...response, json: async () => replace(await response.json()) };
      },
    }), /Publication was not confirmed/);
  }
});

// The snapshots are in the installation's own store,
// reached only through its ingest: --remote writes nothing and says so.
test('--remote is refused before anything is published', () => {
  assert.throws(() => parseArgs(['--asset', 'meals.example', '--remote']), (error) => error.message === REMOTE_REFUSED);
});
