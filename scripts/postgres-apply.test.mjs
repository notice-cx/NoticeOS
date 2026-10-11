import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { REPO_ROOT } from './test-config-isolation.mjs';
import {
  LOOPBACK_HBA,
  MIGRATIONS_DIR,
  OPERATOR_CONNECT_SECONDS,
  PostgresUnavailable,
  PsqlError,
  ROLES_SQL,
  THROWAWAY_CONNECT_SECONDS,
  checkedSession,
  findPostgres,
  migrationFiles,
  openThrowaway,
  socketSession,
} from './postgres-dev.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { LOCK_KEY, MigrationRefused } from './postgres-migrate.mjs';
import { OWNER, checkTarget, main } from './postgres-apply.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';

// The operator-only command that builds the Postgres schema in an
// installation's own database: `pnpm os:migrate`,
// scripts/postgres-apply.mjs. These proofs run it on throwaway clusters only.
//
//   - STATIC, always: the target is checked before anything connects (a
//     development database, --dir or --url, a relative socket, an unnamed or
//     unset variable, a URL naming another login, database, host list or
//     parameter), and no refusal repeats a password; a password reaches psql
//     only in its environment, never its command line, and no output of the
//     command repeats it, even where psql would.
//   - LIVE, on a throwaway cluster that imitates a server installed on the
//     machine itself: the three roles with logins, databases owned by
//     noticeos_owner, not marked for development, with CONNECT taken from
//     PUBLIC, and a pg_hba.conf with a pg_ident map for this account
//     (scripts/fixture-postgres-peer-host/), so the owner reaches them over
//     the private socket by a peer login with no password (the --socket way
//     in), and the application cannot. There: status
//     only reads; apply prints its plan first and changes nothing until the
//     database's name is typed again; it refuses a migration that is not
//     frozen, a frozen one that changed, a recorded one that changed or is
//     gone, a development database, and a database the owner may not build
//     in; it applies as the owner, records each file's hash, leaves the
//     database's own grants as they were, and a second apply changes nothing;
//     a failing migration leaves the database exactly as it was; a second run
//     is refused while one holds the lock; bootstrap creates the one workspace
//     once, and two at once cannot both create one. With psql alone on the
//     machine, no initdb or pg_ctl, status reaches the server and prints its
//     plan, while a throwaway cluster still needs the
//     server binaries. On a second throwaway cluster, a host that needs a
//     password, as the Compose profile does (db/postgres/host/): the owner's
//     URL comes from the variable named, works over TCP, and neither it nor a
//     wrong one is repeated.

/** A server on the machine itself, its owner and maintenance logins this
 * account's own on the socket: the commands' --socket way in. */
const PEER_HOST_HBA = fileURLToPath(new URL('./fixture-postgres-peer-host/pg_hba.conf', import.meta.url));

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
/** Servers to stop once every test has run, before their folders go. */
const closers = [];
after(() => {
  for (const close of closers.reverse()) close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** The real migrations, by name, in order. */
const REAL = migrationFiles().map((file) => path.basename(file, '.sql'));
/** The frozen list for `dir`'s first `count` migrations, as `shasum -a 256` prints it from db/postgres/. */
const frozenFor = (dir, count = Infinity) =>
  migrationFiles(dir)
    .slice(0, count)
    .map((file) => `${sha256Of(file)}  migrations/${path.basename(file)}\n`)
    .join('');
/** Every real migration frozen: what the committed list holds once the baseline is frozen. */
const FROZEN_REAL = frozenFor(MIGRATIONS_DIR);

/** A migrations folder holding the real migrations, plus `extra` files. */
function migrationsWith(extra = {}) {
  const dir = tempDir('nos-apply-mig-');
  for (const file of migrationFiles()) copyFileSync(file, path.join(dir, path.basename(file)));
  for (const [name, sql] of Object.entries(extra)) writeFileSync(path.join(dir, name), sql);
  return dir;
}
const numbered = (offset = 1) => String(REAL.length + offset).padStart(4, '0');

/** The command, in this process: `{ code, out, err }`. */
function run(argv, options = {}) {
  const out = [];
  const err = [];
  const code = main(argv, { write: (s) => out.push(s) }, { write: (s) => err.push(s) }, options);
  return { code, out: out.join(''), err: err.join('') };
}

// ─── Static ─────────────────────────────────────────────────────────────────

test('the target is checked before anything connects, and no refusal repeats a password', () => {
  const secret = 'hunter2-secret';
  const owner = (rest) => ({ OWNER_URL: `postgresql://noticeos_owner:${secret}@${rest}` });
  const database = 'noticeos';
  const refused = [
    [{}, {}, /name the database/u],
    [{ database: 'Noticeos' }, {}, /lower-case letters/u],
    [{ database: 'noticeos_dev' }, {}, /development database.*Use pnpm db:try-migrations/u],
    [{ database, socket: 'relative/folder' }, {}, /absolute path/u],
    [{ database, socket: '/tmp,/elsewhere' }, {}, /absolute path/u],
    [{ database, port: '54x' }, {}, /whole number/u],
    [{ database, socket: '/tmp', urlFrom: 'OWNER_URL' }, owner('db.example.com/noticeos'), /not both/u],
    [{ database, urlFrom: 'owner url' }, {}, /names an environment variable/u],
    [{ database, urlFrom: 'OWNER_URL' }, {}, /OWNER_URL is not set/u],
    [{ database, urlFrom: 'OWNER_URL' }, { OWNER_URL: `not a url ${secret}` }, /does not hold a postgresql:\/\/ URL/u],
    [{ database, urlFrom: 'OWNER_URL' }, { OWNER_URL: `mysql://noticeos_owner:${secret}@db.example.com/noticeos` }, /does not hold/u],
    [{ database, urlFrom: 'OWNER_URL' }, { OWNER_URL: `postgresql://noticeos_app:${secret}@db.example.com/noticeos` }, /logs in as noticeos_app; .*noticeos_owner only/u],
    [{ database, urlFrom: 'OWNER_URL' }, { OWNER_URL: `postgresql://${secret}@db.example.com/noticeos` }, /logs in as another login/u],
    [{ database, urlFrom: 'OWNER_URL' }, owner('db.example.com/other'), /names the database "other", not noticeos/u],
    [{ database, urlFrom: 'OWNER_URL' }, owner('db.example.com/noticeos?hostaddr=10.0.0.5'), /parameter "hostaddr"/u],
    [{ database, urlFrom: 'OWNER_URL' }, owner('db.example.com/noticeos?host=/tmp'), /parameter "host"/u],
    [{ database, urlFrom: 'OWNER_URL' }, owner('db.example.com/noticeos?dbname=other'), /parameter "dbname"/u],
    [{ database, urlFrom: 'OWNER_URL' }, owner('db.example.com/noticeos?sslmode=require&sslmode=disable'), /twice/u],
    [{ database, urlFrom: 'OWNER_URL' }, owner('a.example.com,b.example.com/noticeos'), /one host/u],
  ];
  for (const [args, env, why] of refused) {
    assert.throws(
      () => checkTarget(args, env),
      (error) => error instanceof MigrationRefused && why.test(error.message) && !error.message.includes(secret),
      `${JSON.stringify(args)} ${why}`,
    );
  }

  // The socket: the owner, no password, nothing but what was typed.
  assert.deepEqual(checkTarget({ database }), {
    database,
    parts: { dbname: database, user: OWNER, application_name: 'noticeos-migrate' },
    password: null,
    hidden: [],
    where: "noticeos on psql's own local socket",
    flags: '--database noticeos',
  });
  assert.deepEqual(checkTarget({ database, socket: '/var/run/postgresql', port: '5433' }).parts, {
    host: '/var/run/postgresql',
    port: '5433',
    dbname: database,
    user: OWNER,
    application_name: 'noticeos-migrate',
  });

  // A URL: the password leaves the connection parts; both its spellings are hidden.
  const password = 'p@ss:w/rd hunter2';
  const target = checkTarget(
    { database, urlFrom: 'OWNER_URL' },
    { OWNER_URL: `postgresql://noticeos_owner:${encodeURIComponent(password)}@db.example.com:6543/noticeos?sslmode=require`, DATABASE_URL: 'ignored' },
  );
  assert.deepEqual(target.parts, {
    host: 'db.example.com',
    port: '6543',
    dbname: database,
    user: OWNER,
    sslmode: 'require',
    application_name: 'noticeos-migrate',
  });
  assert.equal(target.password, password);
  assert.deepEqual(target.hidden, [password, encodeURIComponent(password)]);
  assert.equal(target.where, 'noticeos on db.example.com:6543 (from OWNER_URL)');
  assert.equal(target.flags, '--database noticeos --url-from OWNER_URL');
});

test('the command names pnpm db:try-migrations for a development target, and refuses a mixed or incomplete command line, before connecting', () => {
  const never = { initdb: '/nonexistent/initdb', pgCtl: '/nonexistent/pg_ctl', psql: '/nonexistent/psql', version: 'psql (PostgreSQL) 16.0', major: 16 };
  const cases = [
    [['apply', '--dir', '/tmp/cluster'], /development databases; that is pnpm db:try-migrations/u],
    [['status', '--url', 'postgresql:///noticeos_dev?host=/tmp'], /development databases; that is pnpm db:try-migrations/u],
    [['status', '--database', 'noticeos_dev'], /Use pnpm db:try-migrations/u],
    [['status'], /name the database/u],
    [['migrate', '--database', 'noticeos'], /usage:/u],
    [['status', '--database', 'noticeos', '--confirm', 'noticeos'], /status only reads/u],
    [['apply', '--database', 'noticeos', '--slug', 'main'], /--slug and --name are for bootstrap/u],
    [['apply', '--database', 'noticeos', '--json'], /--json is for status/u],
    [['apply', '--database', 'noticeos', '--password', 'x'], /Unknown option/u],
  ];
  for (const [argv, why] of cases) {
    const result = run(argv, { tools: never, env: {} });
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.err, why, argv.join(' '));
    assert.equal(result.out, '', 'nothing was read, so nothing was planned');
  }
});

test("a password reaches psql only in its environment, never its command line, and no output repeats it, even where psql would; the operator's psql waits 5 s to connect, a throwaway cluster's 30", () => {
  const dir = tempDir('nos-apply-stub-');
  const record = path.join(dir, 'record.json');
  const psql = path.join(dir, 'psql');
  // A psql that records what it was given (the password only as its hash),
  // then fails the way a refused login does, repeating the password.
  writeFileSync(
    psql,
    `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const password = process.env.PGPASSWORD ?? '';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  pg: Object.keys(process.env).filter((key) => key.startsWith('PG') || key === 'DATABASE_URL').sort(),
  connectTimeout: process.env.PGCONNECT_TIMEOUT,
  password: createHash('sha256').update(password).digest('hex'),
}));
process.stderr.write('psql: error: FATAL: password authentication failed for user "noticeos_owner" (' + password + ')\\n');
process.exit(2);
`,
  );
  chmodSync(psql, 0o755);
  const tools = { initdb: '/nonexistent/initdb', pgCtl: '/nonexistent/pg_ctl', psql, version: 'psql (PostgreSQL) 16.0', major: 16 };
  const password = `${randomBytes(12).toString('hex')}/+%`;
  const env = { OWNER_URL: `postgresql://noticeos_owner:${encodeURIComponent(password)}@db.example.com:6543/noticeos?sslmode=require` };

  const result = run(['status', '--database', 'noticeos', '--url-from', 'OWNER_URL'], { env, tools });
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /^failed: .*password authentication failed .*\(\*\*\*\)/u);
  for (const shown of [password, encodeURIComponent(password)]) {
    assert.equal(`${result.out}${result.err}`.includes(shown), false, 'no output repeats the password');
  }

  const seen = JSON.parse(readFileSync(record, 'utf8'));
  const commandLine = seen.args.join(' ');
  assert.equal(commandLine.includes(password) || commandLine.includes(encodeURIComponent(password)), false, 'not on the command line');
  assert.ok(
    seen.args.includes("host='db.example.com' port='6543' dbname='noticeos' user='noticeos_owner' sslmode='require' application_name='noticeos-migrate'"),
    commandLine,
  );
  assert.equal(seen.password, createHash('sha256').update(password).digest('hex'), 'the password reached psql in its environment');
  assert.deepEqual(seen.pg, ['PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGPASSFILE', 'PGPASSWORD', 'PGSERVICEFILE'], 'and nothing else of the kind');
  // The operator's command is told within seconds that it cannot connect.
  assert.equal(OPERATOR_CONNECT_SECONDS, 5);
  assert.equal(seen.connectTimeout, '5', "the operator's command waits 5 s to connect");

  // A throwaway cluster's session waits 30 s: a proof on a busy machine fails
  // on what it proves, never on how long the machine took to accept it.
  assert.equal(THROWAWAY_CONNECT_SECONDS, 30);
  assert.throws(() => socketSession({ tools, socketDir: dir, port: 5410, database: 'noticeos_dev' }).run('SELECT 1;\n'), PsqlError);
  const throwaway = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(throwaway.connectTimeout, '30', "a throwaway cluster's psql waits 30 s to connect");
  assert.deepEqual(throwaway.pg, ['PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGPASSFILE', 'PGSERVICEFILE'], 'and no password');
});

// ─── Live, on a throwaway cluster that imitates a server on this machine ────

/** Run `fn`, or skip with the reason where no Postgres can start. */
async function live(t, fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') {
      t.skip(error.message);
      return;
    }
    throw error;
  }
}

/** `probe()` once it is truthy, polled every 100 ms for at most `ms`; null past that. */
async function eventually(probe, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value || Date.now() >= deadline) return value || null;
    await delay(100);
  }
}

/** Whether `session` can run a query; false with psql's refusal in `why`. */
function answers(session, why = []) {
  try {
    session.sql('SELECT 1');
    return true;
  } catch (error) {
    if (!(error instanceof PsqlError)) throw error;
    why.push(error.message);
    return false;
  }
}

const ROLE_LOGINS = 'ALTER ROLE noticeos_owner LOGIN;\nALTER ROLE noticeos_maint LOGIN;\nALTER ROLE noticeos_app LOGIN;\n';

let hostCluster = null;
/**
 * A server on this machine, as a throwaway cluster, once per file: roles.sql,
 * a login for each role, and the peer host's pg_hba.conf with the "noticeos"
 * map for this account (the cluster's superuser is `postgres` here). From
 * then on every login on its private socket is a peer login.
 */
async function host() {
  if (hostCluster) return hostCluster;
  const tools = findPostgres();
  if (!tools) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
  const cluster = openThrowaway(path.join(tempDir('nos-apply-host-'), 'cluster'), tools);
  closers.push(() => cluster.close());
  cluster.run(readFileSync(ROLES_SQL, 'utf8'));
  cluster.run(ROLE_LOGINS);
  const data = path.join(cluster.root, 'data');
  copyFileSync(PEER_HOST_HBA, path.join(data, 'pg_hba.conf'));
  const account = os.userInfo().username;
  writeFileSync(path.join(data, 'pg_ident.conf'), ['postgres', OWNER, 'noticeos_maint'].map((role) => `noticeos ${account} ${role}\n`).join(''));
  cluster.sql('SELECT pg_reload_conf()');
  // Loaded once the application may no longer use the socket, which the map
  // does not give this account.
  const application = checkedSession({ host: cluster.socketDir, dbname: 'postgres', user: 'noticeos_app' }, { where: 'the application on the socket', tools });
  const why = [];
  assert.ok(await eventually(() => !answers(application, why)), 'the peer rules took effect');
  assert.match(why.at(-1), /Peer authentication failed for user "noticeos_app"/u);
  hostCluster = { ...cluster, tools };
  return hostCluster;
}

let databases = 0;
/**
 * A new database on the host cluster as the Compose profile's first start
 * makes one (db/postgres/host/first-start.sh): owned by noticeos_owner (or
 * `owner`), CONNECT taken from PUBLIC and given to the application and
 * maintenance roles. `admin` is the superuser's session on it
 * (a peer login too); `flags` name it to the command.
 */
async function hostDatabase({ owner = OWNER, development = false } = {}) {
  const cluster = await host();
  databases += 1;
  const name = `noticeos_${databases}`;
  const builtin = cluster.tools.major >= 17 ? " LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'" : '';
  cluster.sql(`CREATE DATABASE ${name} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8'${builtin}`);
  cluster.sql(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);
  cluster.sql(`GRANT CONNECT ON DATABASE ${name} TO noticeos_app, noticeos_maint${owner === OWNER ? '' : `, ${OWNER}`}`);
  if (development) cluster.sql(`ALTER DATABASE ${name} SET noticeos.profile = 'development'`);
  return {
    name,
    admin: socketSession({ tools: cluster.tools, socketDir: cluster.socketDir, database: name }),
    flags: ['--database', name, '--socket', cluster.socketDir],
    socketDir: cluster.socketDir,
  };
}

/** Everything a run could change in a database, read as the superuser: its
 * objects and their owners, schemas, functions, the database's own grants,
 * the roles, and the migration records and workspaces where they exist. */
function fingerprint(admin) {
  return admin.text(`SELECT concat_ws(' | ',
  (SELECT string_agg(format('%s.%s:%s:%s', n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner)), ',' ORDER BY n.nspname, c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'),
  (SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace),
  (SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')),
  (SELECT datacl::text FROM pg_database WHERE datname = current_database()),
  (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'noticeos_%'),
  CASE WHEN to_regclass('noticeos_migrations.applied') IS NULL THEN 'no records'
       ELSE query_to_xml('SELECT version, name, sha256, applied_at, applied_by FROM noticeos_migrations.applied ORDER BY version', false, false, '')::text END,
  CASE WHEN to_regclass('noticeos.workspaces') IS NULL THEN 'no workspaces'
       ELSE query_to_xml('SELECT workspace_id, slug FROM noticeos.workspaces ORDER BY created_at', false, false, '')::text END
)`);
}

test('status only reads, and says what apply would do and what stops it', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    const before = fingerprint(db.admin);

    const status = run(['status', ...db.flags], { frozen: FROZEN_REAL });
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, new RegExp(`^${db.name} on the local socket in \\S+: PostgreSQL \\d+\\.\\d+.*, as noticeos_owner$`, 'mu'));
    for (const name of REAL) assert.match(status.out, new RegExp(`^  pending\\s+${name}$`, 'mu'));
    assert.match(status.out, /^Workspaces: none \(no schema yet\)$/mu);
    assert.match(status.out, new RegExp(`^${REAL.length} pending\\. To apply: pnpm os:migrate -- --apply --database ${db.name} --socket \\S+$`, 'mu'));

    // Nothing frozen: status says so, and what to run, and exits 1.
    const unfrozen = run(['status', ...db.flags], { frozen: '' });
    assert.equal(unfrozen.code, 1);
    assert.match(unfrozen.out, new RegExp(`^  pending\\s+${REAL[0]}  \\(not frozen\\)$`, 'mu'));
    assert.match(unfrozen.out, new RegExp(`shasum -a 256 migrations/${REAL[0]}\\.sql >> frozen-migrations\\.sha256`, 'u'));

    const json = run(['status', ...db.flags, '--json'], { frozen: FROZEN_REAL });
    assert.deepEqual(JSON.parse(json.out).migrations.map((m) => m.state), REAL.map(() => 'pending'));
    assert.equal(fingerprint(db.admin), before, 'status wrote nothing');
  });
});

test('apply prints its plan first, and changes nothing until the database is named again, or while a migration is not frozen', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    const before = fingerprint(db.admin);

    const unconfirmed = run(['apply', ...db.flags], { frozen: FROZEN_REAL });
    assert.equal(unconfirmed.code, 2);
    assert.match(unconfirmed.out, new RegExp(`^  pending\\s+${REAL[0]}$`, 'mu'), 'the plan comes first');
    assert.match(unconfirmed.err, new RegExp(`nothing was changed\\. To go ahead, type the database's name again: pnpm os:migrate -- --apply --database ${db.name} --socket \\S+ --confirm ${db.name}`, 'u'));

    const other = run(['apply', ...db.flags, '--confirm', 'noticeos'], { frozen: FROZEN_REAL });
    assert.equal(other.code, 2);
    assert.match(other.err, new RegExp(`--confirm names "noticeos", not ${db.name}\\. Nothing was changed\\.`, 'u'));

    // A migration not frozen yet is never applied to a real database.
    const unfrozen = run(['apply', ...db.flags, '--confirm', db.name], { frozen: '' });
    assert.equal(unfrozen.code, 2);
    assert.match(unfrozen.out, /✗ not frozen yet/u);
    assert.match(unfrozen.err, /nothing was applied/u);

    // Nor one past the frozen ones.
    const dir = migrationsWith({ [`${numbered()}_later.sql`]: 'CREATE TABLE noticeos_later (x int);\n' });
    const partly = run(['apply', ...db.flags, '--confirm', db.name], { frozen: frozenFor(dir, REAL.length), dir });
    assert.equal(partly.code, 2);
    assert.match(partly.out, new RegExp(`✗ not frozen yet: ${numbered()}_later\\.`, 'u'));
    assert.equal(fingerprint(db.admin), before, 'nothing was changed');
  });
});

test('apply runs as the owner over the socket, records each file by hash, leaves the database grants as they were, and a second apply changes nothing', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    const [grants] = db.admin.sql(`SELECT datacl::text AS acl FROM pg_database WHERE datname = '${db.name}'`);

    const applied = run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL });
    assert.equal(applied.code, 0, applied.err);
    for (const name of REAL) assert.match(applied.out, new RegExp(`^  applied\\s+${name}$`, 'mu'));
    assert.match(applied.out, new RegExp(`^Applied ${REAL.length} migrations? to ${db.name} on the local socket in \\S+, in one transaction\\.$`, 'mu'));
    assert.match(applied.out, new RegExp(`^Next, its one workspace: pnpm os:migrate -- --bootstrap --database ${db.name} --socket \\S+ --slug main --name "My sites"$`, 'mu'));

    const records = db.admin.sql('SELECT name, sha256, applied_by, applied_at FROM noticeos_migrations.applied ORDER BY version');
    assert.deepEqual(
      records.map((row) => [row.name, row.sha256, row.applied_by]),
      REAL.map((name) => [name, sha256Of(path.join(MIGRATIONS_DIR, `${name}.sql`)), OWNER]),
    );
    const [owners] = db.admin.sql(
      "SELECT string_agg(DISTINCT pg_get_userbyid(c.relowner), ',') AS owners FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('noticeos', 'noticeos_ref', 'noticeos_migrations') AND c.relkind IN ('r', 'v')",
    );
    assert.equal(owners.owners, OWNER);
    const [after] = db.admin.sql(`SELECT datacl::text AS acl FROM pg_database WHERE datname = '${db.name}'`);
    assert.equal(after.acl, grants.acl, "the database's own grants are as its first start left them");

    const done = fingerprint(db.admin);
    const again = run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL });
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /^Up to date; nothing applied\.$/mu);
    assert.equal(fingerprint(db.admin), done, 'a second apply changes nothing');

    const status = run(['status', ...db.flags], { frozen: FROZEN_REAL });
    assert.equal(status.code, 0, status.err);
    for (const name of REAL) assert.match(status.out, new RegExp(`^  applied\\s+${name}  \\(\\d{4}-\\d\\d-\\d\\dT`, 'mu'));
    assert.match(status.out, /^Workspaces: none yet$/mu);
    assert.match(status.out, /^Up to date\.$/mu);
  });
});

test('a failing migration leaves the database exactly as it was, and names the migration', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    const dir = migrationsWith({
      [`${numbered()}_breaks.sql`]: 'CREATE TABLE noticeos.half_made (workspace_id uuid PRIMARY KEY);\nSELECT 1 / 0;\n',
    });
    const frozen = frozenFor(dir);

    const empty = fingerprint(db.admin);
    const whole = run(['apply', ...db.flags, '--confirm', db.name], { frozen, dir });
    assert.equal(whole.code, 1);
    assert.match(whole.err, new RegExp(`${numbered()}_breaks failed; the whole run was rolled back, nothing was applied`, 'u'));
    assert.match(whole.err, /division by zero/u);
    assert.equal(fingerprint(db.admin), empty, 'the baseline in the same run was rolled back too');

    assert.equal(run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL }).code, 0);
    const applied = fingerprint(db.admin);
    const next = run(['apply', ...db.flags, '--confirm', db.name], { frozen, dir });
    assert.equal(next.code, 1);
    assert.match(next.err, new RegExp(`${numbered()}_breaks failed`, 'u'));
    assert.equal(fingerprint(db.admin), applied, 'the applied migrations are as they were');
  });
});

test('a recorded migration that changed or is gone, or a frozen one that changed, stops the run before it writes', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    assert.equal(run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL }).code, 0);
    const applied = fingerprint(db.admin);

    const edited = migrationsWith();
    const baseline = path.join(edited, `${REAL[0]}.sql`);
    writeFileSync(baseline, `${readFileSync(baseline, 'utf8')}\n-- edited after a real database applied it\n`);
    const changed = run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL, dir: edited });
    assert.equal(changed.code, 2);
    assert.match(changed.out, new RegExp(`✗ ${REAL[0]} is recorded here with another hash`, 'u'));
    assert.match(changed.out, new RegExp(`✗ ${REAL[0]}\\.sql changed after it was frozen`, 'u'));
    assert.equal(run(['status', ...db.flags], { frozen: FROZEN_REAL, dir: edited }).code, 1);

    const gone = run(['apply', ...db.flags, '--confirm', db.name], { frozen: '', dir: tempDir('nos-apply-none-') });
    assert.equal(gone.code, 2);
    assert.match(gone.out, new RegExp(`✗ ${REAL[0]} is recorded here, but its file is gone`, 'u'));
    assert.equal(fingerprint(db.admin), applied);
  });
});

test('a second run is refused, not queued, while another holds the lock, and goes ahead once it is released', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    const holder = db.admin.spawnInteractive();
    const released = new Promise((resolve) => holder.on('exit', resolve));
    await new Promise((resolve, reject) => {
      let seen = '';
      holder.stdout.on('data', (chunk) => {
        seen += chunk;
        if (seen.includes('holding')) resolve();
      });
      holder.on('exit', () => reject(new Error(`the lock holder exited early: ${seen}`)));
      holder.stdin.write(`SELECT pg_advisory_lock(${LOCK_KEY});\n\\echo holding\n`);
    });
    const before = fingerprint(db.admin);
    try {
      const refused = run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL });
      assert.equal(refused.code, 2);
      assert.match(refused.err, /another migration run holds the lock; nothing was applied/u);
      assert.equal(fingerprint(db.admin), before);
    } finally {
      holder.stdin.end();
      await released;
    }
    assert.equal(run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL }).code, 0);
  });
});

test('a development database, and one the owner may not build in, are refused before any write', async (t) => {
  await live(t, async () => {
    const marked = await hostDatabase({ development: true });
    const before = fingerprint(marked.admin);
    const refused = run(['apply', ...marked.flags, '--confirm', marked.name], { frozen: FROZEN_REAL });
    assert.equal(refused.code, 2);
    assert.match(refused.err, /is marked for development \(noticeos\.profile = 'development'\); use pnpm db:try-migrations for it\. Nothing was written\./u);
    assert.equal(fingerprint(marked.admin), before);

    const foreign = await hostDatabase({ owner: 'postgres' });
    const untouched = fingerprint(foreign.admin);
    const blocked = run(['apply', ...foreign.flags, '--confirm', foreign.name], { frozen: FROZEN_REAL });
    assert.equal(blocked.code, 2);
    assert.match(blocked.out, /✗ noticeos_owner may not create schemas in noticeos_\d+: make it the database's owner, as the Postgres service's first start does \(db\/postgres\/host\/first-start\.sh\)/u);
    assert.equal(fingerprint(foreign.admin), untouched);
  });
});

/** The command in a process of its own (the real migrations and frozen list). */
function command(argv) {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postgres-apply.mjs'), ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, err })));
}

test('bootstrap creates the one workspace once, as the owner, after the migrations, and two at once cannot both create one', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    const first = run(['bootstrap', ...db.flags, '--confirm', db.name, '--slug', 'main'], { frozen: FROZEN_REAL });
    assert.equal(first.code, 2);
    assert.match(first.err, new RegExp(`apply the migrations first: pnpm os:migrate -- --apply --database ${db.name} --socket \\S+`, 'u'));
    assert.equal(run(['apply', ...db.flags, '--confirm', db.name], { frozen: FROZEN_REAL }).code, 0);

    const unconfirmed = run(['bootstrap', ...db.flags, '--slug', 'main'], { frozen: FROZEN_REAL });
    assert.equal(unconfirmed.code, 2);
    assert.match(unconfirmed.err, /--confirm/u);
    assert.equal(db.admin.text('SELECT count(*) FROM noticeos.workspaces').trim(), '0');

    // Two bootstraps at once, each in its own process: both wait on the
    // bootstrap's lock while a session holds it (the lock
    // scripts/postgres-migrate.mjs bootstrapWorkspace takes), then run one
    // after the other: one creates, the other finds it.
    const holder = db.admin.spawnInteractive();
    const released = new Promise((resolve) => holder.on('exit', resolve));
    await new Promise((resolve, reject) => {
      let seen = '';
      holder.stdout.on('data', (chunk) => {
        seen += chunk;
        if (seen.includes('holding')) resolve();
      });
      holder.on('exit', () => reject(new Error(`the lock holder exited early: ${seen}`)));
      holder.stdin.write("SELECT pg_advisory_lock(hashtextextended('noticeos.bootstrap', 0));\n\\echo holding\n");
    });
    let both;
    try {
      both = [
        command(['bootstrap', ...db.flags, '--confirm', db.name, '--slug', 'main', '--name', 'My sites']),
        command(['bootstrap', ...db.flags, '--confirm', db.name, '--slug', 'other']),
      ];
      const waiting = () =>
        Number(
          db.admin
            .text(`SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = '${db.name}'`)
            .trim(),
        ) === 2;
      assert.ok(await eventually(waiting, 30_000), 'both bootstraps wait on the lock');
    } finally {
      holder.stdin.end();
      await released;
    }
    const results = await Promise.all(both);
    for (const result of results) assert.equal(result.code, 0, result.err);
    const created = results.map((result) => /now has its one workspace: ([0-9a-f-]{36})$/mu.exec(result.out)?.[1]).filter(Boolean);
    const found = results.map((result) => /already has its workspace: ([0-9a-f-]{36})$/mu.exec(result.out)?.[1]).filter(Boolean);
    assert.equal(created.length, 1, results.map((result) => result.out).join('\n'));
    assert.deepEqual(found, created, 'the second found the first one');
    const rows = db.admin.sql('SELECT workspace_id FROM noticeos.workspaces');
    assert.deepEqual(rows.map((row) => row.workspace_id), created, 'exactly one workspace');

    const again = run(['bootstrap', ...db.flags, '--confirm', db.name, '--slug', 'main'], { frozen: FROZEN_REAL });
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, new RegExp(`already has its workspace: ${created[0]}$`, 'mu'));
    assert.match(run(['status', ...db.flags], { frozen: FROZEN_REAL }).out, /^Workspaces: 1$/mu);
  });
});

// ─── Live: psql alone on the machine ───────────────────────────────────────

test('with psql alone, no initdb or pg_ctl, status reaches the server and prints its plan; a throwaway cluster still needs the server binaries', async (t) => {
  await live(t, async () => {
    const db = await hostDatabase();
    const full = findPostgres();
    const psqlAlone = { psql: full.psql, version: full.version, major: full.major };
    const status = run(['status', ...db.flags], { tools: psqlAlone, frozen: FROZEN_REAL });
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, new RegExp(`^${db.name} on the local socket in .*: PostgreSQL .*, as noticeos_owner$`, 'mu'));
    assert.match(status.out, /^ {2}pending +0001_baseline$/mu);

    // A machine whose PATH holds psql and nothing else of Postgres: the command as the operator runs it.
    const bin = tempDir('nos-apply-psql-alone-');
    symlinkSync(full.psql, path.join(bin, 'psql'));
    symlinkSync(['/usr/bin/which', '/bin/which'].find((file) => existsSync(file)), path.join(bin, 'which'));
    const env = { PATH: bin, HOME: os.homedir() };
    const found = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import { findPsql, findPostgres } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'postgres-dev.mjs')).href)}; console.log(JSON.stringify({ psql: findPsql()?.psql ?? null, server: findPostgres() }));`],
      { env, encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(found.stdout), { psql: path.join(bin, 'psql'), server: null }, found.stderr);
    // The committed list freezes the baseline, so the command as the operator
    // runs it, with no list handed in, finds the baseline pending and
    // applicable, and reads no "not frozen" against it.
    const child = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postgres-apply.mjs'), 'status', ...db.flags], { cwd: REPO_ROOT, env, encoding: 'utf8' });
    assert.equal(child.status, 0, `the committed list freezes the baseline, so status prints its plan: ${child.stderr}`);
    assert.match(child.stdout, /, as noticeos_owner$/mu);
    assert.match(child.stdout, /^ {2}pending +0001_baseline$/mu);
    assert.doesNotMatch(child.stdout, /not frozen/u);

    // The development profile still starts a throwaway cluster only with initdb and pg_ctl.
    const dir = path.join(tempDir('nos-apply-psql-alone-cluster-'), 'cluster');
    assert.throws(() => openThrowaway(dir, psqlAlone), (error) => error instanceof PostgresUnavailable && /no Postgres server binaries \(initdb, pg_ctl, psql\)/u.test(error.message));
    assert.equal(existsSync(dir), false, 'nothing was created');
  });
});

// ─── Live: a host that needs a password ─────────────────────────────────────

test('a host that needs a password: the owner URL comes from the variable named, works over TCP, and neither it nor a wrong one is repeated', async (t) => {
  await live(t, async () => {
    const tools = findPostgres();
    if (!tools) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    const cluster = await openOnLoopbackPort(path.join(tempDir('nos-apply-tcp-'), 'cluster'), tools);
    const port = cluster.loopbackPort;
    closers.push(() => cluster.close());
    cluster.run(readFileSync(ROLES_SQL, 'utf8'));
    cluster.run(ROLE_LOGINS);
    const password = randomBytes(24).toString('base64url');
    cluster.run(`ALTER ROLE ${OWNER} PASSWORD '${scramVerifier(password)}';\n`);
    // Beside what loopback mode admits: the owner, from this machine, by that password.
    appendFileSync(path.join(cluster.root, LOOPBACK_HBA), `host all ${OWNER} 127.0.0.1/32 scram-sha-256\n`);
    cluster.sql('SELECT pg_reload_conf()');
    const name = 'noticeos_tcp';
    cluster.sql(`CREATE DATABASE ${name} OWNER ${OWNER} TEMPLATE template0 ENCODING 'UTF8'`);
    const admin = cluster.onDatabase(name);

    const url = (secret) => `postgresql://${OWNER}:${secret}@127.0.0.1:${port}/${name}?sslmode=disable`;
    const flags = ['--database', name, '--url-from', 'NOTICEOS_TEST_OWNER_URL'];
    const env = { NOTICEOS_TEST_OWNER_URL: url(password) };
    const ready = await eventually(() => run(['status', ...flags], { env, frozen: FROZEN_REAL }).code === 0);
    assert.ok(ready, 'the owner logs in over TCP by its password');

    const applied = run(['apply', ...flags, '--confirm', name], { env, frozen: FROZEN_REAL });
    assert.equal(applied.code, 0, applied.err);
    assert.match(applied.out, new RegExp(`^Applied ${REAL.length} migrations? to ${name} on 127\\.0\\.0\\.1:${port} \\(from NOTICEOS_TEST_OWNER_URL\\), in one transaction\\.$`, 'mu'));
    assert.equal(`${applied.out}${applied.err}`.includes(password), false);
    assert.deepEqual(
      admin.sql('SELECT DISTINCT applied_by FROM noticeos_migrations.applied').map((row) => row.applied_by),
      [OWNER],
    );

    const wrong = randomBytes(24).toString('base64url');
    const refused = run(['status', ...flags], { env: { NOTICEOS_TEST_OWNER_URL: url(wrong) }, frozen: FROZEN_REAL });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /password authentication failed for user "noticeos_owner"/u);
    for (const secret of [password, wrong]) assert.equal(`${refused.out}${refused.err}`.includes(secret), false);

    // A variable it was not told to read is never read.
    const unnamed = run(['status', '--database', name, '--url-from', 'NOTICEOS_OTHER_URL'], { env, frozen: FROZEN_REAL });
    assert.equal(unnamed.code, 2);
    assert.match(unnamed.err, /NOTICEOS_OTHER_URL is not set here/u);
  });
});
