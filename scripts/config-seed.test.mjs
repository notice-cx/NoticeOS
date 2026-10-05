// `pnpm config:seed` — the direction that puts the checkout into the store.
//
// The rule this file exists to keep: a seed NEVER overwrites. The checkout can
// be months behind the store (every Save in the Tower lands there), so a seed
// that silently won would undo the operator's settings from a file. Everything
// below is that rule, plus the refusals that stop a forced one from happening by
// accident.
//
// The store half is pinned against real D1 in workers/ingest/test/config-store.
// What is asserted here is the CLIENT: what it sends, what it reports, and what
// it refuses before it sends anything.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CONFIG_DOCUMENT_FILES } from './config-documents.mjs';
import {
  SEED_ACTOR,
  parseArgs,
  readSeedDocuments,
  runSeed,
  seedReport,
} from './config-seed.mjs';

/** A throwaway checkout holding just the config files a case needs. */
async function tempRepo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-seed-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  for (const [rel, doc] of Object.entries(files)) {
    await fs.writeFile(path.join(root, rel), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }
  return root;
}

/** A door that records what it was asked and answers what the case wants. */
function fakeDoor(answer) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body === undefined ? null : JSON.parse(init.body) });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

test('with no arguments it seeds every document the OS knows', () => {
  const opts = parseArgs([]);
  assert.deepEqual(opts.files, []);
  assert.ok(CONFIG_DOCUMENT_FILES.length > 0);
});

test('--force without --reason is refused before anything is read', () => {
  assert.throws(
    () => parseArgs(['--force', 'config/tower.json']),
    /--force needs --reason/,
  );
  const forced = parseArgs(['--force', 'config/tower.json', '--reason', 'restored from backup']);
  assert.deepEqual(forced.force, ['config/tower.json']);
  assert.deepEqual(forced.files, ['config/tower.json']);
});

test('a path no register names is refused, naming what the OS does know', () => {
  assert.throws(
    () => parseArgs(['--file', 'config/secrets.json']),
    /is not a config document/,
  );
});

test('a file the checkout does not carry is left out rather than sent as null', async () => {
  const root = await tempRepo({ 'config/tower.json': { countdown: {} } });
  const { documents, absent } = await readSeedDocuments(
    ['config/tower.json', 'config/counters.json'],
    { repoRoot: root },
  );
  assert.deepEqual(Object.keys(documents), ['config/tower.json']);
  assert.deepEqual(absent, ['config/counters.json']);
});

test('it sends the documents under its own actor, and reports what landed', async () => {
  const root = await tempRepo({ 'config/tower.json': { countdown: { label: 'Launch' } } });
  const door = fakeDoor({
    body: { ok: true, seeded: [{ file: 'config/tower.json', version: 1 }], skipped: [], refused: [] },
  });
  const { body } = await runSeed({
    files: ['config/tower.json'],
    repoRoot: root,
    token: 'test-token',
    fetchImpl: door.fetchImpl,
  });
  assert.equal(door.calls[0].body.actor, SEED_ACTOR);
  assert.deepEqual(door.calls[0].body.documents['config/tower.json'], { countdown: { label: 'Launch' } });
  assert.match(seedReport(body).join('\n'), /config\/tower\.json/);
  assert.match(seedReport(body).join('\n'), /version 1/);
});

test('a document already in the store is reported as left alone, not as an error', async () => {
  const report = seedReport({
    ok: true,
    seeded: [],
    skipped: [{ file: 'config/tower.json', version: 4 }],
    refused: [],
  }).join('\n');
  assert.match(report, /already seeded at version 4/);
  assert.match(report, /left alone/);
});

test('with no table the report names the refusal rather than claiming a seed', () => {
  const report = seedReport({
    error: 'store_unavailable',
    detail: 'the store has no config_documents table yet — apply migration 0029',
  }).join('\n');
  assert.match(report, /nothing was seeded/);
  assert.match(report, /migration 0029/);
});

test('a run with nothing to send never opens the door', async () => {
  const root = await tempRepo({});
  const door = fakeDoor({ body: { ok: true, seeded: [], skipped: [], refused: [] } });
  await runSeed({
    files: ['config/tower.json'],
    repoRoot: root,
    token: 'test-token',
    fetchImpl: door.fetchImpl,
  });
  assert.equal(door.calls.length, 0);
});
