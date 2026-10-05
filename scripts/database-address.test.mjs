// The database address (bead ro-ujb9.76.7.2): DATABASE_URL, the fourth
// bootstrap secret, read from the secrets file, checked as the application
// login, and handed to the dev server's environment as the POSTGRES binding's
// local address — or one sentence that stops the start and never repeats any
// part of the address. The migration record is read one way, by the start's
// check and by `pnpm os:deploy` (bead ro-ujb9.76.7.1).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DATABASE_URL,
  LOCAL_CONNECTION_VARIABLE,
  POSTGRES_BINDING,
  bindsPostgres,
  checkDatabase,
  codeMigrationVersions,
  databaseEnv,
  readDatabaseAddress,
  readRecordedMigrations,
  recordedMigrations,
  towerDatabase,
} from './database-address.mjs';
import { LOCAL_CONNECTION_VARIABLE as TESTS_VARIABLE } from './postgres-test-copies.mjs';
import { postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';

const WHERE = 'home/workers/ingest/.dev.secrets.json';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every part of an address, each recognizable, so a sentence that repeats any
 * of them is caught. */
const PARTS = {
  user: 'plantedlogin',
  password: 'planted-password-4Qm7',
  host: 'planted-host.example.com',
  port: '6543',
  database: 'planteddatabase',
};
const PLANTED = `postgresql://${PARTS.user}:${PARTS.password}@${PARTS.host}:${PARTS.port}/${PARTS.database}?sslmode=disable`;

function assertNothingRepeated(line) {
  assert.equal(line.split('\n').length, 1, `one line: ${line}`);
  assert.match(line, /\.$/u, 'one sentence');
  for (const [part, value] of Object.entries(PARTS)) {
    assert.equal(line.includes(value), false, `the sentence repeats the address's ${part}: ${line}`);
  }
  assert.equal(line.includes('postgresql://planted'), false);
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the variable the tests hand a dev server is the one the OS hands it', () => {
  assert.equal(LOCAL_CONNECTION_VARIABLE, 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES');
  assert.equal(LOCAL_CONNECTION_VARIABLE, `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${POSTGRES_BINDING}`);
  assert.equal(TESTS_VARIABLE, LOCAL_CONNECTION_VARIABLE);
  assert.equal(DATABASE_URL, 'DATABASE_URL');
});

test('a Worker config opens the Postgres store when it declares the POSTGRES binding, as both of this checkout do', () => {
  for (const config of ['workers/ingest/wrangler.jsonc', 'apps/tower/wrangler.jsonc']) {
    assert.equal(bindsPostgres(readFileSync(path.join(REPO_ROOT, config), 'utf8')), true, config);
  }
  assert.equal(bindsPostgres('{\n  // a comment\n  "hyperdrive": [ { "binding": "POSTGRES", "id": "x" }, ],\n}\n'), true);
  assert.equal(bindsPostgres('{ "hyperdrive": [ { "binding": "OTHER", "id": "x" } ] }'), false);
  assert.equal(bindsPostgres('{ "d1_databases": [ { "binding": "DB", "database_id": "x" } ] }'), false);
  assert.equal(bindsPostgres('{ "hyperdrive": "POSTGRES" }'), false);
  for (const text of ['not json', '', null, undefined]) assert.equal(bindsPostgres(text), false, String(text));
});

test('an address is read from the secrets file and becomes the one variable the dev server gains', () => {
  const reading = readDatabaseAddress({ OPERATOR_TOKEN: 'x', [DATABASE_URL]: ` ${PLANTED} ` }, WHERE);
  assert.equal(reading.ok, true);
  assert.deepEqual(databaseEnv(reading.address), { [LOCAL_CONNECTION_VARIABLE]: PLANTED });
  assert.equal(readDatabaseAddress({ [DATABASE_URL]: PLANTED.replace('postgresql:', 'postgres:') }, WHERE).ok, true);
});

test('a missing or unusable address is refused in one sentence that names DATABASE_URL and its file, never the address', () => {
  const cases = [
    [undefined, /DATABASE_URL is not set in home\/workers\/ingest\/\.dev\.secrets\.json: add your NoticeOS database's connection string there \(db\/postgres\/host\/README\.md sets one up\)\.$/u],
    ['   ', /is not set in/u],
    [42, /is not set in/u],
    ['not a url at all planted-password-4Qm7', /is not a postgresql:\/\/ connection string/u],
    [PLANTED.replace('postgresql:', 'https:'), /is not a postgresql:\/\/ connection string/u],
    [`postgresql://:${PARTS.password}@${PARTS.host}:${PARTS.port}/${PARTS.database}`, /names no login; NoticeOS logs in as noticeos_app/u],
    [`postgresql://${PARTS.user}@${PARTS.host}:${PARTS.port}/${PARTS.database}`, /has no password, and the Workers' database binding needs one/u],
    // A socket address: the Workers reach the database over TCP only.
    [`postgresql://${PARTS.user}:${PARTS.password}@/${PARTS.database}?host=/tmp`, /is not a postgresql:\/\/ connection string/u],
    [`postgresql://${PARTS.user}:${PARTS.password}@${PARTS.host}:${PARTS.port}/`, /names no database/u],
  ];
  for (const [value, expected] of cases) {
    const reading = readDatabaseAddress(value === undefined ? { OPERATOR_TOKEN: 'x' } : { [DATABASE_URL]: value }, WHERE);
    assert.equal(reading.ok, false, String(value));
    assert.match(reading.line, expected);
    assert.match(reading.line, /DATABASE_URL/u);
    assert.ok(reading.line.includes(WHERE), `names the file: ${reading.line}`);
    assertNothingRepeated(reading.line);
  }
  assert.equal(readDatabaseAddress(null, WHERE).ok, false);
});

test("the code's migrations are the numbered files beside it", (t) => {
  assert.deepEqual(codeMigrationVersions().slice(0, 1), [1]);
  const dir = tempDir(t, 'nos-address-migrations-');
  for (const name of ['0001_baseline.sql', '0002_later.sql', 'README.md', '0003-bad-name.sql']) writeFileSync(path.join(dir, name), '');
  assert.deepEqual(codeMigrationVersions(dir), [1, 2]);
});

/** A store that answers as told, and records that it was closed. */
function fakeStore({ workspace = async () => 'a1b2c3d4-0000-4000-8000-000000000001', applied = codeMigrationVersions(), ledger = null } = {}) {
  const store = {
    closed: false,
    onlyWorkspace: workspace,
    async inWorkspace(id, work, options) {
      assert.deepEqual(options, { readOnly: true }, 'the check only reads');
      return work({
        query: async (sql) => {
          assert.match(sql, /^SELECT version, name, sha256 FROM noticeos_migrations\.applied/u);
          if (ledger) throw ledger;
          return applied.map((version) => (typeof version === 'object' ? version : { version }));
        },
      });
    },
    async close() {
      store.closed = true;
    },
  };
  return store;
}

const failing = (fields) => Object.assign(new Error(`failed for ${PLANTED} as "${PARTS.user}"`), fields);
const named = (name) => Object.assign(new Error(`${name} at ${PARTS.host}`), { name });

test('the check stops a start whose database does not answer, refuses the login, lacks a migration or a workspace, in a sentence of its own', async (t) => {
  const address = { url: PLANTED };
  const extra = tempDir(t, 'nos-address-ahead-');
  writeFileSync(path.join(extra, '0001_baseline.sql'), '');
  writeFileSync(path.join(extra, '0002_later.sql'), '');
  writeFileSync(path.join(extra, '0003_after.sql'), '');

  const cases = [
    [{}, null],
    [{ migrationsDir: extra, applied: [1, 2, 3] }, null],
    [{ migrationsDir: extra, applied: [1] }, /is 2 migrations behind this code; pnpm postgres:migrate apply brings it up to date/u],
    [{ migrationsDir: extra, applied: [1, 2] }, /is 1 migration behind this code/u],
    [{ workspace: async () => { throw named('NoSingleWorkspace'); } }, /has no workspace yet; pnpm postgres:migrate bootstrap creates it/u],
    [{ workspace: async () => { throw named('TransactionRefused'); } }, /logs in as another role; NoticeOS logs in as noticeos_app/u],
    [{ workspace: async () => { throw failing({ code: 'ECONNREFUSED' }); } }, /does not answer; start it \(db\/postgres\/host\/README\.md\), then try again/u],
    [{ workspace: async () => { throw failing({}); } }, /could not be checked; see/u],
    [{ workspace: async () => { throw new Error('timeout expired'); } }, /does not answer/u],
    [{ workspace: async () => { throw failing({ code: '28P01' }); } }, /refused its login; check the user and password in DATABASE_URL/u],
    [{ workspace: async () => { throw failing({ code: '3D000' }); } }, /does not exist \(db\/postgres\/host\/README\.md creates it\)/u],
    [{ workspace: async () => { throw failing({ code: '42883' }); } }, /has no NoticeOS schema its login can read; pnpm postgres:migrate apply creates it/u],
    [{ ledger: failing({ code: '42501' }) }, /does not let its login read which migrations it has/u],
    [{ workspace: async () => { throw failing({ code: '53300' }); } }, /could not be checked \(53300\)/u],
  ];
  for (const [given, expected] of cases) {
    const store = fakeStore(given);
    const answer = await checkDatabase(address, { where: WHERE, migrationsDir: given.migrationsDir, open: (url) => (assert.equal(url, PLANTED), store) });
    assert.equal(store.closed, true, 'the store is closed whatever the answer');
    if (expected === null) {
      assert.deepEqual(answer, { ok: true });
      continue;
    }
    assert.equal(answer.ok, false);
    assert.match(answer.line, expected);
    assert.match(answer.line, /DATABASE_URL/u);
    assertNothingRepeated(answer.line);
  }
  // A store that cannot even be opened is a refusal too, never a throw.
  const unopened = await checkDatabase(address, { where: WHERE, open: () => { throw failing({ code: 'ENOTFOUND' }); } });
  assert.match(unopened.line, /does not answer/u);
  assertNothingRepeated(unopened.line);
});

test('the whole path: a secrets file that cannot be read, holds no address, or holds a usable one', async () => {
  const unreadable = await towerDatabase({ where: WHERE, readBindings: async () => { throw new Error(`Unexpected token in JSON: "${PLANTED}"`); } });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.line, /home\/workers\/ingest\/\.dev\.secrets\.json could not be read, so DATABASE_URL is unknown/u);
  assertNothingRepeated(unreadable.line);

  let opened = 0;
  const open = () => ((opened += 1), fakeStore());
  const missing = await towerDatabase({ where: WHERE, readBindings: async () => ({ bindings: { OPERATOR_TOKEN: 'x' } }), open });
  assert.match(missing.line, /DATABASE_URL is not set in/u);
  assert.equal(opened, 0, 'nothing is connected to without an address');

  const ready = await towerDatabase({ where: WHERE, readBindings: async () => ({ bindings: { [DATABASE_URL]: PLANTED } }), open });
  assert.deepEqual(ready, { ok: true, env: { [LOCAL_CONNECTION_VARIABLE]: PLANTED } });
  assert.equal(opened, 1);
});

test('the record is read as the application login, only read, with each version, name and hash; a failure is the check’s own sentence', async () => {
  const address = { url: PLANTED };
  const sha = 'd'.repeat(64);
  const store = fakeStore({ applied: [{ version: '1', name: '0001_baseline', sha256: sha }, { version: 2, name: '0002_more', sha256: sha }] });
  assert.deepEqual(await readRecordedMigrations(address, { where: WHERE, open: () => store }), {
    ok: true,
    records: [
      { version: 1, name: '0001_baseline', sha256: sha },
      { version: 2, name: '0002_more', sha256: sha },
    ],
  });
  assert.equal(store.closed, true);

  for (const [given, expected] of [
    [{ workspace: async () => { throw named('NoSingleWorkspace'); } }, /has no workspace yet; pnpm postgres:migrate bootstrap creates it/u],
    [{ workspace: async () => { throw failing({ code: 'ECONNREFUSED' }); } }, /does not answer; start it \(db\/postgres\/host\/README\.md\), then try again/u],
    [{ ledger: failing({ code: '42501' }) }, /does not let its login read which migrations it has/u],
  ]) {
    const failed = fakeStore(given);
    const answer = await readRecordedMigrations(address, { where: WHERE, open: () => failed });
    assert.equal(answer.ok, false);
    assert.match(answer.line, expected);
    assertNothingRepeated(answer.line);
    assert.equal(failed.closed, true);
  }

  // Through the secrets file, as a deploy reads it: nothing is connected to without an address.
  let opened = 0;
  const open = () => ((opened += 1), fakeStore({ applied: [{ version: 1, name: '0001_baseline', sha256: sha }] }));
  const missing = await recordedMigrations({ where: WHERE, readBindings: async () => ({ bindings: { OPERATOR_TOKEN: 'x' } }), open });
  assert.match(missing.line, /DATABASE_URL is not set in/u);
  const unreadable = await recordedMigrations({ where: WHERE, readBindings: async () => { throw new Error(`bad JSON near "${PLANTED}"`); }, open });
  assert.match(unreadable.line, /could not be read, so DATABASE_URL is unknown/u);
  assertNothingRepeated(unreadable.line);
  assert.equal(opened, 0);
  const read = await recordedMigrations({ where: WHERE, readBindings: async () => ({ bindings: { [DATABASE_URL]: PLANTED } }), open });
  assert.deepEqual(read, { ok: true, records: [{ version: 1, name: '0001_baseline', sha256: sha }] });
  assert.equal(opened, 1);
});

// ─── On a real Postgres ─────────────────────────────────────────────────────

async function cluster(t) {
  try {
    const started = await startTestCluster();
    t.after(() => started.close());
    return started;
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null || postgresRequired()) throw error;
    t.skip(`no Postgres here: ${reason}`);
    return null;
  }
}

test('on a throwaway Postgres: a migrated store with its workspace passes, and every way it can be wrong is named', { timeout: 120_000 }, async (t) => {
  const pg = await cluster(t);
  if (!pg) return;
  const where = WHERE;
  const good = pg.url(await pg.createDatabase());
  assert.deepEqual(await checkDatabase({ url: good }, { where }), { ok: true });

  // The record, as the application login reads it: every migration file of
  // this code, by version, name and the SHA-256 of its bytes.
  const migrationsDir = path.join(REPO_ROOT, 'db', 'postgres', 'migrations');
  const files = readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  assert.deepEqual(await readRecordedMigrations({ url: good }, { where }), {
    ok: true,
    records: files.map((name) => ({
      version: Number(name.slice(0, 4)),
      name: name.replace(/\.sql$/u, ''),
      sha256: createHash('sha256').update(readFileSync(path.join(migrationsDir, name))).digest('hex'),
    })),
  });

  // This code has a migration the store lacks.
  const ahead = tempDir(t, 'nos-address-live-');
  for (const version of codeMigrationVersions()) writeFileSync(path.join(ahead, `${String(version).padStart(4, '0')}_x.sql`), '');
  writeFileSync(path.join(ahead, `${String(codeMigrationVersions().length + 1).padStart(4, '0')}_later.sql`), '');
  const behind = await checkDatabase({ url: good }, { where, migrationsDir: ahead });
  assert.match(behind.line, /is 1 migration behind this code/u);

  // Another password, a database that is not there, a port nothing holds.
  const wrong = new URL(good);
  wrong.password = PARTS.password;
  const refusedLogin = await checkDatabase({ url: wrong.toString() }, { where });
  assert.match(refusedLogin.line, /refused its login/u);
  const absent = new URL(good);
  absent.pathname = '/noticeos_absent_dev';
  const missing = await checkDatabase({ url: absent.toString() }, { where });
  assert.match(missing.line, /does not exist/u);
  const closed = new URL(good);
  closed.port = '9';
  const unanswered = await checkDatabase({ url: closed.toString() }, { where });
  assert.match(unanswered.line, /does not answer/u);

  // Migrated, but never bootstrapped: no workspace.
  const empty = await pg.createDatabase();
  await pg.asOwner(empty, 'TRUNCATE noticeos.workspaces CASCADE;');
  const unbootstrapped = await checkDatabase({ url: pg.url(empty) }, { where });
  assert.match(unbootstrapped.line, /has no workspace yet/u);

  for (const { line } of [behind, refusedLogin, missing, unanswered, unbootstrapped]) {
    assertNothingRepeated(line);
    assert.equal(line.includes(new URL(good).password), false);
  }
});
