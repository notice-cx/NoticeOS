import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RESOURCE_NAMES_FILE } from './installation.mjs';
import { renderLaunchAgent } from './os-control.mjs';
import { openedRawSignalsBucket } from './os-deploy.mjs';
import { stripJsonc } from './jsonc.mjs';
import { NEW_INSTALL_NAMES, applyResourceNames, readResourceNames, serviceLabel } from './resource-names.mjs';
import { workerConfig } from './start.mjs';

// A new installation is born with NoticeOS names.
//
// What `pnpm start` sets up for a stranger — its Workers, database and bucket —
// what `pnpm os:install` installs on a Mac that has no service yet, the names
// the Postgres profile will create, and the product defaults a fresh clone
// seeds all carry the product's name and none of the old one. The owner's
// installation keeps the names its live resources were made under
// (docs/06-operations.md § Legacy names); this proves a new one never
// inherits them.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = /reindex/i;
const WORKER_CONFIGS = ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc'];

test('every name NoticeOS gives a new resource says NoticeOS, and no two are the same', () => {
  const names = Object.values(NEW_INSTALL_NAMES);
  for (const name of names) {
    assert.doesNotMatch(name, OLD, name);
    assert.match(name, /notice/i, name);
  }
  assert.equal(new Set(names).size, names.length);
});

test("pnpm start's Workers, database and bucket are born with NoticeOS names", () => {
  for (const file of WORKER_CONFIGS) {
    const source = path.join(REPO_ROOT, file);
    const generated = workerConfig(readFileSync(source, 'utf8'), source);
    // The header names the checkout's config as its source path; the config
    // itself is what wrangler reads.
    const config = JSON.parse(generated.slice(generated.indexOf('\n') + 1));
    // Paths point into the checkout, wherever it was cloned; the names are what count.
    const named = JSON.stringify(config).replaceAll(REPO_ROOT, '<checkout>');
    assert.doesNotMatch(named, OLD, `${file} generated for a new installation`);
    assert.match(config.name, /^noticeos-(?:tower|ingest)$/u);
    assert.equal(config.d1_databases, undefined);
    assert.ok(config.hyperdrive.some(database => database.binding === 'POSTGRES'));
    for (const bucket of config.r2_buckets ?? []) assert.equal(bucket.bucket_name, NEW_INSTALL_NAMES.rawSignalsBucket);
    for (const service of config.services ?? []) assert.equal(service.service, NEW_INSTALL_NAMES.ingestWorker);
  }
});

// What a stranger deploys: the checked-in Worker configs
// carry no old name at all. An older store's names live in its own folder.
test('the Worker configs a stranger deploys name the NoticeOS Workers, database and bucket, and nothing old', () => {
  for (const file of WORKER_CONFIGS) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.doesNotMatch(text, OLD, file);
    const config = JSON.parse(stripJsonc(text));
    assert.ok([NEW_INSTALL_NAMES.towerWorker, NEW_INSTALL_NAMES.ingestWorker].includes(config.name), file);
    assert.equal(config.d1_databases, undefined);
    assert.ok(config.hyperdrive.some(database => database.binding === 'POSTGRES'));
    for (const bucket of config.r2_buckets ?? []) assert.equal(bucket.bucket_name, NEW_INSTALL_NAMES.rawSignalsBucket, file);
  }
});

// ─── An installation made under the old names (the owner's shape) ───────────

const OWNER_NAMES = Object.freeze({ database: 'reindex-os-central', rawSignalsBucket: 'reindex-os-raw-signals' });
const ingestText = () => readFileSync(path.join(REPO_ROOT, 'workers', 'ingest', 'wrangler.jsonc'), 'utf8');

function installationWith(t, text) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'resource-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'installation'));
  if (text !== null) writeFileSync(path.join(root, 'installation', RESOURCE_NAMES_FILE), text);
  return root;
}

test('an installation made under the old names keeps its archives; historical database metadata has no effect', (t) => {
  const root = installationWith(t, `${JSON.stringify(OWNER_NAMES, null, 2)}\n`);
  const names = readResourceNames({ root, env: {} });
  assert.deepEqual(names, OWNER_NAMES);

  for (const file of WORKER_CONFIGS) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const config = JSON.parse(stripJsonc(text));
    const patched = JSON.parse(stripJsonc(text));
    applyResourceNames(patched, names);
    for (const bucket of patched.r2_buckets ?? []) assert.equal(bucket.bucket_name, OWNER_NAMES.rawSignalsBucket, file);
    // Nothing else moves.
    const { r2_buckets: _r, ...rest } = patched;
    const { r2_buckets: _cr, ...original } = config;
    assert.deepEqual(rest, original, file);
  }
  // The deploy check asks for the same bucket.
  assert.equal(openedRawSignalsBucket(ingestText(), names), OWNER_NAMES.rawSignalsBucket);

});

test('a new installation has no names file and runs on the checked-in names', (t) => {
  const root = installationWith(t, null);
  const names = readResourceNames({ root, env: {} });
  assert.deepEqual(names, {});
  const config = JSON.parse(stripJsonc(ingestText()));
  applyResourceNames(config, names);
  assert.deepEqual(config, JSON.parse(stripJsonc(ingestText())), 'nothing changes');
  assert.equal(openedRawSignalsBucket(ingestText(), names), NEW_INSTALL_NAMES.rawSignalsBucket);
});

test('a names file that cannot be read stops the Tower rather than opening an empty bucket', (t) => {
  for (const [text, problem] of [
    ['{ "rawSignalsBucket": ', /not valid JSON/u],
    ['["reindex-os-raw-signals"]', /must be an object/u],
    ['{ "bucket": "reindex-os-raw-signals" }', /names bucket; only database and rawSignalsBucket/u],
    ['{ "rawSignalsBucket": "Not A Bucket" }', /rawSignalsBucket must be a resource name/u],
  ]) {
    const root = installationWith(t, text);
    assert.throws(() => readResourceNames({ root, env: {} }), problem, text);
  }
});

test('a Mac with no service installed gets the NoticeOS label; one installed before the rename keeps its own', () => {
  assert.equal(serviceLabel(false), 'com.noticeos.local');
  assert.equal(serviceLabel(true), 'com.reindexos.local');
  const template = readFileSync(path.join(REPO_ROOT, 'scripts', 'launchd', 'local-service.plist'), 'utf8');
  const fresh = renderLaunchAgent(template, {
    label: serviceLabel(false),
    nodePath: '/opt/homebrew/bin/node',
    nodeBinDir: '/opt/homebrew/bin',
    runtimeRoot: '/Users/someone/noticeos/.local/runtime/current',
    homeRoot: '/Users/someone/noticeos',
  });
  assert.match(fresh, /<key>Label<\/key>\s*<string>com\.noticeos\.local<\/string>/u);
  assert.doesNotMatch(fresh, OLD);
});

test('the Postgres database and role a new installation creates are named for NoticeOS', () => {
  assert.equal(NEW_INSTALL_NAMES.postgresDatabase, 'noticeos');
  assert.equal(NEW_INSTALL_NAMES.postgresRole, 'noticeos_app');
});

test("a fresh clone's product defaults carry no old name", () => {
  const defaults = readdirSync(path.join(REPO_ROOT, 'config')).filter((name) => name.endsWith('.json'));
  assert.ok(defaults.length >= 10, `only ${defaults.length} default documents found`);
  for (const name of defaults) {
    assert.doesNotMatch(readFileSync(path.join(REPO_ROOT, 'config', name), 'utf8'), OLD, `config/${name}`);
  }
});
