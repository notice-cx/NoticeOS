import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cloud = path.join(root, 'dev/cloud');
const supported = process.platform === 'linux';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-cloud-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'checkout with spaces');
  fs.mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'noticeos', engines: { node: '>=24.0.0' }, packageManager: 'pnpm@12.8.1' }));
  fs.writeFileSync(path.join(repo, '.github/workflows/ci.yml'), 'node-version: 24.21.0\n');
  fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: error\n');
  const env = { ...process.env, NOTICEOS_REPO: repo, NOTICEOS_CLOUD_CACHE: path.join(base, 'cache'),
    NOTICEOS_CLOUD_TOOLS: path.join(base, 'tools'), NOTICEOS_CLOUD_STATE: path.join(base, 'state'),
    NOTICEOS_TEST_RUNTIME_ROOT: path.join(base, 'runs') };
  return { base, repo, env };
}
function run(command, args, env) {
  return spawnSync(command, args, { env, encoding: 'utf8', timeout: 15_000 });
}
function requirements(env) {
  const result = run('python3', [path.join(cloud, 'requirements.py')], env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('cloud setup derives pins and invalidates dependencies on actual checkout inputs', { skip: !supported }, t => {
  const { repo, env } = fixture(t);
  const before = requirements(env);
  assert.equal(before.node, '24.21.0');
  assert.equal(before.pnpm, '12.8.1');
  const other = fixture(t);
  assert.equal(requirements(other.env).dependencies, before.dependencies, 'moving a checkout does not invalidate equivalent inputs');
  fs.appendFileSync(path.join(repo, 'pnpm-lock.yaml'), '# changed revision\n');
  assert.notEqual(requirements(env).dependencies, before.dependencies);
  const locked = requirements(env).dependencies;
  fs.mkdirSync(path.join(repo, 'apps/example'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'apps/example/package.json'), '{"name":"example"}');
  assert.notEqual(requirements(env).dependencies, locked);
  fs.writeFileSync(path.join(repo, '.github/workflows/ci.yml'), 'node-version: 24.22.0\n');
  assert.notEqual(requirements(env).dependencies, before.dependencies);
});

test('cloud setup rejects unsupported or conflicting toolchain requirements', { skip: !supported }, t => {
  const { repo, env } = fixture(t);
  const ci = path.join(repo, '.github/workflows/ci.yml');
  fs.writeFileSync(ci, 'node-version: 24.21.0\nnode-version: 26.0.0\n');
  assert.match(run('python3', [path.join(cloud, 'requirements.py')], env).stderr, /one exact Node version/);
  fs.writeFileSync(ci, 'node-version: 22.0.0\n');
  assert.match(run('python3', [path.join(cloud, 'requirements.py')], env).stderr, /must satisfy/);
  fs.writeFileSync(ci, 'node-version: 24.21.0\n');
  const manifest = path.join(repo, 'package.json');
  const value = JSON.parse(fs.readFileSync(manifest));
  value.packageManager = 'pnpm@latest';
  fs.writeFileSync(manifest, JSON.stringify(value));
  assert.match(run('python3', [path.join(cloud, 'requirements.py')], env).stderr, /exact pnpm/);
});

test('Codex shell adapter is repeatable, reversible and preserves private profile permissions', { skip: !supported }, t => {
  const { base, env } = fixture(t);
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const profile = path.join(home, '.bashrc');
  fs.writeFileSync(profile, '# owned settings\nreturn\n', { mode: 0o600 });
  const hook = path.join(cloud, 'codex/shell-hooks.py');
  const hookEnv = { ...env, HOME: home };
  assert.equal(run('python3', [hook], hookEnv).status, 0);
  const once = fs.readFileSync(profile, 'utf8');
  assert.ok(once.indexOf('BEGIN NOTICEOS') < once.indexOf('return'));
  assert.equal(run('python3', [hook], hookEnv).status, 0);
  assert.equal(fs.readFileSync(profile, 'utf8'), once);
  assert.equal(fs.statSync(profile).mode & 0o777, 0o600);
  assert.equal(run('python3', [hook, '--remove'], hookEnv).status, 0);
  assert.equal(fs.readFileSync(profile, 'utf8'), '# owned settings\nreturn\n');
  fs.unlinkSync(profile); fs.symlinkSync('.profile', profile);
  assert.notEqual(run('python3', [hook], hookEnv).status, 0);
});

test('cloud launcher refuses stale dependencies without installing or executing the command', { skip: !supported || process.getuid?.() === 0 }, t => {
  const { base, repo, env } = fixture(t);
  const pins = requirements(env);
  const bin = path.join(pins.tools, 'node_modules/.bin'); fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const calls = path.join(base, 'pnpm-calls');
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\necho "$*" >> "$CLOUD_TEST_CALLS"\n', { mode: 0o755 });
  const sentinel = path.join(repo, 'executed');
  const result = run('bash', [path.join(cloud, 'test.sh'), process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "unexpected")', sentinel], { ...env, CLOUD_TEST_CALLS: calls });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit preparation/);
  assert.equal(fs.existsSync(calls), false);
  assert.equal(fs.existsSync(sentinel), false);
});

test('cloud launcher preserves exit status, private modes and runtime isolation under a subreaper', { skip: !supported || process.getuid?.() === 0 }, t => {
  const reaper = run('bash', ['-c', 'command -v docker-init || command -v tini'], process.env);
  if (reaper.status !== 0) { t.skip('docker-init or tini is required'); return; }
  // Managed hosts may add synthetic .git ancestors above all writable temp roots.
  for (let dir = fs.realpathSync(os.tmpdir()); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) { t.skip('host temporary storage is below a Git marker'); return; }
    if (dir === path.dirname(dir)) break;
  }
  const { base, repo, env } = fixture(t);
  const pins = requirements(env);
  const bin = path.join(pins.tools, 'node_modules/.bin'); fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\n[ "$1" = exec ] || exit 99\nshift\nexec "$@"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'node_modules/.noticeos-environment.json'), JSON.stringify({ key: pins.dependencies }));
  fs.mkdirSync(path.join(repo, 'scripts/test-fixtures'), { recursive: true });
  const guard = pathToFileURL(path.join(root, 'scripts/test-fixtures/hosted-task-projects.mjs')).href;
  fs.writeFileSync(path.join(repo, 'scripts/test-fixtures/hosted-task-projects.mjs'), `export { assertTaskFixtureOutsideGit } from ${JSON.stringify(guard)};`);
  const probe = path.join(base, 'probe.mjs');
  fs.writeFileSync(probe, `
    import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
    assert.equal(process.umask(), 0o022);
    assert.equal(process.env.NOTICEOS_REQUIRE_POSTGRES, '1');
    assert.ok(process.env.NOTICEOS_TEST_PNPM_EXECUTABLE.startsWith(process.env.NOTICEOS_CLOUD_TOOLS));
    assert.ok(process.env.TMPDIR.startsWith(process.env.NOTICEOS_TEST_RUNTIME_ROOT));
    assert.ok(process.env.HOME.startsWith(process.env.NOTICEOS_TEST_RUNTIME_ROOT));
    const privateFile = path.join(process.env.TMPDIR, 'private');
    fs.writeFileSync(privateFile, '', { mode: 0o600 });
    assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
    const parent = fs.readFileSync('/proc/' + process.ppid + '/comm', 'utf8').trim();
    assert.match(parent, /docker-init|tini/);
    process.exit(37);
  `);
  const result = run('bash', [path.join(cloud, 'test.sh'), process.execPath, probe], env);
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.match(result.stderr, /Verification exited 37/);
  // A Git ancestor must reject the same command before execution.
  fs.mkdirSync(path.join(base, '.git'));
  const refused = run('bash', [path.join(cloud, 'test.sh'), process.execPath, probe], env);
  assert.notEqual(refused.status, 37);
  assert.match(refused.stderr, /outside Git checkouts/);
});


test('cloud setup rejects tool paths that cannot be used in executable shebangs', { skip: !supported }, t => {
  const { base, env } = fixture(t);
  const result = run('bash', ['-c', '. "$1"', 'cloud-paths', path.join(cloud, 'paths.sh')],
    { ...env, NOTICEOS_CLOUD_TOOLS: path.join(base, 'tools with spaces') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not contain whitespace/);
});

test('cloud cache cleanup removes only owned paths inside the cloud caches', { skip: !supported }, t => {
  const { base, env } = fixture(t);
  const cache = env.NOTICEOS_CLOUD_CACHE;
  fs.mkdirSync(path.join(cache, 'fetch/key/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'download.tar.gz'), 'archive');
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'kept'), 'kept');
  fs.symlinkSync(outside, path.join(cache, 'linked'));
  const discard = (...paths) => run('bash', ['-c', '. "$1" && shift && noticeos_discard "$@"', 'cloud-discard', path.join(cloud, 'paths.sh'), ...paths], env);
  const removed = discard(path.join(cache, 'fetch'), path.join(cache, 'download.tar.gz'), path.join(cache, 'linked'), path.join(cache, 'missing'));
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(fs.readdirSync(cache), []);
  assert.equal(fs.readFileSync(path.join(outside, 'kept'), 'utf8'), 'kept', 'removing a link leaves its target');
  for (const target of [outside, cache, path.join(cache, '..', 'outside', 'kept')]) {
    const refused = discard(target);
    assert.notEqual(refused.status, 0, target);
    assert.match(refused.stderr, /outside the cloud caches/);
  }
  assert.ok(fs.existsSync(path.join(outside, 'kept')));
  assert.ok(fs.existsSync(cache));
});

test('default cloud preparation reconciles dependencies and fetches no browser, task tool or image', {
  skip: !supported || process.arch !== 'x64' || process.getuid?.() === 0,
}, t => {
  const { base, repo, env } = fixture(t);
  const free = Number(spawnSync('df', ['-Pk', base], { encoding: 'utf8' }).stdout.split('\n')[1]?.split(/\s+/)[3]);
  if (!(free >= 12 * 1024 * 1024)) { t.skip('preparation requires 12 GiB free'); return; }
  // The stub toolchain is this Node, so the fixture pins it.
  fs.writeFileSync(path.join(repo, '.github/workflows/ci.yml'), `node-version: ${process.versions.node}\n`);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'noticeos', engines: { node: `>=${process.versions.node}` }, packageManager: 'pnpm@12.8.1' }));
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture']]) {
    assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  }
  const pins = requirements(env);
  const calls = path.join(base, 'calls');
  const bin = path.join(pins.tools, 'node_modules/.bin'); fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\necho "pnpm $*" >> "$CLOUD_TEST_CALLS"\ncase "$1" in --version) echo ${pins.pnpm};; exec) exit 1;; install) mkdir -p node_modules;; esac\n`, { mode: 0o755 });
  const stubs = path.join(base, 'stubs'); fs.mkdirSync(stubs);
  for (const name of ['docker', 'npm']) fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\necho "${name} $*" >> "$CLOUD_TEST_CALLS"\nexit 1\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(env.NOTICEOS_CLOUD_CACHE, 'npm/_cacache'), { recursive: true });
  const prepare = (...args) => run('bash', [path.join(cloud, 'prepare.sh'), ...args], { ...env, CLOUD_TEST_CALLS: calls, PATH: `${stubs}:${process.env.PATH}` });
  const usage = prepare('--everything');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /\[--browser\] \[--with-deps\] \[--task-store\]/);
  const result = prepare();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Prepared checkout \w+ with dependency key/);
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /^pnpm .* fetch --store-dir \S+\/pnpm-store$/m);
  assert.match(log, /^pnpm install --offline --frozen-lockfile --store-dir \S+\/pnpm-store$/m);
  assert.doesNotMatch(log, /journey:install|task-store|^docker |^npm /m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/.noticeos-environment.json'))).key, pins.dependencies);
  assert.deepEqual(fs.readdirSync(env.NOTICEOS_CLOUD_CACHE).sort(), [], 'the npm download cache and the fetch staging folder are gone');
});
