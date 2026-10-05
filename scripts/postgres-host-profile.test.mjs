import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../packages/postgres/src/store.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { main as migrate } from './postgres-apply.mjs';
import {
  LOOPBACK_HBA,
  MODEL_DIR,
  PostgresUnavailable,
  PsqlError,
  ROLES_SQL,
  checkedSession,
  findPostgres,
  migrationFiles,
  openThrowaway,
  psqlEnvironment,
} from './postgres-dev.mjs';
import { URLS, VERIFIERS, writeSecrets } from './postgres-secrets.mjs';
import { localDocker } from './postgres-compose.mjs';
import { runCommand } from './run-command.mjs';
import { prepareFreshPostgres, startPostgresPlan } from './start-postgres.mjs';
import { startPlan } from './start.mjs';

// THE INSTALLATION'S POSTGRES AS A COMPOSE SERVICE (bead ro-ujb9.76.12):
// db/postgres/host/. What needs a container app is proven by
// docs/artifacts/postgres-host/compose-proof-2026-09-29.mjs; this holds the
// rest, in every `pnpm test:scripts`:
//
//   - STATIC, always: compose.yaml publishes one port on 127.0.0.1 and no
//     other address, runs the pinned multi-architecture PostgreSQL 18 with
//     query statistics and the builtin C.UTF-8 order, keeps its data on a
//     named volume whose name follows the project (so a test project never
//     shares an installation's), comes back by itself, takes every secret as
//     a file `pnpm postgres:secrets` writes and none as a value, and names no
//     path of one machine; pg_hba.conf lets the superuser in on the
//     container's own socket only and the three NoticeOS logins over TCP only
//     to noticeos, only by password; first-start.sh refuses a secret that is
//     not a verifier before it creates anything, and is executable; git
//     ignores the secrets folder.
//   - LIVE, on a throwaway cluster: first-start.sh builds the roles, their
//     logins, the database and query statistics as the image runs it, the
//     profile's pg_hba.conf then decides who gets in, and `pnpm
//     postgres:migrate` runs with psql alone (bead ro-ujb9.76.39) by the URL
//     `pnpm postgres:secrets` wrote, then DATABASE_URL reaches the one
//     workspace through the Workers' store helper. No password is in the
//     query statistics, their text file or the server's log.

const HOST_DIR = path.join(MODEL_DIR, 'host');
const COMPOSE = readFileSync(path.join(HOST_DIR, 'compose.yaml'), 'utf8');
const PROFILE_HBA = path.join(HOST_DIR, 'pg_hba.conf');
const FIRST_START = path.join(HOST_DIR, 'first-start.sh');

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
const closers = [];
after(() => {
  for (const close of closers.reverse()) close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** compose.yaml's lines without comments, trimmed. */
const composeLines = COMPOSE.split('\n').map((line) => line.replace(/\s+#.*$/u, '')).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
/** The indented list under `key:` in the postgres service: its items, unquoted. */
function listUnder(key) {
  const start = composeLines.findIndex((line) => line === `    ${key}:`);
  assert.ok(start >= 0, `compose.yaml's service has ${key}`);
  const items = [];
  for (const line of composeLines.slice(start + 1)) {
    if (!line.startsWith('      - ')) break;
    items.push(line.slice('      - '.length));
  }
  return items;
}
const serviceValue = (key) => composeLines.find((line) => line.startsWith(`    ${key}: `))?.slice(`    ${key}: `.length) ?? null;

test('the current pinned Compose image initializes its versioned data volume and keeps the fresh store after restart', {
  skip: process.env.NOTICEOS_TEST_POSTGRES_HOST_COMPOSE !== '1', timeout: 300_000,
}, async t => {
  const parent = tempDir('nos-current-compose-');
  const plan = startPlan({ root: REPO_ROOT, dir: path.join(parent, 'installation'), port: 5799 });
  const own = startPostgresPlan(plan);
  assert.equal(own.port, 5801, 'this proof uses its assigned disposable port');
  const env = { ...process.env, NOTICEOS_POSTGRES_SECRETS: own.secrets, NOTICEOS_POSTGRES_PORT: String(own.port) };
  assert.equal(await localDocker(runCommand, { cwd: REPO_ROOT, env }), true, 'only a selected local container endpoint is allowed');
  const args = ['compose', '-p', own.project, '-f', own.compose, '--env-file', os.devNull];
  const execute = more => runCommand('docker', [...args, ...more], { cwd: REPO_ROOT, env, timeoutMs: 240_000 });
  t.after(async () => {
    // The fresh helper writes this only after refusing existing projects and
    // volumes. A refusal before reservation owns no resources to remove.
    if (!existsSync(plan.mark)) return;
    const down = await execute(['down', '--volumes']);
    assert.equal(down.code, 0, 'the owned project and data volume were removed');
  });
  const prepared = await prepareFreshPostgres(plan);
  assert.equal(prepared.ok, true, prepared.line);
  assert.equal(prepared.created, true);
  const query = async sql => {
    const result = await execute(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'noticeos', '-At', '--no-password', '-c', sql]);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const state = await query(`SELECT json_build_object('version', current_setting('server_version'), 'provider', datlocprovider, 'locale', datlocale,
    'data', current_setting('data_directory'), 'checksums', current_setting('data_checksums'),
    'workspaces', (SELECT count(*) FROM noticeos.workspaces), 'statistics', current_setting('shared_preload_libraries'))
    FROM pg_database WHERE datname = current_database()`);
  const measured = JSON.parse(state);
  assert.match(measured.version, /^18\.6(?:\s|$)/u);
  assert.deepEqual({ ...measured, version: '18.6' }, { version: '18.6', provider: 'b', locale: 'C.UTF-8', data: '/var/lib/postgresql/18/docker', checksums: 'on', workspaces: 1, statistics: 'pg_stat_statements' });
  const ordered = await query("SELECT string_agg(value, ',' ORDER BY value) FROM (VALUES ('中'), ('é'), ('Z'), ('Ω'), ('ä'), ('a'), ('A')) AS sample(value)");
  assert.equal(ordered, 'A,Z,a,ä,é,Ω,中');
  const before = await query('SELECT workspace_id, slug, display_name, created_at FROM noticeos.workspaces');
  assert.equal((await execute(['restart', 'postgres'])).code, 0);
  assert.equal((await execute(['up', '--detach', '--wait', '--wait-timeout', '180', 'postgres'])).code, 0);
  assert.equal(await query('SELECT workspace_id, slug, display_name, created_at FROM noticeos.workspaces'), before);
  assert.equal(await query('SHOW data_directory'), measured.data);
  t.diagnostic(JSON.stringify({ project: own.project, image: serviceValue('image'), ...measured, ordered, restartPreservedWorkspace: true }));
});

// ─── Static ─────────────────────────────────────────────────────────────────

test('compose.yaml publishes one port, on 127.0.0.1 alone, and nothing else of the container', () => {
  assert.deepEqual(listUnder('ports'), ['127.0.0.1:${NOTICEOS_POSTGRES_PORT:-5432}:5432']);
  assert.equal(composeLines.filter((line) => /^\s+ports:/u.test(line)).length, 1, 'one service publishes');
  assert.equal(composeLines.some((line) => /network_mode|privileged|cap_add|expose:|extra_hosts/u.test(line)), false);
});

test('compose.yaml runs pinned PostgreSQL 18.6 from the official multi-architecture image, with query statistics and the builtin C.UTF-8 order', () => {
  assert.match(serviceValue('image'), /^postgres:18\.6@sha256:[0-9a-f]{64}$/u);
  const command = listUnder('command');
  assert.equal(command[0], 'postgres');
  for (const setting of ['hba_file=/etc/noticeos/pg_hba.conf', 'shared_preload_libraries=pg_stat_statements', 'timezone=UTC']) {
    assert.ok(command.includes(setting), setting);
  }
  const initdb = composeLines.find((line) => line.includes('POSTGRES_INITDB_ARGS:'));
  for (const argument of ['--encoding=UTF8', '--locale-provider=builtin', '--locale=C.UTF-8', '--data-checksums']) assert.ok(initdb.includes(argument), argument);
  assert.match(listUnder('healthcheck').join(' ') || composeLines.find((line) => line.includes('pg_isready')), /pg_isready.*--host=127\.0\.0\.1.*--dbname=noticeos/u, 'healthy once the server answers on TCP, not during the first start');
});

test('compose.yaml keeps the data on a named volume that follows the project name, and comes back by itself', () => {
  assert.equal(composeLines[0], 'name: noticeos', 'the project is named, so its volume is noticeos_postgres-data wherever the file runs from');
  assert.ok(listUnder('volumes').includes('postgres-data:/var/lib/postgresql'));
  assert.ok(!listUnder('volumes').includes('postgres-data:/var/lib/postgresql/data'), 'the official 18+ image keeps its versioned PGDATA under the volume root');
  const volumes = composeLines.findIndex((line) => line === 'volumes:');
  assert.equal(composeLines[volumes + 1], '  postgres-data: {}', 'no fixed volume name: a test project (-p) never shares an installation’s volume');
  assert.equal(composeLines.some((line) => /container_name/u.test(line)), false);
  assert.equal(serviceValue('restart'), 'unless-stopped');
  assert.equal(serviceValue('init'), 'true', 'a crashed server ends the container, which the restart policy brings back');
  assert.equal(serviceValue('stop_grace_period'), '60s');
});

test('compose.yaml takes every secret as a file pnpm postgres:secrets writes, and none as a value', () => {
  assert.deepEqual(listUnder('secrets'), VERIFIERS);
  const topLevel = composeLines.indexOf('secrets:');
  assert.ok(topLevel > 0, 'the top-level secrets');
  for (const name of VERIFIERS) {
    const at = composeLines.indexOf(`  ${name}:`, topLevel);
    assert.ok(at > 0, `top-level secret ${name}`);
    assert.equal(composeLines[at + 1], `    file: \${NOTICEOS_POSTGRES_SECRETS:-./secrets}/${name}`);
  }
  assert.ok(composeLines.includes('      POSTGRES_PASSWORD_FILE: /run/secrets/postgres'));
  assert.equal(composeLines.some((line) => /POSTGRES_PASSWORD:|POSTGRES_HOST_AUTH_METHOD|PASSWORD=/u.test(line)), false);
});

test('compose.yaml mounts only files of this folder and the roles, and names no path of one machine', () => {
  const mounts = listUnder('volumes').filter((mount) => !mount.startsWith('postgres-data:'));
  assert.deepEqual(mounts, [
    './pg_hba.conf:/etc/noticeos/pg_hba.conf:ro',
    '../roles.sql:/etc/noticeos/roles.sql:ro',
    './first-start.sh:/docker-entrypoint-initdb.d/10-noticeos.sh:ro',
  ]);
  for (const mount of mounts) assert.ok(existsSync(path.resolve(HOST_DIR, mount.split(':')[0])), mount);
  assert.equal(/\/Users\/|\/home\/|[A-Z]:\\/u.test(COMPOSE), false);
});

test('pg_hba.conf: the superuser on the container’s own socket only; the three logins over TCP, only to noticeos, only by password', () => {
  const rules = readFileSync(PROFILE_HBA, 'utf8').split('\n').filter((line) => line.trim() && !line.startsWith('#')).map((line) => line.trim().split(/\s+/u));
  assert.deepEqual(rules, [
    ['local', 'all', 'postgres', 'trust'],
    ['host', 'noticeos', 'noticeos_app', 'all', 'scram-sha-256'],
    ['host', 'noticeos', 'noticeos_owner', 'all', 'scram-sha-256'],
    ['host', 'noticeos', 'noticeos_maint', 'all', 'scram-sha-256'],
  ]);
});

test('first-start.sh is executable, sets passwords only from the verifier files, and refuses a secret that is not a verifier before it creates anything', () => {
  const index = spawnSync('git', ['ls-files', '-s', 'db/postgres/host/first-start.sh'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (index.stdout.trim()) assert.match(index.stdout, /^100755 /u, 'git keeps its executable bit');
  const script = readFileSync(FIRST_START, 'utf8');
  assert.equal(/PASSWORD\s+'/iu.test(script), false, 'no password written into a statement');
  assert.equal((script.match(/LOGIN PASSWORD :'verifier';/gu) ?? []).length, 3);

  const secrets = tempDir('nos-first-start-');
  const plain = `plain-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16)}`;
  writeFileSync(path.join(secrets, 'noticeos_owner'), `${plain}\n`);
  // No psql on PATH: a run that got past the check would fail differently.
  const result = spawnSync('bash', [FIRST_START], { env: { PATH: '/usr/bin:/bin', NOTICEOS_SECRETS_DIR: secrets }, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /noticeos_owner is not a SCRAM-SHA-256 verifier; make the secret files with pnpm postgres:secrets/u);
  assert.equal(`${result.stdout}${result.stderr}`.includes(plain), false, 'the value is never repeated');
});

test('git ignores the secrets folder pnpm postgres:secrets writes', () => {
  const ignored = spawnSync('git', ['check-ignore', '-q', 'db/postgres/host/secrets/database.url'], { cwd: REPO_ROOT });
  assert.equal(ignored.status, 0);
});

// ─── Live, on a throwaway cluster ──────────────────────────────────────────

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

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Rows of `sql` as `login` over TCP, or psql's refusal. */
function over(tcp, login, database, password, sql = 'SELECT session_user AS login, current_database() AS database') {
  try {
    return tcp(login, database, password).sql(sql);
  } catch (error) {
    if (error instanceof PsqlError) return error.message;
    throw error;
  }
}

/** Every real migration frozen: what the committed list holds once the baseline is frozen. */
const FROZEN_REAL = migrationFiles()
  .map((file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  migrations/${path.basename(file)}\n`)
  .join('');

test('the first start and pg_hba.conf on a throwaway cluster: the logins, what is refused, pnpm postgres:migrate with psql alone, DATABASE_URL, and no password kept anywhere', async (t) => {
  await live(t, async () => {
    const tools = findPostgres();
    if (!tools) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    const port = await freePort();
    const cluster = openThrowaway(path.join(tempDir('nos-profile-'), 'cluster'), tools, { loopbackPort: port });
    closers.push(() => cluster.close());
    if (!cluster.queryStatistics) throw new PostgresUnavailable('this server build has no pg_stat_statements, which the profile turns on');
    const secrets = path.join(tempDir('nos-profile-secrets-'), 'secrets');
    mkdirSync(path.dirname(secrets), { recursive: true });
    writeSecrets(secrets, { port });
    const passwords = Object.fromEntries(Object.entries(URLS).map(([name, login]) => [login, decodeURIComponent(new URL(readFileSync(path.join(secrets, name), 'utf8').trim()).password)]));

    // The image's entrypoint runs it as the superuser on the socket; so does this.
    const first = spawnSync('bash', [FIRST_START], {
      env: {
        ...psqlEnvironment(),
        PATH: `${path.dirname(tools.psql)}:${process.env.PATH}`,
        PGHOST: cluster.socketDir,
        PGPORT: String(port),
        NOTICEOS_SECRETS_DIR: secrets,
        NOTICEOS_ROLES_SQL: ROLES_SQL,
      },
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);

    // The profile's rules in place of the loopback mode's.
    writeFileSync(path.join(cluster.root, LOOPBACK_HBA), readFileSync(PROFILE_HBA));
    cluster.sql('SELECT pg_reload_conf()');
    const psqlOnly = { psql: tools.psql, version: tools.version, major: tools.major };
    const tcp = (login, database, password) =>
      checkedSession({ host: '127.0.0.1', port: String(port), dbname: database, user: login }, { where: `${login} over TCP`, password, tools: psqlOnly });
    const deadline = Date.now() + 10_000;
    while (typeof over(tcp, 'noticeos_owner', 'noticeos', passwords.noticeos_owner) === 'string' && Date.now() < deadline) await delay(100);

    for (const login of ['noticeos_app', 'noticeos_owner', 'noticeos_maint']) {
      assert.deepEqual(over(tcp, login, 'noticeos', passwords[login]), [{ login, database: 'noticeos' }], login);
    }
    assert.match(over(tcp, 'postgres', 'noticeos', passwords.noticeos_app), /no pg_hba\.conf entry for host "127\.0\.0\.1", user "postgres"/u, 'the superuser never over TCP');
    assert.match(over(tcp, 'noticeos_app', 'postgres', passwords.noticeos_app), /no pg_hba\.conf entry .*database "postgres"/u, 'noticeos only');
    assert.match(over(tcp, 'noticeos_app', 'noticeos', passwords.noticeos_owner), /password authentication failed for user "noticeos_app"/u, 'its own password only');
    assert.deepEqual(
      cluster.onDatabase('postgres').sql("SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname LIKE 'noticeos_%' ORDER BY 1"),
      [
        { rolname: 'noticeos_app', rolcanlogin: 't', rolbypassrls: 'f' },
        { rolname: 'noticeos_identity', rolcanlogin: 'f', rolbypassrls: 'f' },
        { rolname: 'noticeos_maint', rolcanlogin: 't', rolbypassrls: 't' },
        { rolname: 'noticeos_owner', rolcanlogin: 't', rolbypassrls: 'f' },
        { rolname: 'noticeos_platform', rolcanlogin: 'f', rolbypassrls: 'f' },
        { rolname: 'noticeos_service_grant', rolcanlogin: 'f', rolbypassrls: 'f' },
        { rolname: 'noticeos_task_directory', rolcanlogin: 'f', rolbypassrls: 'f' },
      ],
    );
    const [database] = cluster.onDatabase('postgres').sql("SELECT pg_get_userbyid(datdba) AS owner, datacl::text AS acl FROM pg_database WHERE datname = 'noticeos'");
    assert.equal(database.owner, 'noticeos_owner');
    assert.equal(database.acl, '{=T/noticeos_owner,noticeos_owner=CTc/noticeos_owner,noticeos_app=c/noticeos_owner,noticeos_maint=c/noticeos_owner}');
    assert.deepEqual(cluster.onDatabase('noticeos').sql("SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements'"), [{ extname: 'pg_stat_statements' }]);

    // The operator's commands, with psql alone and the URL the secrets command wrote.
    const env = { NOTICEOS_OWNER_URL: readFileSync(path.join(secrets, 'owner.url'), 'utf8').trim() };
    const flags = ['--database', 'noticeos', '--url-from', 'NOTICEOS_OWNER_URL'];
    const say = () => {
      const lines = [];
      return { write: (text) => lines.push(text), text: () => lines.join('') };
    };
    const command = (argv) => {
      const out = say();
      const err = say();
      const code = migrate(argv, out, err, { env, frozen: FROZEN_REAL, tools: psqlOnly });
      return { code, out: out.text(), err: err.text() };
    };
    const status = command(['status', ...flags]);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, new RegExp(`^noticeos on 127\\.0\\.0\\.1:${port} \\(from NOTICEOS_OWNER_URL\\): PostgreSQL .*, as noticeos_owner$`, 'mu'));
    assert.equal(command(['apply', ...flags, '--confirm', 'noticeos']).code, 0);
    const made = command(['bootstrap', ...flags, '--confirm', 'noticeos', '--slug', 'main', '--name', 'My sites']);
    assert.equal(made.code, 0, made.err);

    // The Workers' login: DATABASE_URL through their store helper.
    const store = openStore(readFileSync(path.join(secrets, 'database.url'), 'utf8').trim());
    try {
      const workspace = await store.onlyWorkspace();
      const [seen] = await store.inWorkspace(workspace, (tx) => tx.query('SELECT session_user AS login'), { readOnly: true });
      assert.equal(seen.login, 'noticeos_app');
    } finally {
      await store.close();
    }

    // No password where the server keeps text; the logins were set by verifier.
    const statements = cluster.sql('SELECT query FROM pg_stat_statements').map((row) => row.query ?? '');
    const kept = {
      'the query statistics': statements.join('\n'),
      'their text file': readFileSync(path.join(cluster.root, 'data', 'pg_stat_tmp', 'pgss_query_texts.stat'), 'latin1'),
      "the server's log": readFileSync(path.join(cluster.root, 'server.log'), 'utf8'),
      'what the first start printed': `${first.stdout}${first.stderr}`,
    };
    for (const [where, text] of Object.entries(kept)) {
      for (const [login, password] of Object.entries(passwords)) assert.equal(text.includes(password), false, `${login}'s password in ${where}`);
    }
    const roleStatements = statements.filter((query) => /ALTER ROLE noticeos_\w+ LOGIN PASSWORD/u.test(query));
    assert.equal(roleStatements.length, 3);
    for (const query of roleStatements) assert.match(query, /PASSWORD 'SCRAM-SHA-256\$4096:/u);
  });
});
