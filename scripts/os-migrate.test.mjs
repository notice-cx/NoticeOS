import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from './os-migrate.mjs';
import { readEnvFile, secretAddress, stackDatabaseCurrent, stackSecretsDir } from './stack-database.mjs';

const OWNER_URL = 'postgresql://noticeos_owner:s3cret@127.0.0.1:5432/noticeos';

/** A stack selector with its Compose file, env file and Postgres secrets folder. */
function stack(t, { envLine = null, ownerUrl = OWNER_URL } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'os-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const composeDir = path.join(dir, 'postgres');
  mkdirSync(composeDir);
  const compose = path.join(composeDir, 'compose.yaml');
  writeFileSync(compose, 'secrets:\n  owner:\n    file: ${NOTICEOS_POSTGRES_SECRETS:-./secrets}/noticeos_owner\n');
  const envFile = path.join(dir, 'compose.env');
  writeFileSync(envFile, `# the stack\nNOTICEOS_NETWORK=example\n${envLine ?? ''}\n`);
  const secrets = envLine ? path.resolve(composeDir, readEnvFile(envLine).NOTICEOS_POSTGRES_SECRETS) : path.join(composeDir, 'secrets');
  mkdirSync(secrets, { recursive: true });
  if (ownerUrl !== null) writeFileSync(path.join(secrets, 'owner.url'), `${ownerUrl}\n`);
  const selector = path.join(dir, 'stack.json');
  writeFileSync(selector, JSON.stringify({ project: 'example', files: [compose], envFile, dockerHost: 'unix:///var/run/docker.sock' }));
  return { dir, selector, secrets };
}

/** main() with the engine replaced by a recorder. */
async function runMigrate(argv, { interactive = false, typed = '', code = 0 } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const result = await main(argv, {
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    env: { PATH: process.env.PATH },
    interactive,
    question: async () => typed,
    run: (args, _out, _err, options) => {
      calls.push({ args, url: options.env.NOTICEOS_OWNER_URL, targetFlags: options.targetFlags, planShown: options.planShown ?? false });
      return code;
    },
  });
  return { result, calls, out: out.join(''), err: err.join('') };
}

test('an env file is read as Compose reads it: comments skipped, quotes stripped', () => {
  assert.deepEqual(readEnvFile('# note\nA=1\nexport B="two words"\nC=\'x\' \nD=bare # trailing note\n'), { A: '1', B: 'two words', C: 'x', D: 'bare' });
});

test('the secrets folder is the env file’s NOTICEOS_POSTGRES_SECRETS, relative to the Compose file that declares it', (t) => {
  const named = stack(t, { envLine: 'NOTICEOS_POSTGRES_SECRETS=../keys' });
  assert.equal(stackSecretsDir(JSON.parse(readFileSync(named.selector, 'utf8'))), named.secrets);
  const unnamed = stack(t);
  assert.equal(stackSecretsDir(JSON.parse(readFileSync(unnamed.selector, 'utf8'))), unnamed.secrets);
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
  const { selector } = stack(t);
  const { result, calls, out, err } = await runMigrate(['--config', selector]);
  assert.equal(result, 0);
  assert.deepEqual(calls, [{ args: ['status', '--database', 'noticeos', '--url-from', 'NOTICEOS_OWNER_URL'], url: OWNER_URL, targetFlags: '', planShown: false }]);
  assert.doesNotMatch(out + err, /s3cret/u);
});

test('at a terminal, --apply shows the plan, asks for the name once, and applies with what was typed', async (t) => {
  const { selector } = stack(t);
  const { calls } = await runMigrate(['--', '--apply', '--config', selector], { interactive: true, typed: 'noticeos' });
  assert.deepEqual(calls.map((call) => call.args[0]), ['status', 'apply']);
  assert.deepEqual(calls[1].args.slice(-2), ['--confirm', 'noticeos']);
  assert.equal(calls[1].planShown, true);
});

test('at a terminal, pressing Enter changes nothing', async (t) => {
  const { selector } = stack(t);
  const { result, calls, out } = await runMigrate(['--apply', '--config', selector], { interactive: true, typed: '' });
  assert.equal(result, 0);
  assert.deepEqual(calls.map((call) => call.args[0]), ['status']);
  assert.match(out, /Nothing was changed/u);
});

test('without a terminal, --apply passes --confirm through and never asks', async (t) => {
  const { selector } = stack(t);
  const { calls } = await runMigrate(['--apply', '--confirm', 'noticeos', '--config', selector]);
  assert.deepEqual(calls.map((call) => call.args), [['apply', '--database', 'noticeos', '--url-from', 'NOTICEOS_OWNER_URL', '--confirm', 'noticeos']]);
  const unconfirmed = await runMigrate(['--apply', '--config', selector]);
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

test('the stack’s database is current when the application login’s check says so, and a missing address is named', async (t) => {
  const { selector, secrets } = stack(t);
  const declared = JSON.parse(readFileSync(selector, 'utf8'));
  const seen = [];
  const check = async (address, options) => {
    seen.push({ address, options });
    return { ok: false, line: 'the database is 1 migration behind this code; pnpm os:migrate -- --apply brings it up to date' };
  };
  const missing = await stackDatabaseCurrent(declared, { root: '/checkout', check });
  assert.equal(missing.ok, false);
  assert.match(missing.line, /no database\.url in the stack's Postgres secrets folder /u);
  assert.equal(seen.length, 0);
  writeFileSync(path.join(secrets, 'database.url'), 'postgresql://noticeos_app:s3cret@127.0.0.1:5432/noticeos\n');
  await stackDatabaseCurrent(declared, { root: '/checkout', check });
  assert.deepEqual(seen[0], {
    address: { url: 'postgresql://noticeos_app:s3cret@127.0.0.1:5432/noticeos' },
    options: { where: path.join(secrets, 'database.url'), migrationsDir: path.join('/checkout', 'db', 'postgres', 'migrations') },
  });
});
