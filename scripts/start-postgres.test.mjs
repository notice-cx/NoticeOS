import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareFreshPostgres, startPostgresPlan } from './start-postgres.mjs';
import { planRefusal, startPlan } from './start.mjs';
import { FILES, SECRETS_DIR_VARIABLE } from './postgres-secrets.mjs';

function fixture(t, { port = 5460 } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'first-pg-safety-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const plan = startPlan({ dir: path.join(base, 'new-installation'), port });
  const calls = [];
  const effects = {
    env: {}, held: async () => false,
    run: async (binary, args, options) => {
      calls.push({ binary, args, options });
      if (args[0] === 'context') return { code: 0, stdout: 'unix:///fixture-only.sock\n', stderr: '' };
      if (args[0] === 'volume') return { code: 1, stdout: '', stderr: 'Error response from daemon: no such volume' };
      return { code: 0, stdout: '', stderr: '' };
    },
    empty: async (own) => (calls.push({ empty: own }), true),
    apply: async (own) => (calls.push({ apply: own }), true),
  };
  return { plan, calls, effects, own: startPostgresPlan(plan) };
}

test('new setup uses its own declared Compose project, protected secrets and port, in safety order', async t => {
  const { plan, own, calls, effects } = fixture(t);
  const result = await prepareFreshPostgres(plan, effects);
  assert.deepEqual({ ...result, schema: undefined }, { ok: true, created: true, env: { [SECRETS_DIR_VARIABLE]: own.secrets }, schema: undefined });
  assert.equal(result.schema.frozenSha256.length, 64);
  assert.ok(result.schema.migrations.length > 0);
  assert.ok(result.schema.migrations.every(row => Number.isInteger(row.version) && typeof row.name === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256)));
  assert.match(own.project, /^noticeos-start-[0-9a-f]{16}$/u);
  assert.equal(own.port, 5462);
  assert.deepEqual(calls.map(call => call.args?.[0] ?? (call.empty ? 'empty' : 'apply')), ['context', 'compose', 'volume', 'compose', 'empty', 'apply']);
  const commands = calls.filter(call => call.args);
  for (const call of commands.filter(call => call.args[0] === 'compose')) {
    assert.deepEqual(call.args.slice(0, 5), ['compose', '-p', own.project, '-f', own.compose]);
    assert.equal(call.options.env[SECRETS_DIR_VARIABLE], own.secrets);
    assert.equal(call.options.env.NOTICEOS_POSTGRES_PORT, '5462');
    assert.equal(call.args.includes('noticeos'), false, 'never uses the shared Compose project');
  }
  assert.deepEqual(commands[2].args, ['volume', 'inspect', `${own.project}_postgres-data`]);
  assert.equal(statSync(own.secrets).mode & 0o777, 0o700);
  for (const name of FILES.filter(name => name.endsWith('.url'))) assert.equal(statSync(path.join(own.secrets, name)).mode & 0o777, 0o600);
  const profileFile = path.join(plan.home, 'postgres', 'profile.json');
  assert.equal(statSync(profileFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(profileFile, 'utf8')), { project: own.project, composeFile: own.compose, secretsDir: own.secrets, port: own.port });
  assert.ok(existsSync(plan.mark));
  for (const name of ['database.url', 'owner.url', 'maint.url']) {
    const url = readFileSync(path.join(own.secrets, name), 'utf8').trim();
    assert.equal(JSON.stringify(commands).includes(url), false, 'connection string never reaches Docker arguments or environment');
  }
  assert.deepEqual(startPostgresPlan(plan), own, 'identity is stable after creating the folder');
  calls.length = 0;
  assert.deepEqual(await prepareFreshPostgres(plan, effects), { ok: true, created: false, env: { [SECRETS_DIR_VARIABLE]: own.secrets } });
  assert.deepEqual(calls, [], 'a later start never applies or starts anything');
});

test('a required fresh task setup is recorded inside the exclusive PG reservation before schema work', async t => {
  const { plan, effects } = fixture(t);
  const file = path.join(plan.home, '.noticeos-first-start', 'tasks-required');
  assert.equal((await prepareFreshPostgres(plan, { ...effects, requireTasks: true, apply: async () => {
    assert.equal(existsSync(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    return false;
  } })).ok, false);
  const content = readFileSync(file, 'utf8');
  assert.equal((await prepareFreshPostgres(plan, { ...effects, requireTasks: true })).created, false);
  assert.equal(readFileSync(file, 'utf8'), content, 'a later start never clears or retries incomplete task setup');
});

test('the default operational Postgres port is refused without even a TCP occupancy probe', async t => {
  const { plan, calls, effects } = fixture(t, { port: 5430 });
  let probed = false;
  const result = await prepareFreshPostgres(plan, { ...effects, held: async () => { probed = true; return false; } });
  assert.equal(result.ok, false);
  assert.equal(probed, false);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(plan.home), false);
});

test('any existing home entry, including unknown files, state or empty profile directories, disables setup', async t => {
  for (const entry of ['operator.txt', '.wrangler', 'workers', 'postgres']) {
    const { plan, calls, effects } = fixture(t);
    mkdirSync(plan.home);
    if (entry.endsWith('.txt')) writeFileSync(path.join(plan.home, entry), 'preserve');
    else mkdirSync(path.join(plan.home, entry));
    const before = readdirSync(plan.home);
    assert.equal((await prepareFreshPostgres(plan, effects)).created, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(plan.home), before);
  }
});

test('inherited address or explicitly selected manual profile prevents automatic setup without touching that profile', async t => {
  for (const name of ['DATABASE_URL', SECRETS_DIR_VARIABLE, 'NOTICEOS_POSTGRES_PORT']) {
    const { plan, calls, effects } = fixture(t);
    const result = await prepareFreshPostgres(plan, { ...effects, env: { [name]: '' } });
    assert.equal(result.created, false);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(plan.home), false);
  }
});

test('symlinked home is refused without following it or changing its target', async t => {
  const { plan, calls, effects } = fixture(t);
  const target = path.join(path.dirname(plan.home), 'unrelated');
  mkdirSync(target);
  symlinkSync(target, plan.home);
  assert.equal((await prepareFreshPostgres(plan, effects)).ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(readdirSync(target), []);
});

test('unfrozen or changed baseline refuses before files, Docker or database calls', async t => {
  for (const freeze of ['', '0'.repeat(64) + '  migrations/0001_baseline.sql\n']) {
    const { plan, calls, effects } = fixture(t);
    const result = await prepareFreshPostgres(plan, { ...effects, freeze });
    assert.equal(result.ok, false);
    assert.match(result.line, /freeze and commit.*frozen-migrations/u);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(plan.home), false);
  }
});

test('derived Postgres port rejects every managed port, invalid range and occupied port before Docker', async t => {
  for (const port of [5171, 8789, 3306, 65534]) {
    const { plan, calls, effects } = fixture(t, { port });
    assert.equal((await prepareFreshPostgres(plan, effects)).ok, false);
    assert.deepEqual(calls, []);
  }
  const { plan, calls, effects } = fixture(t);
  assert.equal((await prepareFreshPostgres(plan, { ...effects, held: async () => true })).ok, false);
  assert.deepEqual(calls, []);
});

test('existing project/volume or ambiguous Docker failure refuses without writing secrets', async t => {
  for (const collision of ['project', 'volume', 'unknown']) {
    const { plan, calls, effects } = fixture(t);
    const run = async (...args) => {
      const answer = await effects.run(...args);
      const words = args[1];
      if (collision === 'project' && words.includes('ps')) return { code: 0, stdout: 'existing-container', stderr: '' };
      if (words[0] === 'volume') return collision === 'volume' ? { code: 0, stdout: 'existing-volume', stderr: '' } : { code: 1, stdout: '', stderr: 'unknown private failure' };
      return answer;
    };
    assert.equal((await prepareFreshPostgres(plan, { ...effects, run })).ok, false);
    assert.equal(calls.some(call => call.args?.includes('up') || call.empty || call.apply), false);
    assert.equal(existsSync(plan.home), false);
  }
});

test('existing database content refuses before apply/bootstrap and preserves its own setup files', async t => {
  const { plan, own, calls, effects } = fixture(t);
  const result = await prepareFreshPostgres(plan, { ...effects, empty: async () => false });
  assert.equal(result.ok, false);
  assert.match(result.line, /database is not empty/u);
  assert.equal(calls.some(call => call.apply), false);
  assert.ok(existsSync(path.join(own.secrets, 'owner.url')));
  assert.equal(existsSync(plan.mark), true, 'provenance permits explicit operator repair');
  assert.equal(calls.some(call => call.args?.some(word => ['down', 'rm', 'remove'].includes(word))), false);
});

test('failed or uncertain setup stays preserved, with no retry or raw error detail', async t => {
  for (const failure of ['up', 'empty', 'apply']) {
    const { plan, own, calls, effects } = fixture(t);
    const settings = { ...effects };
    if (failure === 'up') settings.run = async (...args) => args[1].includes('up') ? { code: 1, stdout: 'private output', stderr: 'private error' } : effects.run(...args);
    if (failure === 'empty') settings.empty = async () => { throw new Error('private connection'); };
    if (failure === 'apply') settings.apply = async () => false;
    const result = await prepareFreshPostgres(plan, settings);
    assert.equal(result.ok, false);
    assert.equal(result.line.includes('private'), false);
    assert.ok(existsSync(path.join(own.secrets, 'owner.url')));
    assert.equal(existsSync(plan.mark), true);
    assert.equal(planRefusal(plan), null, 'ordinary startup is still available after explicit operator repair');
    calls.length = 0;
    assert.equal((await prepareFreshPostgres(plan, effects)).created, false);
    assert.deepEqual(calls, [], 'a failed attempt never resumes applying automatically');
  }
});

test('files appearing during Docker preflight make the folder ineligible before secrets are made', async t => {
  const { plan, own, effects } = fixture(t);
  const run = async (...args) => {
    const answer = await effects.run(...args);
    if (args[1][0] === 'volume') {
      mkdirSync(plan.home);
      writeFileSync(path.join(plan.home, 'appeared.txt'), 'keep me');
    }
    return answer;
  };
  const result = await prepareFreshPostgres(plan, { ...effects, run });
  assert.equal(result.ok, false);
  assert.match(result.line, /gained files/u);
  assert.equal(existsSync(own.secrets), false);
  assert.equal(readFileSync(path.join(plan.home, 'appeared.txt'), 'utf8'), 'keep me');
});

test('a home replaced with a symbolic link during preflight never gets setup files', async t => {
  const { plan, effects } = fixture(t);
  const target = path.join(path.dirname(plan.home), 'unrelated-empty');
  mkdirSync(target);
  const run = async (...args) => {
    const answer = await effects.run(...args);
    if (args[1][0] === 'volume') symlinkSync(target, plan.home);
    return answer;
  };
  const result = await prepareFreshPostgres(plan, { ...effects, run });
  assert.equal(result.ok, false);
  assert.match(result.line, /symbolic link/u);
  assert.deepEqual(readdirSync(target), []);
});

test('a concurrent first startup refuses while setup is active, then ordinary startup never retries apply', async t => {
  const { plan, calls, effects } = fixture(t);
  let nested;
  const result = await prepareFreshPostgres(plan, { ...effects, empty: async () => {
    nested = await prepareFreshPostgres(plan, effects);
    return true;
  } });
  assert.equal(result.created, true);
  assert.equal(nested.ok, false);
  assert.match(nested.line, /another first startup/u);
  assert.equal(existsSync(path.join(plan.home, '.noticeos-first-start', 'active.json')), false);
  calls.length = 0;
  assert.equal((await prepareFreshPostgres(plan, effects)).created, false);
  assert.deepEqual(calls, []);
});

test('fresh workspace identity is validated before any filesystem, Docker or database effects', async t => {
  const valid = { slug: 'demo', displayName: 'Synthetic demo', workspaceId: '11111111-1111-4111-8111-111111111111' };
  for (const workspace of [null, [], {}, { ...valid, workspaceId: 'not-a-uuid' }, { ...valid, slug: '../other' }, { ...valid, displayName: '' }, { ...valid, displayName: 'invalid\nname' }, { ...valid, other: 'target' }]) {
    const { plan, calls, effects } = fixture(t);
    assert.equal((await prepareFreshPostgres(plan, { ...effects, workspace })).ok, false);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(plan.home), false);
  }
  const { plan, effects } = fixture(t);
  let declared;
  const result = await prepareFreshPostgres(plan, { ...effects, workspace: valid, apply: async (own, options) => {
    declared = options;
    assert.equal(Object.isFrozen(options.workspace), true);
    return true;
  } });
  assert.equal(result.created, true);
  assert.deepEqual(declared.workspace, valid);
  assert.equal(declared.dir, path.join(plan.root, 'db/postgres/migrations'));
  assert.ok(result.schema);
  const existing = await prepareFreshPostgres(plan, { ...effects, workspace: valid });
  assert.equal(existing.created, false);
  assert.equal(Object.hasOwn(existing, 'schema'), false, 'only completed new setup returns schema provenance');
});
