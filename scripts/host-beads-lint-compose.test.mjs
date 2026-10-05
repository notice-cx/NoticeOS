// Generated server-mode tasks only; never use an inherited hub or spoke.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepareFreshDolt, startDoltPlan, doltExecutor, doltComposeArgs, doltEnvironment } from './dolt-host.mjs';
import { BEADS_VERSION, initDoltProject } from './dolt-project.mjs';
import { prepareHostBeads, readHostBeadsPlan, runHostBeads } from './host-beads.mjs';
import { containerProofCleanup } from './container-proof-cleanup.mjs';
import { runCommand } from './run-command.mjs';

test('pinned server-mode lint distinguishes checked tasks, warnings and failed lookups without a second validator', {
  skip: process.env.NOTICEOS_TEST_HOST_BEADS_LINT !== '1', timeout: 240_000,
}, async t => {
  const binary = process.env.NOTICEOS_TEST_BEADS_NEW_BIN;
  const image = process.env.NOTICEOS_TEST_BEADS_IMAGE;
  assert.ok(path.isAbsolute(binary ?? ''), 'Declare the exact pinned fixture client');
  assert.match(image ?? '', /^sha256:[0-9a-f]{64}$/u, 'Declare the exact qualified bundled client image');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-host-lint-proof-'));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'fixture'); fs.mkdirSync(home, { mode: 0o700 });
  const plan = { root: path.resolve(import.meta.dirname, '..'), home, port: 6200 };
  const profile = startDoltPlan(plan);
  const env = { ...Object.fromEntries(['PATH', 'DOCKER_CONFIG', 'DOCKER_HOST', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    HOME: path.join(base, 'home'), TMPDIR: path.join(base, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  for (const name of ['home', 'tmp']) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
  const repo = path.join(home, 'spoke');
  const wrapperHome = path.join(base, 'client');
  const credentials = path.join(wrapperHome, 'credentials');
  const cleanupHome = path.join(base, 'cleanup'); fs.mkdirSync(cleanupHome, { mode: 0o700 });
  const cleanup = containerProofCleanup({ base: cleanupHome, project: profile.project, image,
    mounts: [{ source: path.join(repo, '.beads'), destination: '/spoke/.beads' },
      { source: path.join(repo, '.beads.gate.lock'), destination: '/spoke/.beads.gate.lock' },
      { source: credentials, destination: '/client/credentials' }],
    runDocker: (args, options) => runCommand('docker', args, { env, ...options }) });
  let fresh = false, execute;
  const evidence = { clientVersion: BEADS_VERSION, binarySHA256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), image,
    project: profile.project, port: profile.port, results: [] };
  t.after(async () => {
    if (fresh) {
      execute ??= await doltExecutor(profile, { env });
      evidence.cleanup = await cleanup.finish([() => execute([...doltComposeArgs(profile), 'down', '--volumes'], 90_000)]);
      const absent = await execute(['volume', 'inspect', `${profile.project}_dolt-data`]);
      assert.notEqual(absent.code, 0); assert.match(absent.stderr, /no such volume/iu);
      evidence.volumeAbsent = true;
    }
    // Compact evidence is emitted before the verified disposable files retire.
    t.diagnostic(JSON.stringify(evidence));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const capacity = fs.statfsSync(base);
  assert.ok(Number(capacity.bavail) * Number(capacity.bsize) >= 9 * 2**30, 'Keep an 8 GiB floor after the bounded fixture allocation');
  await cleanup.proveFresh(); fresh = true;
  const prepared = await prepareFreshDolt(plan, { fresh: true, env }); assert.equal(prepared.ok, true, prepared.line);
  execute = await doltExecutor(profile, { env });
  fs.mkdirSync(repo, { mode: 0o700 });
  assert.equal((await runCommand('git', ['init', '--quiet', repo], { cwd: base, env })).code, 0);
  const initialized = await initDoltProject({ home, repo, prefix: 'no', database: 'synthetic_tasks' }, { env, binary });
  assert.equal(initialized.ok, true, initialized.line);
  const bd = args => runCommand(binary, ['--sandbox', ...args], { cwd: repo,
    env: { ...doltEnvironment(profile, env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }, timeoutMs: 60_000 });
  const version = await bd(['version']); assert.equal(version.code, 0);
  assert.match(version.stdout, new RegExp(`^bd version ${BEADS_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`, 'u'));
  const create = async (title, args) => {
    const result = await bd(['create', title, '--type', 'task', '--description', 'Generated fixture only.', ...args, '--json']);
    assert.equal(result.code, 0); return JSON.parse(result.stdout).id;
  };
  const valid = await create('Synthetic valid task', ['--acceptance', 'The fixture behavior is verified.']);
  const incomplete = await create('Synthetic incomplete task', []);
  for (const id of [valid, incomplete]) {
    const result = await bd(['show', id, '--json']); assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout)[0].id, id);
  }
  const zero = await bd(['lint', valid, '--json']); assert.equal(zero.code, 0);
  assert.deepEqual(JSON.parse(zero.stdout), { total: 0, issues: 0, results: null });
  const warning = await bd(['lint', incomplete, '--json']); assert.equal(warning.code, 0);
  assert.equal(JSON.parse(warning.stdout).results[0].id, incomplete);
  assert.equal(JSON.parse(warning.stdout).total, 1);
  const missing = await bd(['lint', valid, 'no-nonexistent', '--json']); assert.equal(missing.code, 0);
  assert.match(missing.stderr, /^Error getting no-nonexistent:/mu);
  evidence.nativeJSON = { zero: JSON.parse(zero.stdout), warning: JSON.parse(warning.stdout), missingExit: missing.code };
  if (!fs.existsSync(path.join(repo, '.beads.gate.lock'))) fs.writeFileSync(path.join(repo, '.beads.gate.lock'), '', { mode: 0o600, flag: 'wx' });
  const declaration = path.join(base, 'prepare.json');
  fs.writeFileSync(declaration, JSON.stringify({ format: 'noticeos-host-beads-prepare-v1', directory: wrapperHome,
    doltHome: home, image, spokes: [repo], fallbackActor: 'synthetic-lint-verifier' }), { mode: 0o600 });
  const wrapper = prepareHostBeads(declaration); readHostBeadsPlan(wrapper.plan);
  let oneOffs = 0;
  const run = async (command, args, options) => {
    if (command !== 'docker' || args[0] !== 'run') return runCommand(command, args, options);
    oneOffs++;
    return cleanup.oneOff(launch => {
      const name = launch[launch.indexOf('--name') + 1];
      return runCommand(command, ['run', '--detach', '--name', name,
        '--label', `com.docker.compose.project=${profile.project}`, '--label', 'com.docker.compose.service=noticeos', '--label', 'com.docker.compose.oneoff=True',
        ...args.slice(1).filter(arg => arg !== '--rm')], options);
    }, { timeoutMs: 60_000 });
  };
  const wrapped = async args => {
    const result = await runHostBeads(wrapper.plan, ['--sandbox', ...args], { cwd: repo, env, run });
    evidence.results.push({ args, code: result.code, stdout: result.stdout, stderr: result.stderr }); return result;
  };
  assert.match((await wrapped(['version'])).stdout, new RegExp(`^bd version ${BEADS_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`, 'u'));
  const checked = await wrapped(['lint', valid]); assert.equal(checked.code, 0); assert.match(checked.stdout, /\(1 issues checked\)/u);
  assert.equal((await wrapped(['lint', incomplete])).code, 1);
  for (const args of [['lint', 'no-nonexistent'], ['lint', valid, 'no-nonexistent', '--status', 'all']]) {
    const result = await wrapped(args); assert.equal(result.code, 1); assert.match(result.stderr, /^Error getting no-nonexistent:/mu);
  }
  const before = oneOffs;
  for (const args of [['--json', 'lint', valid], ['lint', valid, incomplete, '--json']]) {
    const result = await wrapped(args); assert.equal(result.code, 1); assert.match(result.stderr, /without --json/u);
  }
  assert.equal(oneOffs, before, 'JSON lint refuses before any client container launches');
});
