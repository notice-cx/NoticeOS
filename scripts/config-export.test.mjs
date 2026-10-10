// `pnpm config:export` — the direction that puts the store back into the files.
//
// This command is what keeps docs/06's promise after config moved into the
// store: anything that can change a verdict is still visible in a diff. So the
// property that matters most is BYTE EQUALITY — an export of an unchanged store
// must leave the checkout untouched, or every export would look like a change
// and the diff would stop being evidence of anything.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { serializeDocument } from './config-documents.mjs';
import { exportReport, parseArgs, planExport, runExport } from './config-export.mjs';

async function tempRepo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-export-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.mkdir(path.join(root, 'installation'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await fs.writeFile(path.join(root, rel), text, 'utf8');
  }
  return root;
}

function storeAnswering(body) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

test('a path no register names is refused', () => {
  assert.throws(() => parseArgs(['--file', 'config/secrets.json']), /is not a config document/);
  assert.equal(parseArgs(['--check']).check, true);
});

test('an unchanged store leaves the file byte-identical', async () => {
  const doc = { countdown: { label: 'Launch', target: '2026-10-01' } };
  const root = await tempRepo({ 'installation/tower.json': serializeDocument(doc) });
  const before = await fs.readFile(path.join(root, 'installation/tower.json'), 'utf8');

  const { plan } = await runExport({
    files: ['config/tower.json'],
    repoRoot: root,
    token: 'test-token',
    fetchImpl: storeAnswering({
      ready: true,
      documents: [{ file: 'config/tower.json', version: 3, body: doc }],
    }),
  });
  assert.deepEqual(
    plan.map((row) => row.action),
    ['same'],
  );
  assert.equal(await fs.readFile(path.join(root, 'installation/tower.json'), 'utf8'), before);
});

test('a moved setting is written back in the bytes a Save would leave', async () => {
  const root = await tempRepo({
    'installation/tower.json': serializeDocument({ countdown: { label: 'Launch' } }),
  });
  const stored = { countdown: { label: 'Ship' } };
  await runExport({
    files: ['config/tower.json'],
    repoRoot: root,
    token: 'test-token',
    fetchImpl: storeAnswering({
      ready: true,
      documents: [{ file: 'config/tower.json', version: 4, body: stored }],
    }),
  });
  assert.equal(
    await fs.readFile(path.join(root, 'installation/tower.json'), 'utf8'),
    serializeDocument(stored),
  );
});

test('a document the store does not hold leaves its file alone', async () => {
  const root = await tempRepo({
    'installation/tower.json': serializeDocument({ countdown: { label: 'Launch' } }),
  });
  const { plan } = await runExport({
    files: ['config/tower.json'],
    repoRoot: root,
    token: 'test-token',
    fetchImpl: storeAnswering({ ready: true, documents: [] }),
  });
  assert.deepEqual(
    plan.map((row) => row.action),
    ['unseeded'],
  );
  assert.match(exportReport(plan).join('\n'), /the file is the source/);
});

test('--check writes nothing and says which files are behind', async () => {
  const root = await tempRepo({
    'installation/tower.json': serializeDocument({ countdown: { label: 'Launch' } }),
  });
  const before = await fs.readFile(path.join(root, 'installation/tower.json'), 'utf8');
  const { plan } = await runExport({
    files: ['config/tower.json'],
    repoRoot: root,
    check: true,
    token: 'test-token',
    fetchImpl: storeAnswering({
      ready: true,
      documents: [{ file: 'config/tower.json', version: 4, body: { countdown: { label: 'Ship' } } }],
    }),
  });
  assert.equal(await fs.readFile(path.join(root, 'installation/tower.json'), 'utf8'), before);
  assert.match(exportReport(plan, { check: true }).join('\n'), /differs from the store/);
});

test('with no table it says so and exports nothing', async () => {
  const root = await tempRepo({});
  const result = await runExport({
    files: ['config/tower.json'],
    repoRoot: root,
    token: 'test-token',
    fetchImpl: storeAnswering({
      ready: false,
      reason: 'the store has no config_documents table yet — apply migration 0029',
    }),
  });
  assert.equal(result.ready, false);
  assert.match(result.reason, /migration 0029/);
});

test('planExport reads the file once per document and never writes', async () => {
  const root = await tempRepo({});
  const plan = await planExport(
    { ready: true, documents: [{ file: 'config/tower.json', version: 1, body: { a: 1 } }] },
    ['config/tower.json'],
    { repoRoot: root },
  );
  // The file is absent, so an export would create it — a checkout that lost a
  // config file gets it back rather than a refusal.
  assert.equal(plan[0].action, 'written');
  await assert.rejects(() => fs.readFile(path.join(root, 'installation/tower.json'), 'utf8'));
});

// The export is this installation's own. A product default in
// config/ that happens to equal the store is not an export, and is never
// rewritten with one installation's settings.
test('an export writes the installation folder and never the product default', async () => {
  const stored = { countdown: { label: 'Ship' } };
  const root = await tempRepo({ 'config/tower.json': serializeDocument({}) });
  const { plan } = await runExport({
    files: ['config/tower.json'],
    repoRoot: root,
    token: 'test-token',
    fetchImpl: storeAnswering({
      ready: true,
      documents: [{ file: 'config/tower.json', version: 2, body: stored }],
    }),
  });
  assert.deepEqual(plan.map((row) => [row.action, row.path]), [['written', 'installation/tower.json']]);
  assert.equal(await fs.readFile(path.join(root, 'installation/tower.json'), 'utf8'), serializeDocument(stored));
  assert.equal(await fs.readFile(path.join(root, 'config/tower.json'), 'utf8'), serializeDocument({}));
  assert.match(exportReport(plan).join('\n'), /installation\/tower\.json/);
});
