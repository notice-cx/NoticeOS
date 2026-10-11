import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { checkTarget } from './postgres-apply.mjs';
import { DEFAULT_DIR, FILES, URLS, VERIFIERS, main, writeSecrets } from './postgres-secrets.mjs';

// THE POSTGRES SERVICE'S SECRET FILES: `pnpm
// db:create-secrets`, scripts/postgres-secrets.mjs, which the Compose profile
// (db/postgres/host/) reads. No Postgres and no container app needed:
//   - every file is written, in a folder only this account may open, a
//     verifier readable in it (the container's own user reads it) and a
//     connection string this account's only;
//   - each verifier checks its own login's password and no other, and the
//     superuser's checks none the operator keeps;
//   - the owner's and the maintenance role's URLs pass `pnpm
//     os:migrate`'s own check for --url-from, and database.url is
//     exactly the DATABASE_URL shape the runner takes (the application role,
//     127.0.0.1, the port, noticeos, sslmode=disable);
//   - nothing it prints repeats a password or a connection string;
//   - a file already there is never replaced: nothing is written then.

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-secrets-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The command, in this process: `{ code, out, err }`. */
function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { write: (s) => out.push(s) }, { write: (s) => err.push(s) });
  return { code, out: out.join(''), err: err.join('') };
}

/** Whether `verifier` (SCRAM-SHA-256$iterations:salt$storedKey:serverKey) checks `password`. */
function verifies(verifier, password) {
  const [, iterations, salt, storedKey, serverKey] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/u.exec(verifier);
  const salted = pbkdf2Sync(password, Buffer.from(salt, 'base64'), Number(iterations), 32, 'sha256');
  const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return stored === storedKey && server === serverKey;
}

const read = (dir, name) => readFileSync(path.join(dir, name), 'utf8').trim();
const mode = (file) => (statSync(file).mode & 0o777).toString(8);

test('every secret file is written, the folder this account’s alone, a connection string readable by this account only', () => {
  const dir = path.join(tempDir(), 'secrets');
  const result = run(['--dir', dir, '--port', '5433']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(readdirSync(dir).sort(), [...FILES].sort());
  assert.equal(mode(dir), '700');
  for (const name of VERIFIERS) assert.equal(mode(path.join(dir, name)), '644', `${name}: the container reads it as its own user`);
  for (const name of Object.keys(URLS)) assert.equal(mode(path.join(dir, name)), '600', name);
  assert.equal(path.relative(REPO_ROOT, DEFAULT_DIR), path.join('db', 'postgres', 'host', 'secrets'), 'the folder compose.yaml reads by default');
});

test('each verifier checks its own login’s password and no other, and the superuser’s none the operator keeps', () => {
  const dir = path.join(tempDir(), 'secrets');
  assert.equal(run(['--dir', dir]).code, 0);
  const passwords = Object.fromEntries(Object.entries(URLS).map(([name, login]) => [login, decodeURIComponent(new URL(read(dir, name)).password)]));
  assert.equal(new Set(Object.values(passwords)).size, 3, 'three different passwords');
  for (const login of VERIFIERS) {
    const verifier = read(dir, login);
    assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/u, login);
    for (const [owner, password] of Object.entries(passwords)) {
      assert.equal(verifies(verifier, password), owner === login, `${login}'s verifier and ${owner}'s password`);
    }
  }
});

test('the connection strings: the operator’s two pass pnpm os:migrate’s own check, and database.url is the DATABASE_URL the runner takes', () => {
  const dir = path.join(tempDir(), 'secrets');
  assert.equal(run(['--dir', dir, '--port', '5701']).code, 0);
  const owner = checkTarget({ database: 'noticeos', urlFrom: 'OWNER' }, { OWNER: read(dir, 'owner.url') });
  assert.deepEqual(
    { ...owner.parts, password: owner.password === null ? null : 'set' },
    { host: '127.0.0.1', port: '5701', dbname: 'noticeos', user: 'noticeos_owner', sslmode: 'disable', application_name: 'noticeos-migrate', password: 'set' },
  );
  const maint = checkTarget({ database: 'noticeos', urlFrom: 'MAINT' }, { MAINT: read(dir, 'maint.url') }, { login: 'noticeos_maint' });
  assert.equal(maint.parts.user, 'noticeos_maint');
  const app = new URL(read(dir, 'database.url'));
  assert.deepEqual(
    { protocol: app.protocol, user: app.username, host: app.hostname, port: app.port, path: app.pathname, search: app.search, password: /^[A-Za-z0-9_-]{32}$/u.test(app.password) },
    { protocol: 'postgresql:', user: 'noticeos_app', host: '127.0.0.1', port: '5701', path: '/noticeos', search: '?sslmode=disable', password: true },
  );
});

test('nothing it prints repeats a password or a connection string, and the next step is named', () => {
  const dir = path.join(tempDir(), 'secrets');
  const result = run(['--dir', dir]);
  assert.equal(result.code, 0);
  const printed = `${result.out}${result.err}`;
  for (const name of Object.keys(URLS)) {
    const url = read(dir, name);
    assert.equal(printed.includes(new URL(url).password), false, `${name}'s password`);
    assert.equal(printed.includes('postgresql://'), false, 'no connection string');
  }
  for (const name of VERIFIERS) assert.equal(printed.includes(read(dir, name)), false, `${name}'s verifier`);
  assert.match(result.out, /^Next: NOTICEOS_POSTGRES_SECRETS=\S+ docker compose -f db\/postgres\/host\/compose\.yaml up --detach --wait$/mu);
});

test('a file already there is never replaced, and nothing is written then', () => {
  const dir = path.join(tempDir(), 'secrets');
  assert.equal(run(['--dir', dir]).code, 0);
  const before = Object.fromEntries(FILES.map((name) => [name, read(dir, name)]));
  const again = run(['--dir', dir]);
  assert.equal(again.code, 2);
  assert.match(again.err, /already holds postgres, noticeos_owner, noticeos_maint, noticeos_app, owner\.url, maint\.url, database\.url; .*nothing was replaced/u);
  for (const name of FILES) assert.equal(read(dir, name), before[name], name);

  const partly = path.join(tempDir(), 'secrets');
  assert.equal(run(['--dir', partly]).code, 0);
  rmSync(path.join(partly, 'owner.url'));
  writeFileSync(path.join(partly, 'stray'), 'left alone\n');
  const refused = run(['--dir', partly]);
  assert.equal(refused.code, 2, 'one file gone still refuses: the rest were made together');
  assert.deepEqual(readdirSync(partly).sort(), [...FILES.filter((name) => name !== 'owner.url'), 'stray'].sort());

  assert.throws(() => writeSecrets(dir), /already holds/u);
});

test('a port it cannot use, or an unknown option, is refused before anything is written', () => {
  for (const [argv, why] of [
    [['--port', '0'], /--port is a whole number from 1 to 65535/u],
    [['--port', '5432x'], /--port is a whole number/u],
    [['--port', '70000'], /--port is a whole number/u],
    [['--password', 'x'], /Unknown option/u],
  ]) {
    const dir = path.join(tempDir(), 'secrets');
    const result = run([...argv, '--dir', dir]);
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.err, why, argv.join(' '));
    assert.throws(() => statSync(dir), /ENOENT/u, 'no folder made');
  }
});
