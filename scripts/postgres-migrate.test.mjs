import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './test-config-isolation.mjs';
import {
  CLUSTER_MARKER,
  DevelopmentProfileRefused,
  MIGRATIONS_DIR,
  PostgresUnavailable,
  PsqlError,
  SERVER_SEGMENT,
  checkDevelopmentUrl,
  createWorkspace,
  findPostgres,
  inWorkspace,
  listSharedMemory,
  migrationFiles,
  openDevelopmentUrl,
  openThrowaway,
  orphanedServerSegments,
  parseCsv,
  parseSegments,
  processAlive,
  psqlEnvironment,
  sweepOrphanedSegments,
} from './postgres-dev.mjs';
import {
  LOCK_KEY,
  MigrationFailed,
  MigrationRefused,
  applyMigrations,
  bootstrapWorkspace,
  createMigration,
  frozenMigrationProblems,
  main,
  migrationStatus,
} from './postgres-migrate.mjs';
import { START_WAIT_MS, parseWatched, stopOwnedServers, whatToDo } from './postgres-watchdog.mjs';

// The Postgres migration runner touches development databases only, and every
// run is one transaction.
//
//   - STATIC, always: which connection strings the development profile refuses
//     before connecting, what a psql child inherits (no PG* settings, no
//     password file), that values never pass through a floating-point number,
//     that `new` writes the next numbered file, that the freeze guard catches
//     an edited frozen migration, and that no runtime, restart or deploy path
//     can reach the runner, nor the operator's command that runs it on a real
//     database, whose checks only the importer may borrow; the guard is shown
//     to catch each way in on a planted checkout. Every case holds for the
//     real migrations however many follow the baseline. And shared memory: the
//     segment listing reads alike on macOS and Linux, only a dead server's
//     segment is ever removed, and where the OS refuses the listing (a
//     sandbox) no server is started to leave one behind. The watchdog stops
//     only a server its folder names as listening in its owner's socket
//     folder, and waits, bounded, for one still starting.
//   - LIVE, on throwaway clusters in temporary folders (skipped with the reason
//     where no Postgres 15+ can start; NOTICEOS_REQUIRE_POSTGRES=1 makes it
//     required): status only reads; apply records each file's hash; a second
//     apply is a no-op; a failing migration rolls the whole run back; an
//     edited migration stops the next run; a second runner is refused while
//     one holds the lock; a workspace transaction commits exactly or not at
//     all, as the application role, with exact numbers and times; a local URL
//     reaches only a database marked for development; a server killed with
//     SIGKILL leaves its segment and the next start removes it; a command
//     interrupted by SIGTERM or SIGINT, or exiting before close(), stops its
//     server and leaves no segment; a command killed with SIGKILL has its
//     server stopped by its watchdog, leaving no segment, even when it is
//     killed while that server is still starting, and a server started again
//     in that folder is left running.

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The real migrations, by name, in order: the baseline and whatever follows it. */
const REAL = migrationFiles().map((file) => path.basename(file, '.sql'));
/** The number `offset` places after the real migrations, as a file prefix. */
const numbered = (offset = 1) => String(REAL.length + offset).padStart(4, '0');
const statesOf = (status) => status.migrations.map((m) => m.state);
const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A migrations folder holding the real migrations, plus `extra` files. */
function migrationsWith(extra = {}) {
  const dir = tempDir('nos-mig-');
  for (const file of migrationFiles()) copyFileSync(file, path.join(dir, path.basename(file)));
  for (const [name, sql] of Object.entries(extra)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

// ─── Static ─────────────────────────────────────────────────────────────────

test('the development profile refuses any connection string that is not local and marked for development, before connecting', () => {
  const refused = {
    'postgresql://db.example.com/noticeos_dev': /not a local database/u,
    'postgresql://10.0.0.5:5432/noticeos_dev': /not a local database/u,
    'postgresql://localhost,db.example.com/noticeos_dev': /not a local database/u,
    'postgresql://localhost/noticeos': /must end in _dev/u,
    'postgresql://localhost/production': /must end in _dev/u,
    'postgresql://localhost/noticeos_dev?hostaddr=10.0.0.5': /hostaddr/u,
    'postgresql://localhost/noticeos_dev?sslmode=disable': /sslmode/u,
    'postgresql://localhost/noticeos_dev?service=prod': /service/u,
    'postgresql:///noticeos_dev?host=relative/folder': /absolute path/u,
    'postgresql:///noticeos_dev': /explicitly/u,
    'mysql://localhost/noticeos_dev': /not a postgres/u,
    'not a url': /not a postgres/u,
  };
  for (const [url, why] of Object.entries(refused)) {
    assert.throws(() => checkDevelopmentUrl(url), (error) => error instanceof DevelopmentProfileRefused && why.test(error.message), url);
  }
  assert.equal(
    checkDevelopmentUrl('postgresql:///noticeos_dev?host=/tmp/dev-socket&user=postgres'),
    "host='/tmp/dev-socket' dbname='noticeos_dev' user='postgres'",
  );
  assert.equal(checkDevelopmentUrl('postgresql://127.0.0.1:7750/scratch_dev'), "host='127.0.0.1' port='7750' dbname='scratch_dev'");
  assert.equal(checkDevelopmentUrl('postgres://me@[::1]/noticeos_dev'), "host='::1' dbname='noticeos_dev' user='me'");
});

test('credential custody: a password is refused and never repeated, and a psql child inherits no connection settings', () => {
  assert.throws(
    () => checkDevelopmentUrl('postgresql://dev:hunter2-secret@localhost/noticeos_dev'),
    (error) => error instanceof DevelopmentProfileRefused && /no password/u.test(error.message) && !error.message.includes('hunter2'),
  );
  assert.throws(
    () => checkDevelopmentUrl('postgresql://localhost/noticeos_dev?user=dev&password=hunter2-secret'),
    (error) => error instanceof DevelopmentProfileRefused && /"password"/u.test(error.message) && !error.message.includes('hunter2'),
  );
  const env = psqlEnvironment({
    HOME: '/home/someone',
    PATH: '/usr/bin',
    PGHOST: 'db.example.com',
    PGPASSWORD: 'hunter2',
    PGSERVICE: 'prod',
    PGSSLMODE: 'disable',
    DATABASE_URL: 'postgres://db.example.com/prod',
  });
  assert.equal(env.HOME, '/home/someone');
  for (const key of ['PGHOST', 'PGPASSWORD', 'PGSERVICE', 'PGSSLMODE', 'DATABASE_URL']) assert.equal(env[key], undefined, key);
  assert.equal(env.PGPASSFILE, os.devNull);
  assert.equal(env.PGSERVICEFILE, os.devNull);

  // No module reads the OS's own secrets or its live store; the operator's
  // command reads only the variable its command line names.
  for (const file of ['postgres-dev.mjs', 'postgres-migrate.mjs', 'postgres-apply.mjs']) {
    const code = readFileSync(path.join(REPO_ROOT, 'scripts', file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/u.test(line))
      .join('\n');
    for (const forbidden of ['.dev.vars', 'dev.secrets', 'wrangler', 'db-migrate', 'process.env.DATABASE_URL', 'CREDENTIALS_KEY', 'OPERATOR_TOKEN']) {
      assert.equal(code.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
  }
});

test('values never pass through a floating-point number, and a workspace transaction checks its arguments before sending anything', () => {
  const never = { run: () => assert.fail('nothing may be sent') };
  const ws = '0000000a-0000-4000-8000-00000000000a';
  assert.throws(() => inWorkspace(never, ws, "SELECT :'x'", { vars: { x: 0.1 } }), /not a safe integer/u);
  assert.throws(() => inWorkspace(never, ws, "SELECT :'x'", { vars: { x: 2 ** 53 + 2 } }), /not a safe integer/u);
  assert.throws(() => inWorkspace(never, ws, "SELECT :'x'", { vars: { x: null } }), /write NULL in the SQL/u);
  assert.throws(() => inWorkspace(never, 'not-a-uuid', 'SELECT 1'), /not a lower-case UUID/u);
  assert.throws(() => inWorkspace(never, ws, 'SELECT 1', { role: 'postgres' }), /app or owner/u);
  assert.throws(() => inWorkspace(never, ws, 'SELECT 1', { vars: { workspace_id: ws } }), /set by inWorkspace/u);
  assert.throws(() => inWorkspace(never, ws, "SELECT :'bad name'", { vars: { 'bad name': 'x' } }), /letters, digits/u);
});

test("COPY's CSV reads back as exact text, with NULL apart from the empty string", () => {
  assert.deepEqual(parseCsv('a,b,c,d\n9007199254740993,,"","x, ""y""\nz"\n'), [
    { a: '9007199254740993', b: null, c: '', d: 'x, "y"\nz' },
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('new writes the next numbered migration from its template, and refuses a bad name or a numbering gap', () => {
  const dir = migrationsWith();
  const file = createMigration('add_example_table', { dir });
  assert.equal(path.basename(file), `${numbered()}_add_example_table.sql`);
  assert.match(readFileSync(file, 'utf8'), new RegExp(`^-- ${numbered()}_add_example_table\\.sql`, 'u'));
  assert.match(readFileSync(file, 'utf8'), /row security/u);
  assert.throws(() => createMigration('Add Example', { dir }), MigrationRefused);
  assert.throws(() => createMigration('../escape', { dir }), MigrationRefused);
  writeFileSync(path.join(dir, `${numbered(3)}_gap.sql`), 'SELECT 1;\n');
  assert.throws(() => createMigration('after_gap', { dir }), /without gaps/u);
});

test('the freeze guard holds each frozen migration to its recorded hash, in order, and says what to do instead', () => {
  const dir = migrationsWith();
  // Exactly what `shasum -a 256 migrations/<file>` prints from db/postgres/.
  const line = (name, mode = ' ') => `${sha256Of(path.join(dir, `${name}.sql`))} ${mode}migrations/${name}.sql`;
  const check = (lines) => frozenMigrationProblems(lines.length ? `${lines.join('\n')}\n` : '', { dir });

  assert.deepEqual(check([]), [], 'nothing frozen yet');
  assert.deepEqual(check(REAL.map((name) => line(name))), []);
  assert.deepEqual(check([line(REAL[0], '*')]), [], "shasum's binary-mode mark reads the same");

  // Editing a frozen baseline is caught, and the message says what to do instead.
  const recorded = line(REAL[0]);
  const baseline = path.join(dir, `${REAL[0]}.sql`);
  writeFileSync(baseline, `${readFileSync(baseline, 'utf8')}\n-- edited after it was frozen\n`);
  const problems = check([recorded]);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], new RegExp(`^${REAL[0]}\\.sql changed after it was frozen.*next migration`, 'u'));

  // Frozen migrations are the first ones, in order; a line names a file that exists; a line is a shasum line.
  writeFileSync(path.join(dir, `${numbered()}_second.sql`), 'SELECT 1;\n');
  assert.match(check([line(`${numbered()}_second`)])[0], /first ones in order/u);
  const ghost = `${'a'.repeat(64)}  migrations/${numbered(2)}_ghost.sql`;
  assert.match(check([...REAL, `${numbered()}_second`].map((name) => line(name)).concat(ghost))[0], /no further file/u);
  assert.match(check(['0001_baseline.sql frozen'])[0], /is not "<sha256>  migrations\/NNNN_name\.sql"/u);
});

test('a migration holding transaction control or a psql command is refused before any run', async () => {
  const withBegin = migrationsWith({ [`${numbered()}_begins.sql`]: 'BEGIN;\nCREATE TABLE x (y int);\n' });
  const withPsql = migrationsWith({ [`${numbered()}_psql.sql`]: '\\set ON_ERROR_STOP 0\nCREATE TABLE x (y int);\n' });
  const offline = { where: 'nowhere', script: () => [], sql: () => [] };
  assert.throws(() => migrationStatus(offline, { dir: withBegin }), /no transaction control/u);
  assert.throws(() => migrationStatus(offline, { dir: withPsql }), /no psql commands/u);
});

// scripts/postgres-test-cluster.mts (and the .mjs and .d.mts generated from
// it) builds an isolated test template; only Vitest configs and tests may
// load it. The operator command and the approved new-empty first-start helper
// may reach migration writes. The runtime, restart and update may not.
const OPERATOR_COMMAND = 'scripts/os-migrate.mjs';
/** The engine the operator command and the first-start helpers call. */
const ENGINE = 'scripts/postgres-apply.mjs';
/** Only the approved new-empty installation helper may reuse
 * the operator command; runtime paths may not. */
const FIRST_START = 'scripts/start-postgres.mjs';
const DEVELOPMENT_START = 'scripts/start-development.mjs';
const HOSTED_DEMO_SETUP = new Set(['scripts/hosted-demo-setup.mts', 'scripts/hosted-demo-setup.mjs']);
const COMMAND_USERS = new Set([ENGINE, FIRST_START, DEVELOPMENT_START]);
const FRESH_USERS = new Set(['scripts/start.mjs', 'scripts/demo-seed.mjs', FIRST_START, DEVELOPMENT_START]);

/**
 * Everything under `root` (a checkout's layout) that could let a runtime,
 * restart or deploy path reach the Postgres runner, the importer or the
 * operator's command: each list is what the guard requires to be empty.
 */
function operatorOnlyReach(root) {
  const allowed = new Set([
    'scripts/postgres-dev.mjs', 'scripts/postgres-migrate.mjs', 'scripts/postgres-docs.mjs',
    ...['.mts', '.mjs', '.d.mts'].map((extension) => `scripts/postgres-test-cluster${extension}`),
    OPERATOR_COMMAND,
    ENGINE,
    FIRST_START,
    // Explicit disposable developer entry; it never adopts an existing store.
    DEVELOPMENT_START,
    // Exact operator-only fresh synthetic demo setup; never a runtime loader.
    ...HOSTED_DEMO_SETUP,
  ]);
  // A test is never runtime; every other file may not even mention the runner.
  const isTest = (relative) => /(^|\/)(test|e2e)\//u.test(relative) || /\.(test|spec)\.[a-z]+$/u.test(relative);
  const isTestConfig = (relative) => /(^|\/)vitest\.config\.ts$/u.test(relative);
  const skip = new Set(['node_modules', 'dist', '.wrangler', 'playwright-report', 'test-results', '.vite']);
  const found = { offenders: [], clusterLoaders: [], importerLoaders: [], commandLoaders: [], freshLoaders: [], packageScripts: [] };
  // The operator's command, by its file (a load or a spawn) or by its pnpm
  // name. In scripts/ only code counts, and there `os:migrate` counts as an
  // argument of its own, which runs it: a comment or a message may point the
  // operator to it. Anywhere else, any mention counts.
  const codeOnly = (text) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*\*)/u.test(line)).join('\n');
  const reachesCommand = (relative, text) =>
    relative.startsWith('scripts/')
      ? /postgres-apply|(?<![a-z-])os-migrate/u.test(codeOnly(text)) || /(['"`])os:migrate\1/u.test(text)
      : /postgres-apply|(?<![a-z-])os-migrate|os:migrate/u.test(text);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (/\.(m?[jt]s|tsx|json)$/u.test(entry.name)) {
        const relative = path.relative(root, full);
        if (isTest(relative)) continue;
        const text = readFileSync(full, 'utf8');
        if (!FRESH_USERS.has(relative) && /start-postgres/u.test(codeOnly(text))) found.freshLoaders.push(relative);
        if (!HOSTED_DEMO_SETUP.has(relative) && /hosted-demo-setup/u.test(codeOnly(text))) found.freshLoaders.push(relative);
        if (relative !== OPERATOR_COMMAND && !COMMAND_USERS.has(relative) && reachesCommand(relative, text)) found.commandLoaders.push(relative);
        if (/postgres-import/u.test(text)) found.importerLoaders.push(relative);
        if (allowed.has(relative)) continue;
        if (/postgres-(migrate|dev)(\.mjs)?\b/u.test(text)) found.offenders.push(relative);
        if (/from ['"][^'"]*postgres-test-cluster\.mjs['"]/u.test(text) && !isTestConfig(relative)) found.clusterLoaders.push(relative);
      }
    }
  };
  for (const base of ['scripts', 'workers', 'apps', 'packages']) {
    if (existsSync(path.join(root, base))) walk(path.join(root, base));
  }
  for (const hooks of ['.githooks', '.github/workflows']) {
    const dir = path.join(root, hooks);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const hook = readFileSync(path.join(dir, name), 'utf8');
      if (/postgres-apply|(?<![a-z-])os-migrate|os:migrate/u.test(hook)) found.commandLoaders.push(path.join(hooks, name));
      if (/hosted-demo-setup/u.test(hook)) found.freshLoaders.push(path.join(hooks, name));
    }
  }
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  for (const [name, command] of Object.entries(scripts)) {
    const runs = [
      [/postgres-migrate/u, ['db:new-migration', 'db:try-migrations']],
      [/(?<![a-z-])os-migrate/u, ['os:migrate']],
    ];
    for (const [pattern, only] of runs) if (pattern.test(command) && !only.includes(name)) found.packageScripts.push(`${name}: ${command}`);
    if (/postgres-apply/u.test(command)) found.packageScripts.push(`${name}: ${command}`);
    if (/postgres-import/u.test(command)) found.packageScripts.push(`${name}: ${command}`);
    if (/hosted-demo-setup/u.test(command)) found.packageScripts.push(`${name}: ${command}`);
    if (/os:migrate/u.test(command)) found.packageScripts.push(`${name}: ${command}`);
  }
  if (scripts['os:migrate'] !== `node ${OPERATOR_COMMAND}`) found.packageScripts.push(`os:migrate: ${scripts['os:migrate']}`);
  return found;
}

test('only approved fresh startup can additionally reach migrations; the runtime, restart and update cannot', () => {
  const found = operatorOnlyReach(REPO_ROOT);
  assert.deepEqual(found.offenders, [], 'only the runner command and the docs generator may load the Postgres runner');
  assert.deepEqual(found.clusterLoaders, [], 'only a Vitest config or a test may load the test-run Postgres cluster');
  assert.deepEqual(found.freshLoaders, [], 'only the approved start and demo commands may load the new-empty setup helper; the runtime, restart and update may not');
  assert.deepEqual(found.importerLoaders, [], 'the retired importer is not a product dependency');
  assert.deepEqual(
    found.commandLoaders,
    [],
    "only the operator command, approved first-start helper and tests may reach the Postgres command; no Worker or package may name it",
  );
  assert.deepEqual(
    found.packageScripts,
    [],
    'only the db: migration commands run the runner, only os:migrate runs the operator command, no script runs pnpm os:migrate, and no import command remains',
  );
  assert.equal(statSync(MIGRATIONS_DIR).isDirectory(), true);
  assert.notEqual(path.resolve(MIGRATIONS_DIR), path.resolve(REPO_ROOT, 'db', 'migrations'));
});

test('the approved demo caller can reach only fresh preparation, never the operator command or runner', () => {
  const root = tempDir('nos-demo-reach-');
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'os:migrate': `node ${OPERATOR_COMMAND}` } }));
  const demo = path.join(root, 'scripts/demo-seed.mjs');
  writeFileSync(demo, "import { prepareFreshPostgres } from './start-postgres.mjs';\n");
  assert.deepEqual(operatorOnlyReach(root), { offenders: [], clusterLoaders: [], importerLoaders: [], commandLoaders: [], freshLoaders: [], packageScripts: [] });
  writeFileSync(demo, "import { prepareFreshPostgres } from './start-postgres.mjs';\nimport { main } from './postgres-apply.mjs';\nimport { applyMigrations } from './postgres-migrate.mjs';\n");
  const found = operatorOnlyReach(root);
  assert.deepEqual(found.commandLoaders, ['scripts/demo-seed.mjs']);
  assert.deepEqual(found.offenders, ['scripts/demo-seed.mjs']);
});

test('the guard catches runtime migration reach and retired importer commands in a planted checkout', () => {
  const root = tempDir('nos-guard-');
  const plant = (relative, text) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };
  // What the repository holds, and is allowed.
  plant(ENGINE, "import { applyMigrations } from './postgres-migrate.mjs';\n");
  plant(OPERATOR_COMMAND, "import { main } from './postgres-apply.mjs';\n");
  plant('scripts/start.mjs', "import { prepareFreshPostgres } from './start-postgres.mjs';\n");
  plant('scripts/demo-seed.mjs', "import { prepareFreshPostgres } from './start-postgres.mjs';\n");
  plant(FIRST_START, "import { main } from './postgres-apply.mjs';\nimport { readMigrations } from './postgres-migrate.mjs';\n");
  plant('scripts/os-update.mjs', "// Its migrations go in with pnpm os:migrate, typed by the operator.\nconsole.log('run pnpm os:migrate -- --apply yourself');\n");
  // Each way in, planted once.
  plant('scripts/runner/lifecycle.mjs', "import { runImport } from '../postgres-import.mjs';\nimport { prepareFreshPostgres } from '../start-postgres.mjs';\n");
  plant('scripts/os-up.mjs', "import { main } from './postgres-apply.mjs';\n");
  plant('scripts/os-restart.mjs', "import { setupHostedDemo } from './hosted-demo-setup.mjs';\n");
  plant('scripts/stack-control.mjs', "spawnSync('pnpm', ['os:migrate', '--apply']);\n");
  plant('workers/ingest/src/index.ts', "// see pnpm os:migrate\nimport { setupHostedDemo } from '../../../scripts/hosted-demo-setup.mjs';\nexport default {};\n");
  plant('apps/tower/server/store.ts', "import { applyMigrations } from '../../../scripts/postgres-migrate.mjs';\n");
  plant('packages/postgres/src/boot.mjs', "import { openThrowaway } from '../../../scripts/postgres-dev.mjs';\n");
  plant('.githooks/pre-commit', 'pnpm os:migrate -- --apply --confirm noticeos\n');
  plant('.githooks/post-commit', 'node scripts/hosted-demo-setup.mjs --request private.json\n');
  plant(
    'package.json',
    `${JSON.stringify({
      scripts: {
        'db:try-migrations': 'node scripts/postgres-migrate.mjs',
        'os:migrate': `node ${OPERATOR_COMMAND}`,
        'postgres:migrate': `node ${ENGINE}`,
        'postgres:import': 'node scripts/postgres-import.mjs',
        'os:restore': 'node scripts/postgres-import.mjs --backup latest',
        'os:schema': 'pnpm os:migrate -- --apply',
        'os:demo': 'node scripts/hosted-demo-setup.mjs --request private.json',
      },
    })}\n`,
  );

  const found = operatorOnlyReach(root);
  assert.deepEqual(found.freshLoaders.sort(), ['.githooks/post-commit', 'scripts/os-restart.mjs', 'scripts/runner/lifecycle.mjs', 'workers/ingest/src/index.ts'], 'hooks, the runtime and Workers cannot load either fresh setup entry');
  assert.deepEqual(found.importerLoaders.sort(), ['scripts/runner/lifecycle.mjs'], 'loading the importer, and through it the operator’s command, is caught');
  assert.deepEqual(
    found.commandLoaders.sort(),
    ['.githooks/pre-commit', 'scripts/os-up.mjs', 'scripts/stack-control.mjs', 'workers/ingest/src/index.ts'],
    'a load, a run by name, a mention outside scripts and a git hook are each caught; a message naming the command is not',
  );
  assert.deepEqual(found.offenders.sort(), ['apps/tower/server/store.ts', 'packages/postgres/src/boot.mjs']);
  assert.deepEqual(found.packageScripts.sort(), [
    'os:demo: node scripts/hosted-demo-setup.mjs --request private.json',
    'os:restore: node scripts/postgres-import.mjs --backup latest',
    'os:schema: pnpm os:migrate -- --apply',
    'postgres:import: node scripts/postgres-import.mjs',
    'postgres:migrate: node scripts/postgres-apply.mjs',
  ]);

  // A retired tool cannot regain permission to apply migrations.
  plant('scripts/postgres-import-rules.mjs', "import { checkTarget } from './postgres-apply.mjs';\n");
  assert.ok(operatorOnlyReach(root).commandLoaders.includes('scripts/postgres-import-rules.mjs'), 'the importer’s other files may not');
});

test('the command refuses a missing, doubled or remote target before touching anything', () => {
  const run = (argv) => {
    const out = [];
    const err = [];
    const code = main(argv, { write: (s) => out.push(s) }, { write: (s) => err.push(s) });
    return { code, out: out.join(''), err: err.join('') };
  };
  assert.equal(run(['status']).code, 2);
  assert.match(run(['status']).err, /exactly one development target/u);
  assert.equal(run(['apply', '--dir', '/tmp/a', '--url', 'postgresql://localhost/noticeos_dev']).code, 2);
  const remote = run(['apply', '--url', 'postgresql://db.example.com/noticeos_dev']);
  assert.equal(remote.code, 2);
  assert.match(remote.err, /refused: not a local database/u);
  assert.equal(run(['drop']).code, 2);
});

// ─── Shared memory ──────────────────────────────────────────────────────────

test('the shared-memory listing reads alike from macOS ipcs and Linux /proc, and anything else reads as unknown', () => {
  const fromIpcs = parseSegments(`IPC status from <running system> as of Thu Sep 24 07:02:13 PDT 2026
T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP NATTCH  SEGSZ  CPID  LPID   ATIME    DTIME    CTIME
Shared Memory:
m  65536 0x0112dc4e --rw-rw-rw-    someone    staff    someone    staff      1   8260   2994   2994 18:13:24 no-entry 18:13:24
m 131073 0x3143e700 --rw-------    someone    staff    someone    staff      0     56  40555      0 no-entry no-entry  0:52:52
`);
  assert.deepEqual(fromIpcs, [
    { id: 65536, key: '0x0112dc4e', mode: 0o666, owner: 'someone', creator: 'someone', attached: 1, bytes: 8260, creatorPid: 2994 },
    { id: 131073, key: '0x3143e700', mode: 0o600, owner: 'someone', creator: 'someone', attached: 0, bytes: 56, creatorPid: 40555 },
  ]);
  const fromProc = parseSegments(`       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid      atime      dtime      ctime                   rss                  swap
 826474496          3   600                   56  4242  4242      6  1001  1001  1001  1001 1695500000 1695500000 1695500000                  4096                     0
        -1          4  1600                    56  4243     0      0  1001  1001  1001  1001          0          0 1695500000                  4096                     0
`);
  assert.deepEqual(fromProc, [
    { id: 3, key: '0x31430000', mode: 0o600, owner: '1001', creator: '1001', attached: 6, bytes: 56, creatorPid: 4242 },
    { id: 4, key: '0xffffffff', mode: 0o600, owner: '1001', creator: '1001', attached: 0, bytes: 56, creatorPid: 4243 },
  ]);
  assert.equal(parseSegments('------ Shared Memory Segments --------\nkey shmid owner perms bytes nattch status\n'), null);
  assert.deepEqual(SERVER_SEGMENT, { bytes: 56, mode: 0o600 });
});

test("only a dead server's segment is removed: never an attached one, one whose creator runs, another user's or another kind", () => {
  const me = new Set(['someone', '1001']);
  const dead = { key: '0x3143e700', mode: 0o600, owner: 'someone', creator: 'someone', attached: 0, bytes: 56, creatorPid: 40555 };
  const segments = [
    { ...dead, id: 1 },
    { ...dead, id: 2, attached: 1 }, // a server, or a child of a killed one, still attached
    { ...dead, id: 3, creatorPid: 777 }, // its creator runs: perhaps a server between making and attaching it
    { ...dead, id: 4, owner: 'other', creator: 'other' },
    { ...dead, id: 5, creator: 'other' },
    { ...dead, id: 6, bytes: 8260, mode: 0o666 }, // not a server's
    { ...dead, id: 7, mode: 0o644 },
    { ...dead, id: 8, bytes: 4096 },
    { ...dead, id: 9, owner: '1001', creator: '1001', creatorPid: 40556 }, // listed by id, as on Linux
    { ...dead, id: 10, creatorPid: 40557 },
  ];
  const alive = (pid) => pid === 777;
  assert.deepEqual(orphanedServerSegments(segments, { alive, user: me }).map((s) => s.id), [1, 9, 10]);

  // The sweep removes exactly those and logs each; a failed removal is logged, never thrown.
  const asked = [];
  const lines = [];
  const removed = sweepOrphanedSegments(segments, {
    alive,
    user: me,
    remove: (id) => (asked.push(id), id === 10 ? 'ipcrm: invalid id' : null),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(asked, [1, 9, 10]);
  assert.deepEqual(removed.map((s) => s.id), [1, 9]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /removed the orphaned shared-memory segment 1 \(key 0x3143e700\).*process 40555, which made it, has exited/u);
  assert.match(lines[2], /could not remove the orphaned shared-memory segment 10 .*invalid id/u);
  assert.deepEqual(sweepOrphanedSegments(null, { remove: () => assert.fail('no listing, nothing removed') }), []);

  // A process counts as gone only when the OS says so; no pid is never a guess.
  assert.equal(processAlive(process.pid), true);
  for (const unnamed of [0, -1, Number.NaN, 2 ** 53]) assert.equal(processAlive(unnamed), true, String(unnamed));
  assert.equal(processAlive(99_999_999), false);
});

test('throwaway initdb uses builtin C.UTF-8 on 17+, preserving the 15 and 16 arguments', () => {
  const dir = tempDir('nos-initdb-');
  const argsFile = path.join(dir, 'args.json');
  const initdb = path.join(dir, 'initdb');
  writeFileSync(initdb, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`);
  chmodSync(initdb, 0o755);
  for (const major of [15, 16, 17, 18]) {
    const root = path.join(dir, `cluster-${major}`);
    const tools = { initdb, pgCtl: '/nonexistent/pg_ctl', psql: '/nonexistent/psql', version: `psql (PostgreSQL) ${major}.0`, major, segmentsFile: null, ipcs: null, ipcrm: null };
    assert.throws(() => openThrowaway(root, tools), PostgresUnavailable);
    const base = ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--no-sync', '-E', 'UTF8', '--no-instructions'];
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), major < 17 ? base : [...base, '--locale-provider=builtin', '--builtin-locale=C.UTF-8']);
  }
});

test('where the OS refuses the shared-memory listing (a sandbox), no server is started, so none can leave a segment behind', () => {
  const dir = tempDir('nos-refused-');
  const ipcs = path.join(dir, 'ipcs');
  writeFileSync(ipcs, '#!/bin/sh\necho "ipcs: sysctlbyname: Operation not permitted" >&2\nexit 1\n');
  chmodSync(ipcs, 0o755);
  // Binaries that do not exist: reaching initdb or pg_ctl would fail differently.
  const tools = { initdb: '/nonexistent/initdb', pgCtl: '/nonexistent/pg_ctl', psql: '/nonexistent/psql', version: 'psql (PostgreSQL) 16.0', major: 16, ipcrm: null };
  const refusals = [
    [{ ...tools, segmentsFile: null, ipcs }, /may not use System V shared memory \(ipcs: sysctlbyname: Operation not permitted\)/u],
    [{ ...tools, segmentsFile: path.join(dir, 'unreadable'), ipcs: null }, /may not use System V shared memory \(.*unreadable: ENOENT\)/u],
  ];
  for (const [refusing, why] of refusals) {
    const folder = path.join(dir, 'cluster');
    assert.throws(() => openThrowaway(folder, refusing), (error) => error instanceof PostgresUnavailable && why.test(error.message));
    assert.equal(existsSync(folder), false, 'nothing was created');
  }
  // With no way to list segments at all, nothing is swept and the start goes on.
  assert.equal(listSharedMemory({ segmentsFile: null, ipcs: null }), null);
});

test("the watchdog stops only a server listening in its owner's socket folder, waits for one still starting, and says which it could not stop", async () => {
  // What the owner wrote before it died: a line before each start, the same
  // line with "started" once the start returned; whole lines, maybe half of one.
  const reported = (name, extra = {}) => JSON.stringify({ data: `/clusters/${name}/data`, socketDir: `/sockets/${name}`, ...extra });
  const watched = parseWatched(
    [
      reported('running'),
      reported('running', { started: true }),
      reported('stopped', { started: true }), // the owner stopped it: a stale pid file
      reported('restarted', { started: true }), // stopped, then started again by someone else
      reported('starting'), // the owner died while pg_ctl start ran
      reported('failed'), // its start failed and the owner cleaned up
      reported('never'), // the owner died before pg_ctl could start anything
      JSON.stringify({ data: 'relative/data', socketDir: '/sockets/relative' }),
      JSON.stringify({ pid: 105, data: '/clusters/pid-only/data' }),
      '{"data": "/clusters/half',
    ].join('\n'),
  );
  assert.deepEqual(
    watched.map(({ data, started }) => [path.basename(path.dirname(data)), started]),
    [['running', true], ['stopped', true], ['restarted', true], ['starting', false], ['failed', false], ['never', false]],
    'one server per folder pair; a malformed or half-written line is skipped',
  );

  const running = new Set([101, 105, 999]);
  let looks = 0;
  const postmaster = (data) => {
    if (data === '/clusters/starting/data') {
      // Its server appears on the third look: no file, then a pid whose socket is not up yet, then both.
      looks += 1;
      return looks === 1 ? null : { pid: 105, socketDir: looks === 2 ? null : '/sockets/starting' };
    }
    return (
      {
        '/clusters/running/data': { pid: 101, socketDir: '/sockets/running' },
        '/clusters/stopped/data': { pid: 102, socketDir: '/sockets/stopped' },
        '/clusters/restarted/data': { pid: 999, socketDir: '/sockets/someone-else' },
      }[data] ?? null
    );
  };
  // The owner removes a socket folder once it has stopped that server.
  const socketFolders = new Set(['/sockets/running', '/sockets/starting', '/sockets/never']);
  const decide = (server) => whatToDo(server, { postmaster, running: (pid) => running.has(pid), exists: (dir) => socketFolders.has(dir) });

  const signalled = [];
  const removed = [];
  const left = await stopOwnedServers(watched, {
    decide,
    signal: (pid) => {
      signalled.push(pid);
      running.delete(pid);
    },
    running: (pid) => running.has(pid),
    removeSocket: dir => {
      assert.equal([...running].some(pid => postmaster(`/clusters/${path.basename(dir)}/data`)?.pid === pid), false, 'the socket is removed only after its server stops');
      removed.push(dir);
    },
    startWaitMs: 500,
    stopWaitMs: 500,
    pollMs: 5,
  });
  assert.deepEqual(signalled, [101, 105], 'the running server at once, the starting one as soon as its socket is up');
  assert.deepEqual(left.running, []);
  assert.deepEqual(removed, ['/sockets/running', '/sockets/starting'], 'only the confirmed stopped servers lose their sockets');
  assert.deepEqual(left.neverStarted.map(({ data }) => data), ['/clusters/never/data'], 'a start that never shows a server is given up on, bounded');
  assert.equal(running.has(999), true, 'the server started again in that folder runs on');

  // One that will not stop is reported after the bounded wait, not waited on forever.
  const stubborn = await stopOwnedServers([{ data: '/clusters/stubborn/data', socketDir: '/sockets/stubborn', started: true }], {
    decide: () => ({ stop: 7 }),
    signal: () => undefined,
    running: () => true,
    removeSocket: () => assert.fail('a running server keeps its socket folder'),
    stopWaitMs: 100,
    pollMs: 5,
  });
  assert.deepEqual(stubborn.running.map(({ pid }) => pid), [7]);
});

// ─── Live, on throwaway clusters ────────────────────────────────────────────

/** Run `fn` against Postgres, or skip with the reason where none can start. */
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

/** Open a throwaway cluster in a fresh temporary folder; closed after the test. */
function throwaway(t) {
  const dev = openThrowaway(path.join(tempDir('nos-dev-'), 'cluster'));
  t.after(() => dev.close());
  return dev;
}

test('a fresh throwaway database uses builtin C.UTF-8 and Unicode codepoint ordering on PostgreSQL 17+', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    const [{ major }] = dev.sql("SELECT current_setting('server_version_num')::int / 10000 AS major");
    if (Number(major) < 17) {
      assert.deepEqual(dev.sql("SELECT current_setting('server_encoding') AS encoding"), [{ encoding: 'UTF8' }]);
      return;
    }
    const locale = dev.sql('SELECT datlocprovider AS provider, datlocale AS locale FROM pg_database WHERE datname = current_database()');
    assert.deepEqual(locale, [{ provider: 'b', locale: 'C.UTF-8' }]);
    const ordered = dev.sql("SELECT value FROM (VALUES ('中'), ('é'), ('Z'), ('Ω'), ('ä'), ('a'), ('A')) AS sample(value) ORDER BY value").map((row) => row.value);
    assert.deepEqual(ordered, ['A', 'Z', 'a', 'ä', 'é', 'Ω', '中']);
    t.diagnostic(JSON.stringify({ major, ...locale[0], ordered }));
  });
});

test('a folder that is neither empty nor a throwaway cluster is refused untouched', async (t) => {
  await live(t, async () => {
    if (!findPostgres()) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    const dir = tempDir('nos-busy-');
    writeFileSync(path.join(dir, 'PG_VERSION'), '16\n');
    assert.throws(() => openThrowaway(dir), (error) => error instanceof DevelopmentProfileRefused && error.message.includes(CLUSTER_MARKER));
    assert.deepEqual(readdirSync(dir), ['PG_VERSION']);
  });
});

test('status only reads; apply records each file by hash; a second apply changes nothing; an edited migration stops the next run', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    const dir = migrationsWith();

    const before = migrationStatus(dev, { dir });
    assert.deepEqual(before.migrations.map((m) => [m.name, m.state]), REAL.map((name) => [name, 'pending']));
    const [untouched] = dev.sql(
      "SELECT to_regnamespace('noticeos_migrations') IS NULL AS no_bookkeeping, to_regnamespace('noticeos') IS NULL AS no_schema, (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'noticeos_%') AS roles",
    );
    assert.deepEqual(untouched, { no_bookkeeping: 't', no_schema: 't', roles: '0' }, 'status wrote nothing');

    assert.deepEqual(applyMigrations(dev, { dir }).applied, REAL);
    const records = dev.sql('SELECT version, name, sha256, applied_at FROM noticeos_migrations.applied ORDER BY version');
    assert.deepEqual(
      records.map((row) => [row.name, row.sha256]),
      REAL.map((name) => [name, sha256Of(path.join(dir, `${name}.sql`))]),
    );
    assert.deepEqual(statesOf(migrationStatus(dev, { dir })), REAL.map(() => 'applied'));

    // Applied as the owner: the owner owns every table, the application none.
    const [owners] = dev.sql(
      "SELECT string_agg(DISTINCT pg_get_userbyid(c.relowner), ',') AS owners FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('noticeos', 'noticeos_migrations') AND c.relkind IN ('r', 'v')",
    );
    assert.equal(owners.owners, 'noticeos_owner');

    // The application may read the record, so a start can say the database
    // is behind its code, and may change none of it.
    const [ledger] = dev.sql(
      `SELECT has_schema_privilege('noticeos_app', 'noticeos_migrations', 'USAGE') AS usage,
              has_schema_privilege('noticeos_app', 'noticeos_migrations', 'CREATE') AS creates,
              has_table_privilege('noticeos_app', 'noticeos_migrations.applied', 'SELECT') AS reads,
              has_table_privilege('noticeos_app', 'noticeos_migrations.applied', 'INSERT, UPDATE, DELETE, TRUNCATE') AS writes`,
    );
    assert.deepEqual(ledger, { usage: 't', creates: 'f', reads: 't', writes: 'f' });

    // A second apply is a no-op.
    assert.deepEqual(applyMigrations(dev, { dir }).applied, []);
    const [again] = dev.sql('SELECT count(*) AS n, max(applied_at) AS applied_at FROM noticeos_migrations.applied');
    assert.deepEqual(again, { n: String(REAL.length), applied_at: records.at(-1).applied_at });

    // Editing an applied migration stops the next run; a correction is a new migration.
    const baseline = path.join(dir, `${REAL[0]}.sql`);
    writeFileSync(baseline, `${readFileSync(baseline, 'utf8')}\n-- edited\n`);
    const edited = migrationStatus(dev, { dir });
    assert.deepEqual(edited.problems.map((m) => [m.name, m.state]), [[REAL[0], 'changed']]);
    assert.throws(() => applyMigrations(dev, { dir }), (error) => error instanceof MigrationRefused && /never edited/u.test(error.message));

    // A recorded migration whose file is gone stops it too.
    const without = tempDir('nos-mig-');
    const gone = migrationStatus(dev, { dir: without });
    assert.deepEqual(gone.problems.map((m) => [m.name, m.state]), REAL.map((name) => [name, 'missing']));
  });
});

test('a failing migration rolls the whole run back: no table, no record, no role', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    const dir = migrationsWith({
      [`${numbered()}_breaks.sql`]: 'CREATE TABLE noticeos.half_made (workspace_id uuid PRIMARY KEY);\nSELECT 1 / 0;\n',
    });
    assert.throws(
      () => applyMigrations(dev, { dir }),
      (error) =>
        error instanceof MigrationFailed && error.message.includes(`${numbered()}_breaks failed`) && /division by zero/u.test(error.message),
    );
    const [left] = dev.sql(
      "SELECT to_regnamespace('noticeos') IS NULL AS no_schema, to_regnamespace('noticeos_migrations') IS NULL AS no_bookkeeping, (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'noticeos_%') AS roles",
    );
    assert.deepEqual(left, { no_schema: 't', no_bookkeeping: 't', roles: '0' }, 'the baseline in the same run was rolled back too');
    assert.deepEqual(statesOf(migrationStatus(dev, { dir })), [...REAL, 'breaks'].map(() => 'pending'));

    // With the real migrations already applied, a failing next migration leaves them as they were.
    applyMigrations(dev, { dir: migrationsWith() });
    assert.throws(() => applyMigrations(dev, { dir }), MigrationFailed);
    const [kept] = dev.sql("SELECT count(*) AS n, to_regclass('noticeos.half_made') IS NULL AS no_half FROM noticeos_migrations.applied");
    assert.deepEqual(kept, { n: String(REAL.length), no_half: 't' });
  });
});

test('a second runner is refused while another holds the lock, and succeeds once it is released', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    const holder = dev.spawnInteractive();
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
    try {
      assert.throws(
        () => applyMigrations(dev),
        (error) => error instanceof MigrationRefused && /another migration run holds the lock/u.test(error.message),
      );
      assert.deepEqual(statesOf(migrationStatus(dev)), REAL.map(() => 'pending'));
    } finally {
      holder.stdin.end();
      await released;
    }
    assert.deepEqual(applyMigrations(dev).applied, REAL);
  });
});

test('a workspace transaction commits exactly or not at all, as the application role, with exact numbers and times', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    applyMigrations(dev);
    const ws = createWorkspace(dev, { slug: 'dev', displayName: 'Development' });
    const other = createWorkspace(dev, { slug: 'other' });

    inWorkspace(
      dev,
      ws,
      `INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES (:'workspace_id'::uuid, 'site.example', 'Site', 'live');
       INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state, recorded_at)
       VALUES (:'workspace_id'::uuid, 'revenue', 'site.example', '2026-08-01', 'ads', :'amount'::bigint, 'USD', 'estimated', :'at'::timestamptz);
       INSERT INTO noticeos.research_log (workspace_id, asset_id, provider, endpoint, params_sha256, question, cost_usd, cost_state, actor, bought_at)
       VALUES (:'workspace_id'::uuid, 'site.example', 'dataforseo', 'x', repeat('a', 64), 'q', :'cost'::numeric, 'reported', 'dev', :'at'::timestamptz);
       INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num)
       VALUES (:'workspace_id'::uuid, 'site.example', 'html-depth', :'at'::timestamptz, '2026-09-05', 'ok', :'reading'::double precision)`,
      { vars: { amount: 9007199254740993n, cost: '0.000625', at: '2026-09-05T01:02:03.456789Z', reading: '0.30000000000000004' } },
    );
    const [row] = inWorkspace(dev, ws, null, {
      read: `SELECT l.amount_minor, l.recorded_at, r.cost_usd, h.value_num, current_user AS role
               FROM noticeos.ledger_entries l, noticeos.research_log r, noticeos.hygiene_checks h`,
    });
    assert.deepEqual(row, {
      amount_minor: '9007199254740993',
      recorded_at: '2026-09-05 01:02:03.456789+00',
      cost_usd: '0.000625',
      value_num: '0.30000000000000004',
      role: 'noticeos_app',
    });

    // NULL and the empty string stay apart on the way out.
    assert.deepEqual(inWorkspace(dev, ws, null, { read: "SELECT NULL::text AS missing, ''::text AS empty, 'a,\"b\"' AS quoted" }), [
      { missing: null, empty: '', quoted: 'a,"b"' },
    ]);

    // Another workspace's transaction sees none of it.
    const [elsewhere] = inWorkspace(dev, other, null, { read: 'SELECT count(*) AS n FROM noticeos.ledger_entries' });
    assert.equal(elsewhere.n, '0');

    // A failure anywhere rolls back everything before it in the same transaction.
    assert.throws(
      () =>
        inWorkspace(
          dev,
          ws,
          `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind) VALUES (:'workspace_id'::uuid, 'site.example', now(), 'deploy');
           SELECT 1 / 0`,
        ),
      PsqlError,
    );
    const [annotations] = inWorkspace(dev, ws, null, { read: 'SELECT count(*) AS n FROM noticeos.annotations' });
    assert.equal(annotations.n, '0');

    // It acts as the application role: booked money cannot be rewritten.
    assert.throws(() => inWorkspace(dev, ws, 'UPDATE noticeos.ledger_entries SET amount_minor = 0'), /permission denied/u);
  });
});

test('bootstrap creates the one workspace once, as the owner, after the migrations', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    assert.throws(() => bootstrapWorkspace(dev, { slug: 'main' }), /apply the migrations first/u);
    applyMigrations(dev);
    assert.throws(() => bootstrapWorkspace(dev, { slug: 'Not A Slug' }), MigrationRefused);

    const first = bootstrapWorkspace(dev, { slug: 'main', displayName: 'My sites' });
    assert.equal(first.created, true);
    const again = bootstrapWorkspace(dev, { slug: 'other' });
    assert.deepEqual([again.created, again.workspaceId], [false, first.workspaceId], 'a second bootstrap creates nothing');

    // The application sees it only when it names it.
    assert.deepEqual(inWorkspace(dev, first.workspaceId, null, { read: 'SELECT slug, display_name FROM noticeos.workspaces' }), [
      { slug: 'main', display_name: 'My sites' },
    ]);
    const [owner] = dev.sql(
      "SELECT count(*) AS n, min(pg_get_userbyid(c.relowner)) AS owner FROM noticeos.workspaces w, pg_class c WHERE c.oid = 'noticeos.workspaces'::regclass",
    );
    assert.deepEqual(owner, { n: '1', owner: 'noticeos_owner' });
  });
});

test('a throwaway cluster records query statistics from its first command (pg_stat_statements)', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    if (!dev.queryStatistics) {
      // Only a server build without its contrib modules lacks it; CI's has them.
      if (process.env.NOTICEOS_REQUIRE_POSTGRES === '1') assert.fail('this Postgres build has no pg_stat_statements: install its contrib modules');
      t.skip('this Postgres build has no pg_stat_statements (its contrib modules)');
      return;
    }
    dev.sql('SELECT 1 AS noticeos_statistics_probe');
    const [row] = dev.sql("SELECT coalesce(sum(calls), 0) AS calls FROM pg_stat_statements WHERE query LIKE '%noticeos_statistics_probe%'");
    assert.ok(Number(row.calls) >= 1, 'the probe query is counted');
  });
});

test('a local URL reaches only a database marked for development', async (t) => {
  await live(t, async () => {
    const dev = throwaway(t);
    const url = `postgresql:///noticeos_dev?host=${dev.socketDir}&user=postgres`;
    const byUrl = openDevelopmentUrl(url);
    assert.deepEqual(statesOf(migrationStatus(byUrl)), REAL.map(() => 'pending'));

    dev.sql('CREATE DATABASE unmarked_dev');
    assert.throws(
      () => openDevelopmentUrl(`postgresql:///unmarked_dev?host=${dev.socketDir}&user=postgres`),
      (error) => error instanceof DevelopmentProfileRefused && /not marked for development/u.test(error.message),
    );
    const [untouched] = dev.sql("SELECT count(*) AS n FROM pg_database WHERE datname = 'unmarked_dev'");
    assert.equal(untouched.n, '1');
  });
});

test('the command applies to a throwaway folder and reuses it on the next run', async (t) => {
  await live(t, async () => {
    if (!findPostgres()) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    const folder = path.join(tempDir('nos-cli-'), 'dev');
    const run = (argv) => {
      const out = [];
      const err = [];
      const code = main(argv, { write: (s) => out.push(s) }, { write: (s) => err.push(s) });
      return { code, out: out.join(''), err: err.join('') };
    };
    const first = run(['apply', '--dir', folder]);
    if (first.code === 3) throw new PostgresUnavailable(first.err.trim());
    assert.equal(first.code, 0, first.err);
    for (const name of REAL) assert.match(first.out, new RegExp(`applied\\s+${name}$`, 'mu'));
    assert.equal(existsSync(path.join(folder, CLUSTER_MARKER)), true);
    const status = run(['status', '--dir', folder, '--json']);
    assert.equal(status.code, 0, status.err);
    assert.deepEqual(statesOf(JSON.parse(status.out)), REAL.map(() => 'applied'));
    assert.match(run(['apply', '--dir', folder]).out, /up to date; nothing applied/u);
    const boot = run(['bootstrap', '--dir', folder, '--slug', 'main', '--name', 'My sites']);
    assert.equal(boot.code, 0, boot.err);
    assert.match(boot.out, /created workspace [0-9a-f-]{36}/u);
    assert.match(run(['bootstrap', '--dir', folder, '--slug', 'main']).out, /already has workspace/u);
    mkdirSync(path.join(folder, 'stray'), { recursive: true });
    assert.equal(run(['status', '--dir', folder]).code, 0, 'a marked folder is reused');
  });
});

// ─── Live: shared memory ────────────────────────────────────────────────────

/** The postmaster's pid, from a throwaway cluster folder. */
const postmasterPid = (root) => Number(readFileSync(path.join(root, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);

/** `probe()` once it is truthy, polled every 100 ms for at most `ms`; null past that. */
async function eventually(probe, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value || Date.now() >= deadline) return value || null;
    await delay(100);
  }
}

/** `fn()`, with what it writes to this process's stderr kept in `lines` instead. */
function capturingStderr(lines, fn) {
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return fn();
  } finally {
    process.stderr.write = write;
  }
}

test('a server killed with SIGKILL leaves its segment, attached by nobody, and the next throwaway start removes it and says so', async (t) => {
  await live(t, async () => {
    const tools = findPostgres();
    const victim = throwaway(t);
    const pid = postmasterPid(victim.root);
    const segmentOf = () => (listSharedMemory(tools) ?? []).find((segment) => segment.creatorPid === pid);
    const held = segmentOf();
    assert.ok(held, 'a running server holds a segment');
    assert.deepEqual([held.bytes, held.mode, held.attached > 0], [SERVER_SEGMENT.bytes, SERVER_SEGMENT.mode, true]);
    assert.equal(orphanedServerSegments(listSharedMemory(tools)).some((s) => s.id === held.id), false, 'an attached segment is never swept');

    process.kill(pid, 'SIGKILL');
    // Its children see the postmaster gone and exit; then nobody is attached.
    // From then on the next throwaway start ANYWHERE on this machine removes
    // it (another test run's may come first), and a sweep removes only a
    // segment attached by nobody, so gone means that too.
    const left = await eventually(() => {
      const segment = segmentOf();
      if (!segment) return 'removed by another start';
      return segment.attached === 0 ? segment : null;
    });
    assert.ok(left, 'the killed server left its segment behind, attached by nobody');
    if (typeof left === 'object') {
      assert.deepEqual(orphanedServerSegments([left], { alive: () => true }), [], 'a segment whose creator runs is never swept');
    }

    const lines = [];
    const next = capturingStderr(lines, () => throwaway(t));
    assert.equal(segmentOf(), undefined, 'the next start removed it');
    if (next.removedSegments.some((segment) => segment.id === held.id)) {
      assert.ok(
        lines.some((line) => line.includes(`removed the orphaned shared-memory segment ${held.id} (key ${held.key})`) && line.includes(`process ${pid},`)),
        `the removal is logged: ${lines.join('')}`,
      );
    } else {
      t.diagnostic(`another throwaway start on this machine removed segment ${held.id} first`);
    }
    const own = (listSharedMemory(tools) ?? []).find((segment) => segment.creatorPid === postmasterPid(next.root));
    assert.ok(own?.attached > 0, "the next server's own segment is attached and kept");
  });
});

/** A command that opens a throwaway cluster in the folder it is given (with
 * the pg_ctl given second, if any), says `ready <its watchdog's pid>` and
 * waits: `close` on stdin stops its server (it says `closed`), any other line
 * makes it exit without close(), and a signal interrupts it. */
const HOLDER = `
import { findPostgres, openThrowaway } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'postgres-dev.mjs')).href)};
let dev;
try {
  const tools = findPostgres();
  dev = openThrowaway(process.argv[1], tools && process.argv[2] ? { ...tools, pgCtl: process.argv[2] } : tools);
} catch (error) {
  process.stdout.write('unavailable ' + error.message.split('\\n')[0] + '\\n');
  process.exit(3);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (line) => {
  if (line.trim() !== 'close') process.exit(0);
  dev.close();
  process.stdout.write('closed\\n');
});
process.stdout.write('ready ' + dev.watchdogPid + '\\n');
`;

/** The postmaster's pid from a cluster folder, or null while none runs there. */
function runningIn(root) {
  try {
    const pid = postmasterPid(root);
    return processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Start HOLDER on `folder` (with `pgCtl` in place of the real one, if given).
 * However the test ends, the holder is killed and no server is left running
 * in the folder. `says(prefix)` waits (bounded) for the line it prints
 * starting with `prefix` and returns it; a holder that could not start a
 * server makes it throw PostgresUnavailable.
 */
function startHolder(t, tools, folder, pgCtl = null) {
  // This child creates sockets only in a new private folder. Inventory that
  // folder alone; never inspect another run's temporary socket folders.
  const sockets = tempDir('nsh-');
  const beforeSockets = readdirSync(sockets);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLDER, folder, ...(pgCtl ? [pgCtl] : [])], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, TMPDIR: sockets, TMP: sockets, TEMP: sockets },
  });
  const ended = new Promise((resolve) => holder.on('exit', (code, signal) => resolve({ code, signal })));
  let out = '';
  let exited = false;
  holder.stdout.on('data', (chunk) => {
    out += chunk;
  });
  holder.on('exit', () => {
    exited = true;
  });
  t.after(() => {
    holder.kill('SIGKILL');
    if (runningIn(folder)) spawnSync(tools.pgCtl, ['-D', path.join(folder, 'data'), '-m', 'immediate', '-w', 'stop']);
  });
  const lines = () => out.split('\n');
  const says = async (prefix) => {
    await eventually(() => exited || lines().some((line) => line.startsWith(prefix) || line.startsWith('unavailable ')), 60_000);
    const unavailable = lines().find((line) => line.startsWith('unavailable '));
    if (unavailable) throw new PostgresUnavailable(unavailable.slice('unavailable '.length));
    const line = lines().find((candidate) => candidate.startsWith(prefix));
    assert.ok(line, `the holder never said "${prefix}": ${out.trim() || 'nothing'}`);
    return line;
  };
  return { holder, ended, says, sockets, beforeSockets };
}

test('a command interrupted by SIGTERM, SIGINT or SIGHUP, or exiting before close(), stops its server and leaves no segment or socket folder', async (t) => {
  await live(t, async () => {
    const tools = findPostgres();
    if (!tools) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    listSharedMemory(tools); // refuses here, as the command would, where no server may run
    for (const ending of ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit']) {
      const folder = path.join(tempDir('nos-held-'), 'cluster');
      const { holder, ended, says, sockets, beforeSockets } = startHolder(t, tools, folder);
      assert.match(await says('ready'), /^ready \d+$/u, ending);
      assert.equal(readdirSync(sockets).length, 1, `${ending}: the running server has its own socket folder`);
      const pid = postmasterPid(folder);
      assert.ok((listSharedMemory(tools) ?? []).some((s) => s.creatorPid === pid && s.attached > 0), `${ending}: its server holds a segment`);

      if (ending === 'exit') holder.stdin.write('end\n');
      else holder.kill(ending);
      assert.deepEqual(await ended, ending === 'exit' ? { code: 0, signal: null } : { code: null, signal: ending }, `${ending}: it ends as it would have`);
      assert.ok(await eventually(() => !processAlive(pid)), `${ending}: its server stopped with it`);
      assert.equal((listSharedMemory(tools) ?? []).some((s) => s.creatorPid === pid), false, `${ending}: and left no segment`);
      assert.deepEqual(readdirSync(sockets), beforeSockets, `${ending}: no private socket folder remains`);
    }
  });
});

// ─── Live: the watchdog ─────────────────────────────────────────────────────

/** How long a killed command's server may outlive it. */
const WATCHDOG_STOPS_WITHIN_MS = 10_000;

test('a command killed with SIGKILL has its server stopped by its watchdog within 10 seconds, leaving no segment, and the next start in that folder runs on', async (t) => {
  await live(t, async () => {
    const tools = findPostgres();
    if (!tools) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    listSharedMemory(tools); // refuses here, as the command would, where no server may run
    const folder = path.join(tempDir('nos-killed-'), 'cluster');
    const { holder, ended, says, sockets, beforeSockets } = startHolder(t, tools, folder);
    const watchdogPid = Number((await says('ready')).split(' ')[1]);
    assert.ok(watchdogPid > 0 && processAlive(watchdogPid), 'the command started its watchdog with its server');
    assert.equal(readdirSync(sockets).length, 1, 'the running server has its own socket folder');
    const pid = postmasterPid(folder);
    const segmentOf = () => (listSharedMemory(tools) ?? []).find((segment) => segment.creatorPid === pid);
    assert.ok(segmentOf()?.attached > 0, 'its server holds a segment');

    holder.kill('SIGKILL');
    assert.deepEqual(await ended, { code: null, signal: 'SIGKILL' }, 'killed outright: nothing in the command ran');
    assert.ok(await eventually(() => !processAlive(pid), WATCHDOG_STOPS_WITHIN_MS), 'its watchdog stopped the server within 10 seconds');
    assert.ok(await eventually(() => !segmentOf(), WATCHDOG_STOPS_WITHIN_MS), 'with an immediate shutdown, which removed its segment');
    assert.ok(await eventually(() => !processAlive(watchdogPid), WATCHDOG_STOPS_WITHIN_MS), 'and then the watchdog ended');
    assert.deepEqual(readdirSync(sockets), beforeSockets, 'the watchdog leaves no private socket folder');

    // The next start in the same folder finds nothing of it to sweep, and runs on.
    const lines = [];
    const next = capturingStderr(lines, () => openThrowaway(folder));
    t.after(() => next.close());
    assert.equal(segmentOf(), undefined);
    assert.equal(lines.some((line) => line.includes(`process ${pid},`)), false, `nothing of it was left for the sweep: ${lines.join('')}`);
    assert.deepEqual(next.sql('SELECT 1 AS up'), [{ up: '1' }], 'the next server in that folder answers');
  });
});

/** A pg_ctl that runs the real one, except that on `start` it kills the
 * command running it with SIGKILL the moment the real start is under way:
 * a command killed while its server is still starting. */
function killedWhileStarting(tools, dir) {
  const pgCtl = path.join(dir, 'pg_ctl');
  const real = `'${tools.pgCtl.replaceAll("'", `'\\''`)}'`;
  const script = [
    '#!/bin/sh',
    'for last; do :; done',
    'if [ "$last" = start ]; then',
    `  ${real} "$@" &`,
    '  kill -KILL "$PPID"',
    '  wait',
    '  exit',
    'fi',
    `exec ${real} "$@"`,
    '',
  ];
  writeFileSync(pgCtl, script.join('\n'));
  chmodSync(pgCtl, 0o755);
  return pgCtl;
}

test('a command killed with SIGKILL while its server is still starting has that server stopped by its watchdog, leaving no segment', async (t) => {
  await live(t, async () => {
    const tools = findPostgres();
    if (!tools) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    listSharedMemory(tools); // refuses here, as the command would, where no server may run
    const dir = tempDir('nos-starting-');
    const folder = path.join(dir, 'cluster');
    const { ended, sockets, beforeSockets } = startHolder(t, tools, folder, killedWhileStarting(tools, dir));
    assert.deepEqual(await ended, { code: null, signal: 'SIGKILL' }, 'killed outright while pg_ctl start ran');

    // The start it left behind brings a server up, and the watchdog stops it.
    const serverLog = path.join(folder, 'server.log');
    const log = () => (existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : '');
    const stopped = await eventually(() => /database system is shut down/u.test(log()), START_WAIT_MS + WATCHDOG_STOPS_WITHIN_MS);
    assert.ok(stopped, `its watchdog stopped the server that start brought up: ${log() || 'no server log'}`);
    assert.match(log(), /received immediate shutdown request/u, 'with an immediate shutdown');
    const pid = Number(/\[(\d+)\] LOG: +starting PostgreSQL/u.exec(log())?.[1]);
    assert.ok(pid > 0, "the killed command's start did bring a server up");
    assert.ok(await eventually(() => !processAlive(pid)), 'that server has exited');
    assert.equal(runningIn(folder), null, 'no postmaster runs in that folder');
    assert.equal((listSharedMemory(tools) ?? []).some((segment) => segment.creatorPid === pid), false, 'and no segment it made is left');
    assert.ok(await eventually(() => readdirSync(sockets).length === beforeSockets.length), 'the watchdog removes the socket folder after that server exits');
  });
});

test("a killed command's watchdog leaves alone a server started again in its folder", async (t) => {
  await live(t, async () => {
    const tools = findPostgres();
    if (!tools) throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
    listSharedMemory(tools);
    const folder = path.join(tempDir('nos-again-'), 'cluster');
    const { holder, ended, says, sockets, beforeSockets } = startHolder(t, tools, folder);
    const watchdogPid = Number((await says('ready')).split(' ')[1]);
    const first = postmasterPid(folder);
    // The command stops its own server; its watchdog still remembers it.
    holder.stdin.write('close\n');
    await says('closed');
    assert.equal(processAlive(first), false);
    assert.deepEqual(readdirSync(sockets), beforeSockets, 'explicit close removes its private socket folder');

    // Someone else starts a server in the same folder; then the command is killed.
    const again = openThrowaway(folder);
    t.after(() => again.close());
    const second = postmasterPid(folder);
    holder.kill('SIGKILL');
    await ended;
    assert.ok(await eventually(() => !processAlive(watchdogPid), WATCHDOG_STOPS_WITHIN_MS), "the killed command's watchdog did its work and ended");
    assert.equal(processAlive(second), true, 'the server started again in that folder runs on');
    assert.equal(existsSync(again.socketDir), true, 'the replacement server keeps its own socket folder');
    assert.deepEqual(again.sql('SELECT 1 AS up'), [{ up: '1' }], 'and answers');
  });
});
