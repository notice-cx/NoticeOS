import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFreshOsAsset, main, prepareDatabase, writeInstallationDocuments } from './os-setup-container.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'postgresql://noticeos_owner:PRIVATE-OWNER-SENTINEL@postgres:5432/noticeos?sslmode=disable';

function temp(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-setup-container-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sink = () => { const io = { text: '', write: (chunk) => { io.text += chunk; } }; return io; };

test('the owner address arrives on stdin, each step runs in order, and only the new asset is printed', async () => {
  const order = [];
  const out = sink();
  const code = await main({ input: Readable.from([`${OWNER}\n`]), out, err: sink(),
    database: (url) => { order.push('database'); assert.equal(url, OWNER); },
    asset: async (address) => { order.push('asset'); assert.equal(address, 'postgresql://app'); return 'os-0123456789abcdef'; },
    documents: (asset) => { order.push(`documents ${asset}`); },
    bindings: () => ({ DATABASE_URL: 'postgresql://app' }) });
  assert.equal(code, 0);
  assert.deepEqual(order, ['database', 'asset', 'documents os-0123456789abcdef']);
  assert.equal(out.text, '{"asset":"os-0123456789abcdef"}\n');
});

test('a refusal says its own sentence; any other failure never repeats what it carried', async () => {
  const run = async (database) => {
    const err = sink();
    const code = await main({ input: Readable.from([OWNER]), out: sink(), err, database, bindings: () => ({}) });
    return { code, text: err.text };
  };
  const notEmpty = await run((url) => prepareDatabase(url, { root: ROOT, empty: () => false }));
  assert.deepEqual(notEmpty, { code: 1, text: 'setup refused: the database is not empty; setup applies nothing to an existing database.\n' });
  const leaked = await run(() => { throw new Error(`connection to ${OWNER} failed`); });
  assert.equal(leaked.code, 1);
  assert.doesNotMatch(leaked.text, /PRIVATE-OWNER-SENTINEL/u);
});

test('the installation\'s settings name the new asset, privately', (t) => {
  const base = temp(t);
  mkdirSync(path.join(base, 'config'));
  mkdirSync(path.join(base, 'installation'));
  writeFileSync(path.join(base, 'config', 'integrations.json'), JSON.stringify({ version: 1, assets: {} }));
  writeFileSync(path.join(base, 'config', 'signal-panels.json'), JSON.stringify({ version: 1, assets: {} }));
  writeInstallationDocuments('os-0123456789abcdef', { root: base, installation: path.join(base, 'installation') });
  const read = (name) => JSON.parse(readFileSync(path.join(base, 'installation', name), 'utf8'));
  assert.deepEqual(read('integrations.json'), { version: 1, assets: { 'os-0123456789abcdef': {} } });
  assert.equal(read('signal-panels.json').assets['os-0123456789abcdef'].enabled, false);
  assert.equal(statSync(path.join(base, 'installation', 'integrations.json')).mode & 0o777, 0o600);
  assert.throws(() => writeInstallationDocuments('os-0123456789abcdef', { root: base, installation: path.join(base, 'installation') }), /EEXIST/u);
});

test('the System asset is workspace scoped, the only asset, and refused when any asset exists', async () => {
  const calls = [];
  const store = () => ({ onlyWorkspace: async () => 'own-workspace', close: async () => calls.push('close'),
    inWorkspace: async (workspace, work) => work({ query: async () => [], execute: async (sql, values) => calls.push({ workspace, sql, values }) }) });
  assert.equal(await createFreshOsAsset('synthetic', { store, id: 'os-0123456789abcdef' }), 'os-0123456789abcdef');
  assert.equal(calls[0].workspace, 'own-workspace');
  assert.deepEqual(calls[0].values, ['own-workspace', 'os-0123456789abcdef']);
  assert.equal(calls.at(-1), 'close');
  let wrote = false;
  await assert.rejects(createFreshOsAsset('synthetic', { store: () => ({ onlyWorkspace: async () => 'own', close: async () => {},
    inWorkspace: async (_, work) => work({ query: async () => [{ asset_id: 'kept' }], execute: async () => { wrote = true; } }) }) }));
  assert.equal(wrote, false);
});

test('the System asset takes the first list position and leaves the next one for a site', { timeout: 60_000 }, async t => {
  let cluster;
  try { cluster = await startTestCluster(); }
  catch (error) { const reason = unavailableReason(error); if (reason === null || postgresRequired()) throw error; return t.skip(reason); }
  t.after(() => cluster.close());
  const database = await cluster.createDatabase();
  const address = cluster.url(database);
  const osAsset = await createFreshOsAsset(address);
  const db = openStore(address, { maxConnections: 1 });
  try {
    const workspace = await db.onlyWorkspace();
    await db.inWorkspace(workspace, async tx => {
      const initial = await tx.query('SELECT asset_id, is_os, domain, display_name, list_position FROM noticeos.assets ORDER BY list_position');
      assert.deepEqual(initial, [{ asset_id: osAsset, is_os: true, domain: null, display_name: 'System', list_position: 1n }]);
      await tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status) VALUES ($1, 'fixture-site', 'example.com', 'Fixture', 'live')", [workspace]);
      const positions = await tx.query('SELECT is_os, list_position FROM noticeos.assets ORDER BY list_position');
      assert.deepEqual(positions, [{ is_os: true, list_position: 1n }, { is_os: false, list_position: 2n }]);
    });
    await assert.rejects(createFreshOsAsset(address));
  } finally { await db.close(); }
});
