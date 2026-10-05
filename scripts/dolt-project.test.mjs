import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initDoltProject, main } from './dolt-project.mjs';
import { startDoltPlan } from './dolt-host.mjs';
import { runCommand } from './run-command.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-project-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'new-checkout');
  fs.mkdirSync(repo);
  const profile = startDoltPlan({ root, home, port: 5450 });
  fs.mkdirSync(profile.secretsDir, { recursive: true });
  const password = 'ab'.repeat(32);
  for (const [name, value] of [['root', 'cd'.repeat(32)], ['noticeos', password]]) fs.writeFileSync(path.join(profile.secretsDir, name), `${value}\n`, { mode: 0o600 });
  fs.writeFileSync(profile.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${password}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'dolt', 'profile.json'), JSON.stringify(profile));
  const binary = path.join(root, 'bd');
  fs.writeFileSync(binary, '', { mode: 0o700 });
  const calls = [];
  const run = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[0] === 'init') {
      fs.mkdirSync(path.join(repo, '.beads'));
      fs.writeFileSync(path.join(repo, '.beads', 'config.yaml'), 'sync.remote: bad\nno-git-ops: false\nimport.auto: true\n');
    }
    return { code: 0, stdout: args[0] === 'version' ? 'bd version 1.3.1 (fixture)' : args.includes('rev-parse') ? fs.realpathSync(repo) : '', stderr: '' };
  };
  const sql = [];
  const executor = async () => async args => { sql.push(args); return { code: 0, stdout: JSON.stringify({ rows: [{ Database: 'information_schema' }] }) }; };
  return { args: { home, repo, prefix: 'aa', database: 'aa_tasks' }, options: { binary, run, executor, env: { PATH: '/bin', BEADS_DOLT_PASSWORD: 'inherited', BD_DOLT_SERVER_SOCKET: '/wrong' } }, calls, sql, profile, password };
}

test('operator and fresh setup share one fixed init with init-only own password, absent database proof and safe spoke config', async t => {
  const f = fixture(t);
  assert.deepEqual(await initDoltProject(f.args, f.options), { ok: true });
  const init = f.calls.find(call => call.args[0] === 'init');
  assert.equal(init.options.env.BEADS_DOLT_PASSWORD === f.password, true);
  assert.equal(JSON.stringify(init.args).includes(f.password), false);
  assert.equal(init.options.env.BD_DOLT_SERVER_SOCKET, undefined);
  assert.equal(init.options.env.BEADS_DOLT_AUTO_START, '0');
  assert.equal(init.options.env.BEADS_CREDENTIALS_FILE, f.profile.credentialsFile);
  assert.deepEqual(init.args, ['init', '--server', '--external', '--server-host', '127.0.0.1', '--server-port', '5453', '--server-user', 'noticeos', '--database', 'aa_tasks', '--prefix', 'aa', '--non-interactive', '--skip-hooks', '--skip-agents']);
  assert.equal(f.sql[0].at(-1), 'SHOW DATABASES');
  assert.equal(f.sql[1].at(-1), 'CREATE DATABASE `aa_tasks`');
  const yaml = fs.readFileSync(path.join(f.args.repo, '.beads', 'config.yaml'), 'utf8');
  assert.equal(yaml.includes('sync.remote:'), false);
  assert.match(yaml, /no-git-ops: true\nimport.auto: false/u);
  assert.equal(fs.existsSync(path.join(f.args.home, 'dolt', '.project-init-lock')), false);
});

test('existing spoke and existing exact database refuse initialization/migration without overwrite', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.args.repo, '.beads'));
  fs.writeFileSync(path.join(f.args.repo, '.beads', 'kept'), 'unchanged');
  assert.equal((await initDoltProject(f.args, f.options)).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.args.repo, '.beads', 'kept'), 'utf8'), 'unchanged');
  fs.rmSync(path.join(f.args.repo, '.beads'), { recursive: true });
  const result = await initDoltProject(f.args, { ...f.options, executor: async () => async () => ({ code: 0, stdout: JSON.stringify({ rows: [{ Database: 'AA_TASKS' }] }) }) });
  assert.equal(result.ok, false);
  assert.equal(f.calls.some(call => call.args[0] === 'init'), false);
  assert.equal(fs.existsSync(path.join(f.args.repo, '.beads')), false);
});

test('a dangling .beads link counts as existing setup and refuses before CLI/SQL', async t => {
  const f = fixture(t);
  const target = path.join(path.dirname(f.args.repo), 'must-remain-absent');
  const link = path.join(f.args.repo, '.beads');
  fs.symlinkSync(target, link);
  assert.equal((await initDoltProject(f.args, f.options)).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sql.length, 0);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), false);
});

test('unknown inventory and raw CLI failures stay redacted and never automatically retry uncertain init', async t => {
  const f = fixture(t);
  const unknown = await initDoltProject(f.args, { ...f.options, executor: async () => async () => ({ code: 0, stdout: '{}' }) });
  assert.equal(unknown.ok, false);
  assert.equal(f.calls.some(call => call.args[0] === 'init'), false);
  const failed = await initDoltProject(f.args, { ...f.options, run: async (bin, args, options) => {
    if (bin === 'git' || args[0] === 'version') return f.options.run(bin, args, options);
    fs.mkdirSync(path.join(f.args.repo, '.beads'));
    return { code: 1, stdout: f.password, stderr: f.password };
  } });
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes(f.password), false);
  assert.equal((await initDoltProject(f.args, f.options)).ok, false);
});

test('actual synthetic Git checkouts with staged, modified or untracked work are refused before database writes', async t => {
  for (const state of ['non-git', 'staged', 'modified', 'untracked']) {
    const f = fixture(t);
    const gitEnv = { PATH: '/usr/bin:/bin', HOME: path.join(f.args.home, 'dolt', 'client-home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
    const git = args => runCommand('git', ['-C', f.args.repo, ...args], { cwd: f.args.repo, env: gitEnv });
    const file = path.join(f.args.repo, 'unrelated.txt');
    if (state !== 'non-git') assert.equal((await git(['init', '--quiet'])).code, 0);
    fs.writeFileSync(file, 'operator work');
    if (state === 'staged' || state === 'modified') assert.equal((await git(['add', 'unrelated.txt'])).code, 0);
    if (state === 'modified') {
      assert.equal((await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline'])).code, 0);
      fs.writeFileSync(file, 'changed operator work');
    }
    const before = await git(['status', '--porcelain=v1', '--untracked-files=all']);
    const content = fs.readFileSync(file, 'utf8');
    const result = await initDoltProject(f.args, { ...f.options, run: (bin, args, options) => bin === 'git' ? runCommand(bin, args, options) : f.options.run(bin, args, options) });
    assert.equal(result.ok, false);
    assert.equal(f.sql.length, 0);
    assert.equal(f.calls.some(call => call.args[0] === 'init'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    const after = await git(['status', '--porcelain=v1', '--untracked-files=all']);
    assert.equal(after.code, before.code);
    assert.equal(after.stdout, before.stdout);
  }
});

test('a database created concurrently cannot be adopted by the initializer', async t => {
  const f = fixture(t);
  const result = await initDoltProject(f.args, { ...f.options, executor: async () => async args => args.at(-1) === 'SHOW DATABASES'
    ? { code: 0, stdout: JSON.stringify({ rows: [{ Database: 'information_schema' }] }) }
    : { code: 1, stdout: '', stderr: 'Already exists' } });
  assert.equal(result.ok, false);
  assert.equal(f.calls.some(call => call.args[0] === 'init'), false);
  assert.equal(fs.existsSync(path.join(f.args.repo, '.beads')), false);
});

test('invalid identifiers, symlinks and someone else’s initializer lock fail before init', async t => {
  const f = fixture(t);
  for (const patch of [{ prefix: 'a' }, { prefix: 'Aaa' }, { database: 'name;DROP' }, { database: '' }]) assert.equal((await initDoltProject({ ...f.args, ...patch }, f.options)).ok, false);
  assert.equal(f.calls.length, 0);
  const link = path.join(path.dirname(f.args.repo), 'symlink');
  fs.symlinkSync(f.args.repo, link);
  assert.equal((await initDoltProject({ ...f.args, repo: link }, f.options)).ok, false);
  const lock = path.join(f.args.home, 'dolt', '.project-init-lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'kept'), 'other initializer');
  assert.equal((await initDoltProject(f.args, f.options)).ok, false);
  assert.equal(fs.existsSync(path.join(lock, 'kept')), true);
  assert.equal(f.calls.some(call => call.args[0] === 'init'), false);
});

test('operator command requires all explicit selectors and never prints generated credentials', async t => {
  const f = fixture(t);
  let text = '';
  const out = { write: line => { text += line; } };
  assert.equal(await main(['--repo', f.args.repo], { ...f.options, out, err: out }), 1);
  assert.equal(f.calls.length, 0);
  assert.equal(await main(['--home', f.args.home, '--repo', f.args.repo, '--prefix', 'aa', '--database', 'aa_tasks'], { ...f.options, out, err: out }), 0);
  assert.equal(text.includes(f.password), false);
});


test('operator can add a new task project to the declared shared hub but cannot reinitialize one', async t => {
  for (const exists of [false, true]) {
    const f = fixture(t);
    const profile = { ...f.profile, project: 'noticeos-shared-example' };
    fs.writeFileSync(path.join(f.args.home, 'dolt/profile.json'), JSON.stringify(profile), { mode: 0o600 });
    const selected = [];
    const result = await initDoltProject(f.args, { ...f.options, executor: async declared => {
      selected.push(declared);
      return async args => {
        f.sql.push(args);
        return { code: 0, stdout: JSON.stringify({ rows: [{ Database: exists ? f.args.database : 'information_schema' }] }) };
      };
    } });
    assert.equal(result.ok, !exists);
    assert.deepEqual(selected, [profile]);
    for (const args of f.sql) assert.equal(args[args.indexOf('-p') + 1], profile.project);
    assert.equal(f.calls.some(call => call.args[0] === 'init'), !exists);
    assert.equal(f.sql.some(args => args.at(-1).startsWith('CREATE DATABASE')), !exists);
  }
});
