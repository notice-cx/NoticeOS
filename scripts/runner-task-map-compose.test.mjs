import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from './run-command.mjs';
import { startDoltPlan, prepareFreshDolt, doltExecutor, doltComposeArgs, doltEnvironment } from './dolt-host.mjs';
import { initDoltProject } from './dolt-project.mjs';
import { runTaskMapCheck, beadsShowDatabasesArgs } from './runner/task-map.mjs';

const enabled = process.env.NOTICEOS_TEST_TASK_MAP_COMPOSE === '1';
const ROOT = path.resolve(import.meta.dirname, '..');

test('task-map inventory uses a real fresh spoke and the bundled container client, never the installation state folder', { skip: !enabled, timeout: 180_000 }, async t => {
  const binary = process.env.NOTICEOS_TEST_TASK_MAP_BD;
  const image = process.env.NOTICEOS_TEST_TASK_MAP_IMAGE;
  assert.ok(binary && path.isAbsolute(binary));
  assert.match(image ?? '', /^noticeos-local:compose-proof-[a-z0-9]+$/u);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-task-map-compose-'));
  const home = path.join(base, 'state');
  fs.mkdirSync(home, { mode: 0o700 });
  let cleanServices = null;
  t.after(async () => { await cleanServices?.(); fs.rmSync(base, { recursive: true, force: true }); });
  const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'TMPDIR', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const plan = { root: ROOT, home, port: 5800 };
  const profile = startDoltPlan(plan);
  const execute = await doltExecutor(profile, { env });
  const args = doltComposeArgs(profile);
  const absent = await execute([...args, 'ps', '--all', '--quiet', 'dolt']);
  assert.equal(absent.code, 0); assert.equal(absent.stdout.trim(), '');
  const volume = await execute(['volume', 'inspect', `${profile.project}_dolt-data`]);
  assert.notEqual(volume.code, 0); assert.match(volume.stderr, /no such volume/iu);
  cleanServices = async () => assert.equal((await execute([...args, 'down', '--volumes'])).code, 0, 'remove only the proven new fixture project');
  const hosted = await prepareFreshDolt(plan, { fresh: true, env });
  assert.equal(hosted.ok, true, hosted.line);
  const repo = path.join(home, 'tasks/core');
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  const ownEnv = { ...doltEnvironment(profile, env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const git = await runCommand('git', ['init', '--quiet', repo], { cwd: base, env: ownEnv });
  assert.equal(git.code, 0);
  for (const [key, value] of [['user.name', 'NoticeOS fixture'], ['user.email', 'noticeos@example.invalid']]) {
    assert.equal((await runCommand('git', ['-C', repo, 'config', '--local', key, value], { cwd: repo, env: ownEnv })).code, 0);
  }
  const initialized = await initDoltProject({ home, repo, prefix: 'no', database: 'noticeos_tasks' }, { env, binary });
  assert.equal(initialized.ok, true, initialized.line);
  const run = argv => runCommand(binary, argv, { cwd: home, env: ownEnv, timeoutMs: 20_000 });
  const refused = await run(beadsShowDatabasesArgs(home));
  assert.equal(refused.code, 1); assert.match(refused.stderr, /no beads project found/u);
  assert.equal(fs.existsSync(path.join(home, '.beads')), false);
  const lines = [];
  const result = await runTaskMapCheck({
    readConfig: async () => JSON.stringify({ spokes: [{ asset: 'os.example', prefix: 'no', database: 'noticeos_tasks', repo }] }),
    homeAsset: async () => 'os.example', run, stopped: () => false,
    state: { skipping: null }, emit: (level, text) => lines.push(`${level} ${text}`),
  });
  assert.equal(result?.checked, 1, JSON.stringify(lines));
  assert.deepEqual(result.drift, []); assert.deepEqual(result.filed, []); assert.deepEqual(result.closed, []);

  // The app's absolute linked-spoke path uses the same initialized task data.
  // Only this synthetic copy changes endpoints for the container network.
  const containerRepo = path.join(base, 'container-core');
  fs.cpSync(repo, containerRepo, { recursive: true });
  const metadataFile = path.join(containerRepo, '.beads/metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  metadata.dolt_server_host = 'dolt'; metadata.dolt_server_port = 3306;
  fs.writeFileSync(metadataFile, JSON.stringify(metadata), { mode: 0o600 });
  const credentials = fs.readFileSync(profile.credentialsFile, 'utf8').replace(`[127.0.0.1:${profile.port}]`, '[dolt:3306]');
  const credentialsFile = path.join(base, 'container-credentials');
  fs.writeFileSync(credentialsFile, credentials, { mode: 0o600 });
  const definition = await execute([...args, 'config', '--format', 'json']);
  assert.equal(definition.code, 0);
  const isolated = JSON.parse(definition.stdout);
  isolated.networks = { default: { name: `${profile.project}_default`, internal: true } };
  const isolatedFile = path.join(base, 'isolated.json');
  fs.writeFileSync(isolatedFile, JSON.stringify(isolated), { mode: 0o600 });
  assert.equal((await execute([...args, 'down'])).code, 0);
  const isolatedArgs = ['compose', '-p', profile.project, '-f', isolatedFile, '--env-file', os.devNull];
  assert.equal((await execute([...isolatedArgs, 'up', '--detach', '--wait', '--wait-timeout', '60', 'dolt'], 90_000)).code, 0);
  assert.equal((await execute(['network', 'inspect', `${profile.project}_default`, '--format', '{{.Internal}}'])).stdout.trim(), 'true');
  const code = `
import assert from 'node:assert/strict';
import { runTaskMapCheck } from './scripts/runner/task-map.mjs';
import { runCommand } from './scripts/run-command.mjs';
const result = await runTaskMapCheck({
  readConfig: async () => JSON.stringify({spokes:[{asset:'os.example',prefix:'no',database:'noticeos_tasks',repo:'/spokes/core'}]}),
  homeAsset: async () => 'os.example', stopped: () => false, state: {skipping:null}, emit: () => {},
  run: argv => runCommand('/usr/local/bin/bd', argv, {cwd:'/state',env:process.env,timeoutMs:20000}),
});
assert.equal(result?.checked,1); assert.deepEqual(result.drift,[]); assert.deepEqual(result.filed,[]); assert.deepEqual(result.closed,[]);
console.log('linked container task-map passed');`;
  const checked = await execute(['run', '--rm', '--pull', 'never', '--network', `${profile.project}_default`, '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${home},target=/state,readonly`,
    '--mount', `type=bind,source=${containerRepo},target=/spokes/core`,
    '--mount', `type=bind,source=${credentialsFile},target=/fixture-credentials,readonly`,
    '--mount', `type=bind,source=${path.join(ROOT, 'scripts/runner/task-map.mjs')},target=/opt/noticeos/scripts/runner/task-map.mjs,readonly`,
    '--env', 'NOTICEOS_HOME=/state', '--env', 'HOME=/tmp/task-map-client', '--env', 'XDG_CONFIG_HOME=/tmp/task-map-client/.config',
    '--env', 'BEADS_CREDENTIALS_FILE=/fixture-credentials', '--env', 'BEADS_DOLT_SERVER_MODE=1', '--env', 'BEADS_DOLT_SERVER_HOST=dolt',
    '--env', 'BEADS_DOLT_SERVER_PORT=3306', '--env', 'BEADS_DOLT_SERVER_USER=noticeos', '--env', 'BEADS_DOLT_AUTO_START=0',
    '--env', 'BD_DISABLE_METRICS=1', '--env', 'BD_DISABLE_ERROR_REPORTING=1', '--env', 'DO_NOT_TRACK=1',
    '--entrypoint', 'node', image, '--input-type=module', '-e', code], 40_000);
  assert.equal(checked.code, 0, 'bundled container task-map query succeeded; raw output withheld');
  assert.match(checked.stdout, /linked container task-map passed/u);
});
