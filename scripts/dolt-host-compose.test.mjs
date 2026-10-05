import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { devNull } from 'node:os';
import { runCommand } from './run-command.mjs';
import { startDoltPlan, prepareFreshDolt, doltExecutor, doltComposeArgs, doltEnvironment, readDoltCredentials, DOLT_VERSION } from './dolt-host.mjs';
import { BEADS_VERSION } from './dolt-project.mjs';
import { backupDolt, restoreDolt } from './dolt-backup.mjs';

function executable(name) {
  const selected = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    .map(directory => path.join(directory, name)).find(file => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
    });
  assert.ok(selected, `The explicit Dolt Compose proof needs ${name} on its tooling PATH`);
  return selected;
}

// Explicit opt-in only: fixed non-production ports, new homes/projects/volumes.
test('pinned Dolt persists Beads history and grants, and restores an online snapshot independently', {
  skip: process.env.NOTICEOS_TEST_DOLT_COMPOSE !== '1', timeout: 300_000,
}, async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const beadsBinary = process.env.BEADS_BD_BIN ?? executable('bd');
  const doltBinary = executable('dolt');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-dolt-compose-'));
  const sourceHome = path.join(base, 'source');
  const targetHome = path.join(base, 'restored');
  fs.mkdirSync(sourceHome); fs.mkdirSync(targetHome);
  const plans = [{ root, home: sourceHome, port: 5340 }, { root, home: targetHome, port: 5344 }];
  const profiles = plans.map(startDoltPlan);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  const executors = await Promise.all(profiles.map(profile => doltExecutor(profile, { env })));
  const okay = (result, phase) => {
    assert.equal(result.code, 0, `${phase} failed (code ${result.code}); raw output intentionally withheld`);
    return result.stdout;
  };
  t.after(async () => {
    for (const [index, profile] of profiles.entries()) {
      const execute = executors[index];
      okay(await execute([...doltComposeArgs(profile), 'down', '--volumes'], 90_000), 'owned cleanup');
      const absent = await execute(['volume', 'inspect', `${profile.project}_dolt-data`]);
      assert.notEqual(absent.code, 0, 'own volume was removed');
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const hosted = await prepareFreshDolt(plans[0], { fresh: true, env });
  if (!hosted.ok) {
    const logs = await executors[0]([...doltComposeArgs(profiles[0]), 'logs', '--no-color', '--tail', '30', 'dolt']);
    t.diagnostic(`Owned startup: ${logs.stdout.replace(/[0-9a-f]{64}/gu, '[redacted]').slice(-4000)}`);
  }
  assert.equal(hosted.ok, true, hosted.line);
  const execute = executors[0];
  const args = doltComposeArgs(profiles[0]);
  const sql = async (query, executor = execute, profile = profiles[0]) => {
    const result = await executor([...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', query]);
    if (result.code !== 0) t.diagnostic(`Owned SQL: ${result.stderr.replace(/[0-9a-f]{64}/gu, '[redacted]').slice(-3000)}`);
    return okay(result, 'owned SQL').trim().split('\n').map(line => JSON.parse(line)).at(-1).rows;
  };
  assert.deepEqual(await sql('SELECT DOLT_VERSION() AS version'), [{ version: DOLT_VERSION }]);
  const denied = async (executor, profile) => {
    const empty = await executor([...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt', 'env', 'DOLT_CLI_PASSWORD=',
      'dolt', '--host=127.0.0.1', '--port=3306', '--user=root', '--no-tls', '--password', '', 'sql', '--query', 'SELECT 1']);
    assert.notEqual(empty.code, 0, 'container root/empty password must fail');
    assert.match(empty.stderr + empty.stdout, /Access denied/iu);
    const ownEnv = doltEnvironment(profile, env);
    const host = await runCommand(doltBinary, ['--host=127.0.0.1', `--port=${profile.port}`, '--user=root', '--no-tls', '--password', '', 'sql', '--query', 'SELECT 1'], { env: ownEnv, cwd: base });
    assert.notEqual(host.code, 0, 'host root/empty password must fail');
    assert.match(host.stderr + host.stdout, /Access denied/iu);
  };
  await denied(execute, profiles[0]);
  const repo = path.join(sourceHome, 'tasks'); fs.mkdirSync(repo);
  const ownEnv = { ...doltEnvironment(profiles[0], env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  const bd = async (command, selected = ownEnv) => {
    const result = await runCommand(beadsBinary, command, { env: selected, cwd: repo, timeoutMs: 90_000 });
    if (result.code !== 0) t.diagnostic(`Owned Beads ${command[0]}: ${result.stderr.replace(/[0-9a-f]{64}/gu, '[redacted]').slice(-3000)}`);
    return okay(result, `Beads ${command[0]}`);
  };
  assert.match(await bd(['version']), new RegExp(`^bd version ${BEADS_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`, 'u'));
  okay(await runCommand('git', ['init', '--quiet', repo], { env: ownEnv, cwd: base }), 'own git init');
  okay(await execute([...args, 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'noticeos', 'CREATE DATABASE noticeos_tasks']), 'own empty database reservation');
  // Only this init child receives
  // the generated password. Every ordinary task command uses the INI alone.
  await bd(['init', '--server', '--external', '--server-host', '127.0.0.1', '--server-port', String(profiles[0].port), '--server-user', 'noticeos', '--database', 'noticeos_tasks', '--prefix', 'no', '--non-interactive', '--skip-agents', '--skip-hooks'], {
    ...ownEnv, BEADS_DOLT_PASSWORD: readDoltCredentials(profiles[0]).noticeos.trim(),
  });
  const configFile = path.join(repo, '.beads/config.yaml');
  fs.appendFileSync(configFile, '\nno-git-ops: true\nimport.auto: false\n');
  const created = JSON.parse(await bd(['create', 'Synthetic recovery task', '--description', 'Disposable task history proof', '--json']));
  const id = created.id;
  assert.match(id, /^no-/u);
  await bd(['update', id, '--status', 'in_progress', '--actor', 'synthetic-agent']);
  await bd(['comments', 'add', id, 'Synthetic history retained', '--author', 'synthetic-agent']);
  const before = await sql('USE noticeos_tasks; SELECT id,title,status FROM issues ORDER BY id');
  const history = await sql('USE noticeos_tasks; SELECT COUNT(*) AS count FROM events');
  assert.ok(Number(history[0].count) >= 2);
  // Current Beads commits its own writes. Make this separate synthetic SQL
  // change to exercise an actual uncommitted working set during recovery.
  await sql("USE noticeos_tasks; UPDATE issues SET notes='Uncommitted working-set value';");
  await sql("USE noticeos_tasks; CALL DOLT_BRANCH('synthetic-history');");
  const evidence = async (executor = execute, profile = profiles[0]) => ({
    issues: await sql('USE noticeos_tasks; SELECT id,title,status,notes FROM issues ORDER BY id', executor, profile),
    events: await sql('USE noticeos_tasks; SELECT * FROM events ORDER BY id', executor, profile),
    commits: await sql('USE noticeos_tasks; SELECT commit_hash,message FROM dolt_log ORDER BY commit_hash', executor, profile),
    branches: await sql('USE noticeos_tasks; SELECT name,hash FROM dolt_branches ORDER BY name', executor, profile),
    grants: await sql('SELECT User,Host FROM mysql.user ORDER BY User,Host', executor, profile),
    taskGrants: await sql("SHOW GRANTS FOR 'noticeos'@'%'", executor, profile),
    ownerGrants: await sql("SHOW GRANTS FOR 'noticeos_owner'@'localhost'", executor, profile),
    branchControl: await sql('USE noticeos_tasks; SELECT * FROM dolt_branch_control ORDER BY `database`,branch,user,host', executor, profile),
  });
  const expected = await evidence();
  assert.equal(expected.issues[0].notes, 'Uncommitted working-set value');
  assert.deepEqual(before.map(row => row.id), [id]);
  okay(await execute([...args, 'up', '--detach', '--force-recreate', '--wait', '--wait-timeout', '90', 'dolt'], 120_000), 'owned container replacement');
  assert.deepEqual(await evidence(), expected);
  await denied(execute, profiles[0]);
  const output = path.join(base, 'backup');
  await backupDolt(profiles[0], ['noticeos_tasks'], output, { env });
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'backup.json'))).complete, true);
  assert.equal(fs.statSync(path.join(output, 'metadata/secrets/root')).mode & 0o777, 0o600);
  assert.deepEqual(await evidence(), expected, 'source stayed available and unchanged during online backup');
  await restoreDolt(profiles[1], output, { env, run: async (binary, command, options) => {
    const result = await runCommand(binary, command, options);
    if (result.code !== 0 && command.includes('compose')) {
      t.diagnostic(`Owned restore ${command[7]} code ${result.code}: ${(result.stderr + result.stdout).replace(/[0-9a-f]{64}/gu, '[redacted]').slice(-3000)}`);
    }
    return result;
  } });
  assert.deepEqual(await evidence(executors[1], profiles[1]), expected);
  await denied(executors[1], profiles[1]);
  const restoredEnv = { ...doltEnvironment(profiles[1], env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  const restoredRepo = path.join(targetHome, 'tasks'); fs.cpSync(repo, restoredRepo, { recursive: true });
  // The source metadata declares its old port; change only this synthetic copy.
  const metadataFile = path.join(restoredRepo, '.beads/metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile));
  metadata.dolt_server_port = profiles[1].port;
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  const shown = JSON.parse(okay(await runCommand(beadsBinary, ['show', id, '--json'], { env: restoredEnv, cwd: restoredRepo }), 'restored Beads read'));
  assert.equal(shown[0].id, id);
  okay(await runCommand(beadsBinary, ['update', id, '--status', 'closed', '--actor', 'synthetic-agent'], { env: restoredEnv, cwd: restoredRepo }), 'restored Beads write');
  assert.equal((await sql('USE noticeos_tasks; SELECT status FROM issues', executors[1], profiles[1]))[0].status, 'closed');
  assert.deepEqual(await evidence(), expected, 'independent restored writes cannot alter source');
});
