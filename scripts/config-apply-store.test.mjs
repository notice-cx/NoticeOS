import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { REMOTE_REFUSED, applyChangeset, prepareChangeset, parseArgs } from './config-apply.mjs';
import { readConfigSnapshot } from './config-store-client.mjs';

const FILE = 'config/tower.json';
// The installation's own export of it (scripts/installation.mts).
const EXPORTED = 'installation/tower.json';
const cs = (expect = 'Stored launch') => ({ version: 1, slug: 'countdown-label', createdAt: '2026-09-09T12:00:00Z', ops: [
  { kind: 'file-json-set', file: FILE, pointer: '/countdown/label', expect, value: 'New launch' },
] });
const document = (label) => ({ countdown: { label, target: '2026-10-01' } });
async function fixture(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'config-store-apply-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(repoRoot, 'installation'));
  await fs.writeFile(path.join(repoRoot, EXPORTED), JSON.stringify(document('Stale export')));
  const row = { file: FILE, version: 4, body: document('Stored launch') };
  const calls = [];
  let responseOverride = null;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (responseOverride) return responseOverride(url, init);
    if (init.method === 'GET') return Response.json({ ready: true, documents: [structuredClone(row)] });
    assert.equal(new URL(url).pathname, '/api/config-documents/apply');
    const input = JSON.parse(init.body);
    assert.equal(input.actor, 'config:apply');
    if (input.expectVersions[FILE] !== row.version) return Response.json({ ok: false, error: 'version_mismatch' }, { status: 409 });
    assert.equal(input.ops[0].expect, row.body.countdown.label);
    row.body.countdown.label = input.ops[0].value;
    row.version++;
    return Response.json({ ok: true, applied: input.ops.length, documents: [structuredClone(row)] });
  };
  return { repoRoot, row, calls, options: { repoRoot, token: 'synthetic-test-only', door: 'http://door.test', fetchImpl },
    response: (handler) => { responseOverride = handler; },
    file: () => fs.readFile(path.join(repoRoot, EXPORTED), 'utf8'),
  };
}

test('terminal document preview reads the stored value, then saves and exports the acknowledged result', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareChangeset(cs(), null, f.options);
  assert.equal(prepared.mode, 'database');
  assert.equal(prepared.resolved[0].current, 'Stored launch');
  assert.deepEqual(prepared.versions, { [FILE]: 4 });
  assert.deepEqual(prepared.mismatches, []);
  // Preparation is the dry-run path: no writes to files or the database.
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, 'GET');
  assert.deepEqual(JSON.parse(await f.file()), document('Stale export'));
  const applied = await applyChangeset(cs(), prepared, null, f.options);
  assert.deepEqual(applied, { changedFiles: [EXPORTED], exported: true });
  assert.deepEqual((await readConfigSnapshot(f.options)).get(FILE).body, document('New launch'));
  assert.deepEqual(JSON.parse(await f.file()), document('New launch'));
});

test('stale expectations use database reality, not a matching old export', async (t) => {
  const f = await fixture(t);
  const change = cs('Stale export');
  const prepared = await prepareChangeset(change, null, f.options);
  assert.equal(prepared.mismatches.length, 1);
  await assert.rejects(applyChangeset(change, prepared, null, f.options), /preview has conflicts/);
  assert.equal(f.calls.length, 1);
});

test('a concurrent version change refuses the save and leaves the export untouched', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareChangeset(cs(), null, f.options);
  f.row.version++;
  await assert.rejects(applyChangeset(cs(), prepared, null, f.options), /version_mismatch/);
  assert.deepEqual(JSON.parse(await f.file()), document('Stale export'));
});

test('an acknowledged save remains saved when exporting fails', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareChangeset(cs(), null, f.options);
  // A file where the installation folder belongs: the export cannot land.
  await fs.rm(path.join(f.repoRoot, 'installation'), { recursive: true });
  await fs.writeFile(path.join(f.repoRoot, 'installation'), 'not a folder');
  assert.deepEqual(await applyChangeset(cs(), prepared, null, f.options), { changedFiles: [], exported: false });
  assert.equal(f.row.body.countdown.label, 'New launch');
});

test('missing, unavailable and malformed snapshots never fall back to exported files', async (t) => {
  const f = await fixture(t);
  for (const payload of [
    { ready: false, documents: [] }, { ready: true }, { ready: true, documents: [] },
    { ready: true, documents: [f.row, f.row] },
    { ready: true, documents: [{ ...f.row, body: null }] },
  ]) {
    f.response(() => Response.json(payload));
    await assert.rejects(prepareChangeset(cs('Stale export'), null, f.options));
    assert.deepEqual(JSON.parse(await f.file()), document('Stale export'));
  }
  f.response(() => { throw new Error('offline'); });
  await assert.rejects(prepareChangeset(cs(), null, f.options), /did not answer/);
  assert.ok(f.calls.every((call) => call.init.method === 'GET'));
});

test('ambiguous saves and incomplete export evidence never modify files', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareChangeset(cs(), null, f.options);
  for (const reply of [
    () => Response.json({ ok: false }),
    () => Response.json({ ok: true }, { status: 503 }),
    () => Response.json({ ok: true, applied: 1, documents: [] }),
    () => Response.json({ ok: true, applied: 1, documents: [{ ...f.row, file: '../outside.json' }] }),
    () => { throw new Error('connection lost after write'); },
  ]) {
    f.response(reply);
    await assert.rejects(applyChangeset(cs(), prepared, null, f.options), /unknown|incomplete/);
    assert.deepEqual(JSON.parse(await f.file()), document('Stale export'));
  }
});

test('offline seed edits require an explicit mode and never call the database', async (t) => {
  const f = await fixture(t);
  assert.equal(parseArgs(['--seed-files']).seedFiles, true);
  const options = { ...f.options, seedFiles: true };
  const change = cs('Stale export');
  const prepared = await prepareChangeset(change, null, options);
  assert.equal(prepared.mode, 'seed-files');
  await applyChangeset(change, prepared, null, options);
  assert.deepEqual(JSON.parse(await f.file()), document('New launch'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.row.body.countdown.label, 'Stored launch');
});

test('mixed or remote targets refuse before contacting either destination', async (t) => {
  const f = await fixture(t);
  const asset = { kind: 'store-asset-set', asset: 'example.test', column: 'display_name', expect: 'Old', value: 'New' };
  // A deployed installation saves its settings and its sites in its own Tower:
  // --remote refuses documents and asset columns alike.
  for (const options of [{ remote: true }, { seedFiles: true, remote: true }]) {
    await assert.rejects(prepareChangeset(cs(), null, { ...f.options, ...options }), new RegExp(REMOTE_REFUSED.slice(0, 20)));
    await assert.rejects(prepareChangeset({ ...cs(), ops: [asset] }, null, { ...f.options, ...options }), /Nothing applied/);
  }
  await assert.rejects(prepareChangeset({ ...cs(), ops: [...cs().ops, asset] }, null, f.options), /separately/);
  await assert.rejects(prepareChangeset({ ...cs(), ops: [asset] }, null, { ...f.options, seedFiles: true }), /seed-files/);
  assert.equal(f.calls.length, 0);
});

test('asset-only changes retain their dedicated store lane', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const store = { column: async () => 'Old', set: async (...args) => { calls.push(args); } };
  const change = { ...cs(), ops: [{ kind: 'store-asset-set', asset: 'example.test', column: 'display_name', expect: 'Old', value: 'New' }] };
  const prepared = await prepareChangeset(change, store, f.options);
  assert.equal(prepared.mode, 'assets');
  await applyChangeset(change, prepared, store, f.options);
  assert.deepEqual(calls, [['example.test', 'display_name', 'New']]);
  assert.equal(f.calls.length, 0);
});
