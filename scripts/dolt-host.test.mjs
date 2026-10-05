import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startDoltPlan, preflightDolt, prepareFreshDolt, readDoltProfile, doltEnvironment, doltComposeArgs, validateDoltProfile, DOLT_IMAGE } from './dolt-host.mjs';
import { backupDolt, restoreDolt } from './dolt-backup.mjs';

const root = path.resolve(import.meta.dirname, '..');
const okay = { code: 0, stdout: '', stderr: '' };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-dolt-unit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = { root, home, port: 5400 };
  const calls = [];
  let existing = false;
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === 'context') return { ...okay, stdout: 'unix:///fixture/docker.sock' };
    if (args[0] === 'volume') return existing ? okay : { code: 1, stdout: '', stderr: 'no such volume' };
    if (args.includes('ps')) return { ...okay, stdout: existing ? 'owned-service-id' : '' };
    if (args.includes('up')) existing = true;
    return okay;
  };
  return { home, plan, calls, run, options: { env: { PATH: '/fixture/bin', HOME: '/fixture/tooling' }, run, held: async () => false } };
}

test('Dolt is an additive pinned service with only its own loopback port and persistent volume', () => {
  const compose = fs.readFileSync(path.join(root, 'db/dolt/host/compose.yaml'), 'utf8');
  assert.ok(compose.includes(DOLT_IMAGE));
  assert.match(compose, /127\.0\.0\.1:\$\{NOTICEOS_DOLT_PORT:\?/u);
  assert.match(compose, /dolt-data:\/var\/lib\/dolt/u);
  assert.match(compose, /restart: unless-stopped/u);
  assert.match(compose, /healthcheck:[\s\S]*SELECT 1/u);
  assert.doesNotMatch(compose, /^\s*(?:postgres-data|postgres):/mu);
});

test('fresh preflight reads only its own project/volume, with no filesystem writes', async t => {
  const f = fixture(t);
  const result = await preflightDolt(f.plan, f.options);
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.deepEqual(f.calls.map(c => c.args[0]), ['context', 'compose', 'volume']);
  assert.ok(f.calls.every(c => !c.args.includes('ls')));
  const own = startDoltPlan(f.plan);
  assert.ok(f.calls[1].args.includes(own.project));
  assert.deepEqual(f.calls[2].args, ['volume', 'inspect', `${own.project}_dolt-data`]);
});

test('remote Docker is refused before any project or volume call', async t => {
  const f = fixture(t);
  const result = await preflightDolt(f.plan, { ...f.options, run: async (...args) => {
    f.calls.push(args);
    return { ...okay, stdout: 'tcp://remote.invalid:2375' };
  } });
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('managed/default or occupied derived ports cannot trigger setup', async t => {
  const f = fixture(t);
  assert.equal((await preflightDolt({ ...f.plan, port: 3305 }, f.options)).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal((await preflightDolt(f.plan, { ...f.options, held: async () => true })).ok, false);
  assert.equal(f.calls.length, 0);
});

test('fresh setup creates private installation credentials; existing startup never regenerates them', async t => {
  const f = fixture(t);
  assert.equal((await prepareFreshDolt(f.plan, f.options)).ok, false);
  const result = await prepareFreshDolt(f.plan, { ...f.options, fresh: true });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.deepEqual(readDoltProfile(f.home), result.profile);
  const credential = fs.readFileSync(result.profile.credentialsFile, 'utf8');
  assert.match(credential, /^\[127\.0\.0\.1:5403\]\npassword=[0-9a-f]{64}\n$/u);
  for (const name of ['root', 'noticeos']) assert.equal(fs.statSync(path.join(result.profile.secretsDir, name)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.profile.credentialsFile).mode & 0o777, 0o600);
  assert.equal((await prepareFreshDolt(f.plan, f.options)).created, false);
  assert.equal(fs.readFileSync(result.profile.credentialsFile, 'utf8'), credential);
});

test('a declared hub with a missing volume refuses recreation before up', async t => {
  const f = fixture(t);
  await prepareFreshDolt(f.plan, { ...f.options, fresh: true });
  const calls = [];
  const run = async (binary, args, opts) => {
    calls.push(args);
    if (args[0] === 'volume') return { code: 1, stdout: '', stderr: 'no such volume' };
    return f.run(binary, args, opts);
  };
  assert.equal((await prepareFreshDolt(f.plan, { ...f.options, run })).ok, false);
  assert.ok(calls.every(args => !args.includes('up')));
});

test('only an absent profile returns null; malformed/symlink profiles fail closed', t => {
  const f = fixture(t);
  assert.equal(readDoltProfile(f.home), null);
  fs.mkdirSync(path.join(f.home, 'dolt'));
  const file = path.join(f.home, 'dolt/profile.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readDoltProfile(f.home), /Invalid declared/u);
  fs.rmSync(file);
  fs.symlinkSync(path.join(f.home, 'absent'), file);
  assert.throws(() => readDoltProfile(f.home), /regular file/u);
});

test('owned Beads environment discards redirects/passwords and preserves Docker metadata location separately', t => {
  const f = fixture(t);
  const profile = startDoltPlan(f.plan);
  const env = doltEnvironment(profile, {
    HOME: '/fixture/old-home', PATH: '/fixture/bin', BEADS_DOLT_PASSWORD: 'discard',
    BEADS_DIR: '/fixture/wrong', BD_DATABASE: '/fixture/wrong', DOLT_ROOT_PASSWORD: 'discard',
    DATABASE_URL: 'discard', AWS_SECRET_ACCESS_KEY: 'discard', MYSQL_PWD: 'discard',
  });
  assert.equal(env.HOME, path.join(f.home, 'dolt/client-home'));
  assert.equal(env.DOCKER_CONFIG, '/fixture/old-home/.docker');
  assert.equal(env.BEADS_CREDENTIALS_FILE, profile.credentialsFile);
  assert.equal(env.BEADS_DOLT_SERVER_PORT, '5403');
  assert.equal(env.BEADS_DOLT_AUTO_START, '0');
  assert.equal(env.BD_DISABLE_METRICS, '1');
  assert.equal(env.DOLT_DISABLE_EVENT_FLUSH, '1');
  for (const key of ['BEADS_DOLT_PASSWORD', 'BEADS_DIR', 'BD_DATABASE', 'DOLT_ROOT_PASSWORD', 'DATABASE_URL', 'AWS_SECRET_ACCESS_KEY', 'MYSQL_PWD']) assert.equal(env[key], undefined);
});

function copySnapshot(directory, database) {
  fs.mkdirSync(path.join(directory, 'databases', database), { recursive: true });
  fs.writeFileSync(path.join(directory, 'databases', database, 'manifest'), 'synthetic native snapshot');
  fs.mkdirSync(path.join(directory, 'status'));
  fs.writeFileSync(path.join(directory, 'status', `${database}.json`), '{"rows":[{"status":0}]}');
  const metadata = path.join(directory, 'metadata');
  fs.mkdirSync(path.join(metadata, 'databases', database), { recursive: true });
  fs.writeFileSync(path.join(metadata, 'privileges.db'), 'synthetic grants');
  for (const name of ['branch_control.db', 'server-config.json', 'global-config.json']) fs.writeFileSync(path.join(metadata, `${name}.absent`), '');
  for (const name of ['config.json', 'repo_state.json']) fs.writeFileSync(path.join(metadata, 'databases', database, `${name}.absent`), '');
}

test('online backup uses only fixed owned exec/cp, checks metadata and auth, and publishes completion last', async t => {
  const f = fixture(t);
  const ready = await prepareFreshDolt(f.plan, { ...f.options, fresh: true });
  const output = path.join(f.home, 'backup');
  const calls = [];
  const run = async (binary, args, opts) => {
    calls.push(args);
    if (args.includes('cp')) copySnapshot(output, 'noticeos_tasks');
    return f.run(binary, args, opts);
  };
  const result = await backupDolt(ready.profile, ['noticeos_tasks'], output, { ...f.options, run });
  assert.equal(result.databases.length, 1);
  const marker = JSON.parse(fs.readFileSync(path.join(output, 'backup.json'), 'utf8'));
  assert.equal(marker.complete, true);
  assert.equal(marker.metadata['branch_control.db'], false);
  assert.ok(marker.files['metadata/secrets/root']);
  assert.ok(marker.files['metadata/beads-credentials']);
  assert.equal(fs.statSync(path.join(output, 'metadata/secrets/root')).mode & 0o777, 0o600);
  assert.ok(calls.every(args => !args.includes('stop') && !args.includes('restart')));
  await assert.rejects(backupDolt(ready.profile, ['noticeos_tasks'], output, { ...f.options, run }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'backup.json'), 'utf8')).complete, true);
  const damaged = path.join(output, 'databases/noticeos_tasks/manifest');
  fs.appendFileSync(damaged, 'tampered');
  const next = startDoltPlan({ ...f.plan, home: path.join(f.home, 'restore'), port: 5410 });
  await assert.rejects(restoreDolt(next, output, { run: async () => { throw new Error('No Docker call permitted for tampered input'); } }));
});

test('failed capture has no completion marker and no raw diagnostics escape', async t => {
  const f = fixture(t);
  const ready = await prepareFreshDolt(f.plan, { ...f.options, fresh: true });
  const output = path.join(f.home, 'failed');
  const run = async (binary, args, opts) => args.includes('/etc/noticeos/capture.sh') ? { code: 1, stdout: 'private body', stderr: 'private body' } : f.run(binary, args, opts);
  await assert.rejects(backupDolt(ready.profile, ['noticeos_tasks'], output, { ...f.options, run }), error => !error.message.includes('private body'));
  assert.equal(fs.existsSync(path.join(output, 'backup.json')), false);
});

test('failed staging cleanup invalidates completion and does not expose process errors', async t => {
  const f = fixture(t);
  const ready = await prepareFreshDolt(f.plan, { ...f.options, fresh: true });
  for (const thrown of [false, true]) {
    const output = path.join(f.home, `cleanup-${thrown}`);
    const run = async (binary, args, opts) => {
      if (args.includes('cp')) copySnapshot(output, 'noticeos_tasks');
      if (args.includes('rm')) {
        if (thrown) throw new Error('private body');
        return { code: 1, stdout: 'private body', stderr: 'private body' };
      }
      return f.run(binary, args, opts);
    };
    await assert.rejects(backupDolt(ready.profile, ['noticeos_tasks'], output, { ...f.options, run }), error => !error.message.includes('private body'));
    assert.equal(fs.existsSync(path.join(output, 'backup.json')), false);
  }
});


test('declared shared projects work for runtime and online backup while fresh setup and restore refuse before contact', async t => {
  const f = fixture(t);
  const ready = await prepareFreshDolt(f.plan, { ...f.options, fresh: true });
  const profile = { ...ready.profile, project: 'noticeos-shared-example' };
  fs.writeFileSync(path.join(f.home, 'dolt/profile.json'), JSON.stringify(profile), { mode: 0o600 });
  assert.deepEqual(readDoltProfile(f.home), profile);
  assert.ok(doltComposeArgs(profile).includes(profile.project));
  assert.equal(doltEnvironment(profile, {}).BEADS_DOLT_SERVER_PORT, String(profile.port));
  for (const project of ['noticeos', 'installation_2', 'noticeos-shared-example']) assert.equal(validateDoltProfile({ ...profile, project }).project, project);
  for (const project of ['', '-unsafe', '../other', 'UPPER', 'x'.repeat(64), 'with space', 'bad\nname']) {
    assert.throws(() => validateDoltProfile({ ...profile, project }));
  }
  f.calls.length = 0;
  assert.equal((await preflightDolt(f.plan, f.options)).ok, false);
  assert.equal((await prepareFreshDolt(f.plan, { ...f.options, fresh: true })).ok, false);
  await assert.rejects(restoreDolt(profile, path.join(f.home, 'absent-backup'), f.options));
  assert.equal(f.calls.length, 0, 'Shared projects cannot enter automatic create or restore paths');
  const output = path.join(f.home, 'shared-backup');
  const result = await backupDolt(profile, ['noticeos_tasks'], output, { ...f.options, run: async (binary, args, opts) => {
    if (args.includes('cp')) copySnapshot(output, 'noticeos_tasks');
    return f.run(binary, args, opts);
  } });
  assert.deepEqual(result.databases, ['noticeos_tasks']);
  for (const { args } of f.calls.filter(call => call.args[0] === 'compose')) {
    assert.equal(args[args.indexOf('-p') + 1], profile.project);
    assert.equal(args.includes('up') || args.includes('create') || args.includes('down'), false);
  }
});
