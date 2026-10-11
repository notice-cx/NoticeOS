import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from './os-migrate.mjs';
import { composePrefix, secretAddress, stackDatabaseCurrent, stackSecretsDir } from './stack-database.mjs';

const OWNER_URL = 'postgresql://noticeos_owner:s3cret@127.0.0.1:5432/noticeos';

/** A stack selector, its Compose file and env file, and a Postgres secrets
 * folder in a different checkout's folder, as an installation may keep it. */
function stack(t, { ownerUrl = OWNER_URL } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'os-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const compose = path.join(dir, 'compose.json');
  writeFileSync(compose, '{}');
  const envFile = path.join(dir, 'stack.env');
  writeFileSync(envFile, '');
  const secrets = path.join(dir, 'elsewhere', 'postgres-keys');
  mkdirSync(secrets, { recursive: true });
  if (ownerUrl !== null) writeFileSync(path.join(secrets, 'owner.url'), `${ownerUrl}\n`);
  const selector = path.join(dir, 'stack.json');
  const declared = { project: 'example', files: [compose], envFile, dockerHost: 'unix:///var/run/docker.sock' };
  writeFileSync(selector, JSON.stringify(declared));
  /** `docker compose config` for this stack: the owner's secret is in `secrets`. */
  const docker = async (command, args) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, composePrefix(declared).length), composePrefix(declared));
    assert.deepEqual(args.slice(composePrefix(declared).length), ['config', '--format', 'json']);
    return { code: 0, stdout: JSON.stringify({ services: { app: { environment: { DATABASE_URL: 'PRIVATE' } } }, secrets: { noticeos_owner: { file: path.join(secrets, 'noticeos_owner') } } }) };
  };
  return { dir, selector, secrets, declared, docker };
}

/** main() with the engine replaced by a recorder. */
async function runMigrate(argv, { interactive = false, typed = '', code = 0, docker } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const result = await main(argv, {
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    env: { PATH: process.env.PATH },
    interactive,
    question: async () => typed,
    ...(docker ? { docker } : {}),
    run: (args, _out, _err, options) => {
      calls.push({ args, url: options.env.NOTICEOS_OWNER_URL, targetFlags: options.targetFlags, planShown: options.planShown ?? false });
      return code;
    },
  });
  return { result, calls, out: out.join(''), err: err.join('') };
}

test('the secrets folder is wherever the stack\'s resolved declaration keeps the owner\'s secret', async (t) => {
  const { declared, secrets, docker } = stack(t);
  assert.equal(await stackSecretsDir(declared, { run: docker }), secrets);
  await assert.rejects(stackSecretsDir(declared, { run: async () => ({ code: 0, stdout: JSON.stringify({ secrets: {} }) }) }), /declares no noticeos_owner secret file/u);
  await assert.rejects(stackSecretsDir(declared, { run: async () => ({ code: 1, stdout: '', stderr: 'PRIVATE' }) }), /Compose could not read the stack's declaration; is Docker running\?/u);
});

test('the database comes from owner.url, and a missing or malformed file is refused by name', (t) => {
  const { secrets } = stack(t);
  assert.deepEqual(secretAddress(secrets), { url: OWNER_URL, database: 'noticeos', where: path.join(secrets, 'owner.url') });
  const empty = stack(t, { ownerUrl: null });
  assert.throws(() => secretAddress(empty.secrets), /no owner\.url in the stack's Postgres secrets folder /u);
  writeFileSync(path.join(empty.secrets, 'owner.url'), 'not a url\n');
  assert.throws(() => secretAddress(empty.secrets), /does not hold a postgresql:\/\/ address/u);
});

test('with no flags it shows status for the stack’s database, the address only in the child environment', async (t) => {
  const { selector, docker } = stack(t);
  const { result, calls, out, err } = await runMigrate(['--config', selector], { docker });
  assert.equal(result, 0);
  assert.deepEqual(calls, [{ args: ['status', '--database', 'noticeos', '--url-from', 'NOTICEOS_OWNER_URL'], url: OWNER_URL, targetFlags: '', planShown: false }]);
  assert.doesNotMatch(out + err, /s3cret/u);
});

test('at a terminal, --apply shows the plan, asks for the name once, and applies with what was typed', async (t) => {
  const { selector, docker } = stack(t);
  const { calls } = await runMigrate(['--', '--apply', '--config', selector], { docker, interactive: true, typed: 'noticeos' });
  assert.deepEqual(calls.map((call) => call.args[0]), ['status', 'apply']);
  assert.deepEqual(calls[1].args.slice(-2), ['--confirm', 'noticeos']);
  assert.equal(calls[1].planShown, true);
});

test('at a terminal, pressing Enter changes nothing', async (t) => {
  const { selector, docker } = stack(t);
  const { result, calls, out } = await runMigrate(['--apply', '--config', selector], { docker, interactive: true, typed: '' });
  assert.equal(result, 0);
  assert.deepEqual(calls.map((call) => call.args[0]), ['status']);
  assert.match(out, /Nothing was changed/u);
});

test('without a terminal, --apply passes --confirm through and never asks', async (t) => {
  const { selector, docker } = stack(t);
  const { calls } = await runMigrate(['--apply', '--confirm', 'noticeos', '--config', selector], { docker });
  assert.deepEqual(calls.map((call) => call.args), [['apply', '--database', 'noticeos', '--url-from', 'NOTICEOS_OWNER_URL', '--confirm', 'noticeos']]);
  const unconfirmed = await runMigrate(['--apply', '--config', selector], { docker });
  assert.deepEqual(unconfirmed.calls[0].args.includes('--confirm'), false, 'the engine refuses an unconfirmed apply itself');
});

test('--secrets names the folder directly; a missing selector or both steps at once is refused', async (t) => {
  const { secrets } = stack(t);
  const direct = await runMigrate(['--secrets', secrets]);
  assert.equal(direct.calls[0].args[2], 'noticeos');
  const nowhere = await runMigrate(['--config', path.join(secrets, 'absent.json')]);
  assert.equal(nowhere.result, 2);
  assert.match(nowhere.err, /refused: Stack selector or declared files are invalid or missing/u);
  const both = await runMigrate(['--apply', '--bootstrap', '--secrets', secrets]);
  assert.equal(both.result, 2);
  assert.match(both.err, /--apply or --bootstrap, not both/u);
});

test('the stack\'s database is checked over its own container socket, read-only, against this checkout\'s migrations', async (t) => {
  const { declared } = stack(t);
  const root = mkdtempSync(path.join(os.tmpdir(), 'os-migrate-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'db', 'postgres', 'migrations'), { recursive: true });
  for (const name of ['0001_baseline.sql', '0002_next.sql', '0003_more.sql']) writeFileSync(path.join(root, 'db', 'postgres', 'migrations', name), 'select 1;\n');
  const asked = [];
  const answering = (result) => async (command, args) => { asked.push(args.slice(composePrefix(declared).length)); return result; };
  assert.deepEqual(await stackDatabaseCurrent(declared, { root, run: answering({ code: 0, stdout: '1\n2\n3\n' }) }), { ok: true });
  assert.deepEqual(asked[0], ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'noticeos', '-qAtX', '-v', 'ON_ERROR_STOP=1',
    '-c', 'SET default_transaction_read_only = on', '-c', 'SELECT version FROM noticeos_migrations.applied ORDER BY version']);
  assert.deepEqual(await stackDatabaseCurrent(declared, { root, run: answering({ code: 0, stdout: '1\n' }) }),
    { ok: false, line: 'it is 2 migrations behind this checkout; pnpm os:migrate -- --apply brings it up to date' });
  const down = await stackDatabaseCurrent(declared, { root, run: answering({ code: 2, stdout: '', stderr: 'PRIVATE' }) });
  assert.deepEqual(down, { ok: false, line: 'the stack\'s Postgres did not answer which migrations it has; pnpm os:logs -- postgres shows why' });
  const thrown = await stackDatabaseCurrent(declared, { root, run: async () => { throw new Error('PRIVATE'); } });
  assert.equal(thrown.ok, false);
});
