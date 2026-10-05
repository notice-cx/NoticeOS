// Disposable hub and generated spoke only. The app service is never started.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startDoltPlan, prepareFreshDolt, doltExecutor, doltComposeArgs, doltEnvironment, readDoltCredentials } from './dolt-host.mjs';
import { BEADS_VERSION } from './dolt-project.mjs';
import { runCommand } from './run-command.mjs';
import { runHostBeads } from './host-beads.mjs';

test('bundled host-agent client reads and writes a generated task while the application is stopped', {
  skip: process.env.NOTICEOS_TEST_HOST_BEADS !== '1', timeout: 180_000,
}, async t => {
  const image = process.env.NOTICEOS_TEST_HOST_BEADS_IMAGE;
  const binary = process.env.NOTICEOS_TEST_HOST_BEADS_BIN;
  assert.match(image ?? '', /^sha256:[0-9a-f]{64}$/u);
  assert.ok(path.isAbsolute(binary ?? ''), 'Declare the exact current qualification binary');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-host-beads-compose-'));
  const home = path.join(base, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const plan = { root: path.resolve(import.meta.dirname, '..'), home, port: 5340 };
  const profile = startDoltPlan(plan);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const execute = await doltExecutor(profile, { env });
  t.after(async () => {
    assert.equal((await execute([...doltComposeArgs(profile), 'down', '--volumes'], 90_000)).code, 0);
    fs.rmSync(base, { recursive: true, force: true });
  });
  assert.equal((await prepareFreshDolt(plan, { fresh: true, env })).ok, true);
  const sql = await execute([...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', 'CREATE DATABASE synthetic_tasks']);
  assert.equal(sql.code, 0);
  const spoke = path.join(base, 'spoke'); fs.mkdirSync(spoke, { mode: 0o700 });
  const clientEnv = { ...doltEnvironment(profile, env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    BEADS_DOLT_PASSWORD: readDoltCredentials(profile).noticeos.trim() };
  assert.equal((await runCommand('git', ['init', '--quiet', spoke], { env: clientEnv, cwd: base })).code, 0);
  const initialized = await runCommand(binary, ['init', '--server', '--external', '--server-host', '127.0.0.1',
    '--server-port', String(profile.port), '--server-user', 'noticeos', '--database', 'synthetic_tasks', '--prefix', 'no',
    '--non-interactive', '--skip-hooks', '--skip-agents'], { env: clientEnv, cwd: spoke });
  assert.equal(initialized.code, 0, 'Owned spoke initialization failed; raw diagnostics withheld');
  fs.appendFileSync(path.join(spoke, '.beads/config.yaml'), '\nno-git-ops: true\nimport.auto: false\n');
  fs.writeFileSync(path.join(spoke, '.beads.gate.lock'), '', { mode: 0o600 });
  const credentials = path.join(base, 'container-credentials');
  fs.writeFileSync(credentials, `[dolt:3306]\npassword=${readDoltCredentials(profile).noticeos.trim()}\n`, { mode: 0o600 });
  const clientProfile = path.join(base, 'container-client.json');
  fs.writeFileSync(clientProfile, JSON.stringify({ host: 'dolt', port: 3306, user: 'noticeos', credentialsFile: credentials,
    clientHome: path.join(home, 'dolt/client-home') }), { mode: 0o600 });
  const declaration = path.join(base, 'host-client.json');
  fs.writeFileSync(declaration, JSON.stringify({ format: 'noticeos-host-beads-v1', image, network: `${profile.project}_default`,
    clientProfile, spokes: [spoke], fallbackActor: 'synthetic-host-operator' }), { mode: 0o600 });
  const poisoned = { ...env, BEADS_DOLT_SERVER_HOST: 'source.invalid', BEADS_DOLT_SERVER_PORT: '3308', BEADS_DOLT_SERVER_USER: 'root', BEADS_DOLT_PASSWORD: 'synthetic-poison' };
  const bd = async args => {
    const result = await runHostBeads(declaration, ['-C', spoke, ...args], { cwd: base, env: poisoned });
    if (result.code) t.diagnostic(result.stderr.slice(-1000));
    assert.equal(result.stderr.includes('workspace gate acquisition failed'), false, 'Compatibility actions share the real workspace lock');
    assert.equal(result.code, 0, 'Owned bundled client operation failed'); return result.stdout;
  };
  assert.match(await bd(['version']), new RegExp(`^bd version ${BEADS_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`, 'u'));
  const task = JSON.parse(await bd(['create', 'Synthetic host-agent task', '--description', 'Bundled client test', '--json']));
  assert.match(task.id, /^no-[a-z0-9]+$/u);
  assert.equal(task.created_by, 'synthetic-host-operator');
  const audit = await execute([...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root',
    `USE synthetic_tasks; SELECT event_type,actor FROM events WHERE issue_id='${task.id}' ORDER BY id`]);
  assert.equal(audit.code, 0);
  const events = JSON.parse(audit.stdout.trim().split('\n').at(-1)).rows;
  assert.ok(events.some(event => event.event_type === 'created' && event.actor === 'synthetic-host-operator'), 'Task creation audit retains the declared caller identity');
  assert.equal(JSON.parse(await bd(['show', task.id, '--json']))[0].id, task.id);
  await bd(['update', task.id, '--claim', '--actor', 'synthetic-host-agent']);
  const claimed = JSON.parse(await bd(['show', task.id, '--json']))[0];
  assert.equal(claimed.status, 'in_progress'); assert.equal(claimed.assignee, 'synthetic-host-agent');
  await bd(['close', task.id, '--reason', 'Synthetic wrapper proof', '--actor', 'synthetic-host-agent']);
  assert.equal(JSON.parse(await bd(['show', task.id, '--json']))[0].status, 'closed');
  const services = await execute([...doltComposeArgs(profile), 'ps', '--all', '--services']);
  assert.deepEqual(services.stdout.trim().split('\n'), ['dolt'], 'No application service was needed for compatibility access');
  assert.equal(JSON.parse(fs.readFileSync(path.join(spoke, '.beads/metadata.json'))).dolt_server_port, profile.port,
    'Poisoned selectors cannot rewrite the generated spoke to the native source');
});
