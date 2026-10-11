// deploy/compose/noticeos, run by a real POSIX shell against a stand-in
// `docker` that records each call and answers the few questions the
// launcher asks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY } from './published-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'deploy/compose/noticeos');
const APP_IMAGE = `sha256:${'a'.repeat(64)}`;

function box(t) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nos-launcher-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  const log = path.join(base, 'docker.log');
  // Each call is one JSON line; FAKE_* say what this Docker has.
  writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2); const env = process.env;
fs.appendFileSync(env.FAKE_LOG, JSON.stringify(args) + '\\n');
const say = (text) => process.stdout.write(text + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') process.exit(env.FAKE_LOCAL === args[2] ? 0 : 1);
if (args[0] === 'ps') { if (env.FAKE_APP) say(env.FAKE_APP); process.exit(0); }
if (args[0] === 'inspect') { say(env.FAKE_APP_IMAGE); process.exit(0); }
if (args[0] === 'network') { if (env.FAKE_NETWORK) say(env.FAKE_NETWORK); process.exit(0); }
process.exit(Number(env.FAKE_PULL_CODE ?? 0) && args[0] === 'pull' ? Number(env.FAKE_PULL_CODE) : 0);
`, { mode: 0o755 });
  const home = path.join(base, 'home');
  mkdirSync(home);
  const launch = (script, args, { env = {}, cwd = base } = {}) => {
    writeFileSync(log, '');
    const result = spawnSync('sh', [script, ...args], { cwd, encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: log, FAKE_APP_IMAGE: APP_IMAGE, ...env } });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls, run: calls.find((call) => call[0] === 'run') ?? null };
  };
  /** An installation folder with its own launcher, as setup leaves it. */
  const installation = (name = 'inst') => {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'installation.env'), `COMPOSE_PROJECT_NAME="nos-test"\nNOTICEOS_APP_IMAGE="${APP_IMAGE}"\n`);
    copyFileSync(LAUNCHER, path.join(dir, 'noticeos'));
    chmodSync(path.join(dir, 'noticeos'), 0o755);
    return dir;
  };
  return { base, home, launch, installation };
}

/** The value after `flag` in a docker run's arguments, for each time it appears. */
const after = (args, flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);

test('the launcher fetches the image from the repository the release workflow publishes to', () => {
  assert.match(readFileSync(LAUNCHER, 'utf8'), new RegExp(`^repository=${RELEASE_REPOSITORY.replaceAll('.', '\\.')}$`, 'mu'));
  assert.ok(statSync(LAUNCHER).mode & 0o100, 'the launcher is executable');
});

test('setup makes a private ~/noticeos and runs main\'s newest image there as the host user, with the socket and nothing else', (t) => {
  const own = box(t);
  const result = own.launch(LAUNCHER, ['setup', '--tower-port', '6000']);
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(own.home, 'noticeos');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(result.calls[0], ['pull', '--quiet', `${RELEASE_REPOSITORY}:main`]);
  const run = result.run;
  assert.deepEqual(run.slice(0, 6), ['run', '--rm', '--interactive', '--init', '--user', '0:0']);
  assert.deepEqual(after(run, '--mount'), ['type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', `type=bind,source=${dir},target=${dir}`]);
  const env = after(run, '--env');
  assert.ok(env.includes(`NOTICEOS_HOST_UID=${process.getuid()}`) && env.includes(`NOTICEOS_HOST_GID=${process.getgid()}`));
  assert.ok(env.includes(`NOTICEOS_CLI_IMAGE=${RELEASE_REPOSITORY}:main`) && env.includes(`NOTICEOS_DIR=${dir}`) && env.includes(`NOTICEOS_LAUNCHER=${dir}/noticeos`));
  assert.deepEqual(run.slice(run.indexOf('--entrypoint')), ['--entrypoint', 'node', `${RELEASE_REPOSITORY}:main`, 'scripts/noticeos-cli.mjs', 'setup', '--dir', dir, '--tower-port', '6000']);
  assert.equal(run.includes('--network'), false);
});

test('setup\'s folders are made absolute here, the offsite folder is shared too, and a missing one is refused', (t) => {
  const own = box(t);
  mkdirSync(path.join(own.base, 'sync'));
  const result = own.launch(LAUNCHER, ['setup', '--dir', 'nested/inst', '--offsite=sync', '--without-backup']);
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(own.base, 'nested/inst');
  const offsite = path.join(own.base, 'sync');
  assert.ok(existsSync(dir));
  assert.ok(after(result.run, '--mount').includes(`type=bind,source=${offsite},target=${offsite}`));
  assert.deepEqual(result.run.slice(result.run.indexOf('setup')), ['setup', '--offsite', offsite, '--dir', dir, '--without-backup']);
  const missing = own.launch(LAUNCHER, ['setup', '--dir', 'other', '--offsite', 'absent']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /the offsite folder .*absent does not exist/u);
  assert.equal(missing.run, null);
  const comma = own.launch(LAUNCHER, ['setup', '--dir', 'a,b']);
  assert.equal(comma.status, 1);
  assert.match(comma.stderr, /comma/u);
});

test('NOTICEOS_IMAGE runs a local image without fetching it, and fetches one that is not here', (t) => {
  const own = box(t);
  const local = own.launch(LAUNCHER, ['setup'], { env: { NOTICEOS_IMAGE: 'noticeos-local:abc', FAKE_LOCAL: 'noticeos-local:abc' } });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.calls.some((call) => call[0] === 'pull'), false);
  assert.ok(local.run.includes('noticeos-local:abc'));
  const remote = own.launch(LAUNCHER, ['setup', '--dir', 'two'], { env: { NOTICEOS_IMAGE: 'example.com/noticeos:pinned' } });
  assert.deepEqual(remote.calls.find((call) => call[0] === 'pull'), ['pull', '--quiet', 'example.com/noticeos:pinned']);
  const offline = own.launch(LAUNCHER, ['setup', '--dir', 'three'], { env: { FAKE_PULL_CODE: '1' } });
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /could not fetch/u);
});

test('the installation\'s own launcher runs a command from the image its app runs, named as it was called', (t) => {
  const own = box(t);
  const dir = own.installation();
  const running = own.launch('./noticeos', ['logs', '--lines', '5'], { cwd: dir, env: { FAKE_APP: 'c0ffee' } });
  assert.equal(running.status, 0, running.stderr);
  assert.equal(running.calls.some((call) => call[0] === 'pull'), false);
  assert.ok(running.calls.some((call) => call.includes('label=com.docker.compose.project=nos-test')));
  assert.deepEqual(running.run.slice(running.run.indexOf('--entrypoint')), ['--entrypoint', 'node', APP_IMAGE, 'scripts/noticeos-cli.mjs', 'logs', '--lines', '5']);
  assert.ok(after(running.run, '--env').includes('NOTICEOS_LAUNCHER=./noticeos'));
  assert.ok(after(running.run, '--env').includes(`NOTICEOS_DIR=${dir}`));
  const stopped = own.launch(path.join(dir, 'noticeos'), ['status'], { env: { FAKE_APP_IMAGE: 'unused' } });
  assert.ok(stopped.run.includes(APP_IMAGE), 'with no app container, the image installation.env names');
});

test('update and migrate run main\'s newest image; migrate joins the installation\'s network', (t) => {
  const own = box(t);
  const dir = own.installation();
  const update = own.launch(path.join(dir, 'noticeos'), ['update']);
  assert.deepEqual(update.calls[0], ['pull', '--quiet', `${RELEASE_REPOSITORY}:main`]);
  assert.ok(update.run.includes(`${RELEASE_REPOSITORY}:main`));
  const migrate = own.launch(path.join(dir, 'noticeos'), ['migrate', '--apply'], { env: { FAKE_NETWORK: 'net123' } });
  assert.deepEqual(after(migrate.run, '--network'), ['net123']);
  const lost = own.launch(path.join(dir, 'noticeos'), ['migrate'], {});
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /network is missing/u);
});

test('mcp and bd run inside the running app itself, with this terminal\'s input, and say so when it is stopped', (t) => {
  const own = box(t);
  const dir = own.installation();
  const mcp = own.launch(path.join(dir, 'noticeos'), ['mcp', '--actor', 'agent-1'], { env: { FAKE_APP: 'c0ffee' } });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.ok(mcp.calls.some(call => call[0] === 'ps' && call.includes('label=com.docker.compose.project=nos-test') && !call.includes('--all')));
  assert.deepEqual(mcp.calls.at(-1), ['exec', '--interactive', 'c0ffee', 'node', 'deploy/compose/entrypoint.mjs', 'mcp', '--actor', 'agent-1']);
  assert.equal(mcp.run, null, 'no second container');
  const bd = own.launch(path.join(dir, 'noticeos'), ['bd', 'ready', '--json'], { env: { FAKE_APP: 'c0ffee' } });
  assert.deepEqual(bd.calls.at(-1), ['exec', '--interactive', 'c0ffee', 'node', 'deploy/compose/entrypoint.mjs', 'bd', 'ready', '--json']);
  const stopped = own.launch(path.join(dir, 'noticeos'), ['mcp']);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /the app is not running; .*noticeos start starts it/u);
  assert.equal(stopped.calls.some(call => call[0] === 'exec'), false);
});

test('mcp at a terminal says how to connect it and runs nothing', (t) => {
  const own = box(t);
  const dir = own.installation();
  // `script` gives the launcher a terminal for its input, as a person's shell would (util-linux and BSD spell it differently).
  const command = ['sh', path.join(dir, 'noticeos'), 'mcp'];
  const args = process.platform === 'linux' ? ['-qec', command.join(' '), '/dev/null'] : ['-q', '/dev/null', ...command];
  const result = spawnSync('script', args, { encoding: 'utf8',
    env: { PATH: `${path.join(own.base, 'bin')}:${process.env.PATH}`, HOME: own.home, FAKE_LOG: path.join(own.base, 'docker.log') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.replaceAll('\r', ''), new RegExp(`at a terminal it does not run\\.\\ninstallation\\.env names no Tower port, so connect this command instead:\\n  claude mcp add --scope user noticeos -- ${dir.replaceAll('.', '\\.')}/noticeos mcp --actor claude\\n`, 'u'),
    'an installation.env naming no Tower port has only the command');
  writeFileSync(path.join(dir, 'installation.env'), `COMPOSE_PROJECT_NAME="nos-test"\nNOTICEOS_TOWER_PORT="5180"\n`);
  const loopback = spawnSync('script', process.platform === 'linux' ? ['-qec', `${command.join(' ')} --actor dev-1`, '/dev/null'] : ['-q', '/dev/null', ...command, '--actor', 'dev-1'],
    { encoding: 'utf8', env: { PATH: `${path.join(own.base, 'bin')}:${process.env.PATH}`, HOME: own.home, FAKE_LOG: path.join(own.base, 'docker.log') } });
  assert.match(loopback.stdout.replaceAll('\r', ''), /The Tower serves the same tools; connect it for every repository:\n  claude mcp add --scope user --transport http noticeos http:\/\/127\.0\.0\.1:5180\/api\/mcp --header 'X-NoticeOS-Actor: dev-1'\n/u);
  writeFileSync(path.join(dir, 'installation.env'), `COMPOSE_PROJECT_NAME="nos-test"\nNOTICEOS_TOWER_BIND="0.0.0.0"\nNOTICEOS_TOWER_PORT="5180"\n`);
  const network = spawnSync('script', process.platform === 'linux' ? ['-qec', command.join(' '), '/dev/null'] : ['-q', '/dev/null', ...command],
    { encoding: 'utf8', env: { PATH: `${path.join(own.base, 'bin')}:${process.env.PATH}`, HOME: own.home, FAKE_LOG: path.join(own.base, 'docker.log') } });
  assert.match(network.stdout.replaceAll('\r', ''), /The Tower serves the same tools; connect it for every repository:\n  claude mcp add --scope user --transport http noticeos http:\/\/127\.0\.0\.1:5180\/api\/mcp --header 'X-NoticeOS-Actor: claude'\n/u,
    'a Tower on every interface answers on loopback too');
  assert.equal(existsSync(path.join(own.base, 'docker.log')) && readFileSync(path.join(own.base, 'docker.log'), 'utf8').includes('"exec"'), false);
});

test('outside an installation folder, or with no or an unknown command, it says what to do and runs nothing', (t) => {
  const own = box(t);
  const stray = path.join(own.base, 'stray');
  mkdirSync(stray);
  copyFileSync(LAUNCHER, path.join(stray, 'noticeos'));
  for (const [script, args, pattern] of [[path.join(stray, 'noticeos'), ['status'], /holds no installation\.env/u],
    [LAUNCHER, [], /name a command/u], [path.join(own.installation(), 'noticeos'), ['convert-legacy'], /is not a command/u]]) {
    const result = own.launch(script, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, pattern);
    assert.equal(result.run, null);
  }
});
