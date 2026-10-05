// Generated native-style source only. No Homebrew/source installation calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startDoltPlan, prepareFreshDolt, doltExecutor, doltComposeArgs, DOLT_VERSION } from './dolt-host.mjs';
import { captureStoppedDoltSource, verifyStoppedDoltCapture } from './dolt-migration-capture.mjs';
import { restoreNativeDoltCapture } from './dolt-migration-restore.mjs';

test('cold native-style 2.2.3 capture restores into 2.4.0 with target-only auth adaptation and untouched rollback custody', {
  skip: process.env.NOTICEOS_TEST_DOLT_COLD !== '1', timeout: 180_000,
}, async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-dolt-cold-'));
  const root = path.resolve(import.meta.dirname, '..');
  const definition = path.join(base, 'source-definition/db/dolt/host'); fs.mkdirSync(definition, { recursive: true });
  for (const name of ['compose.yaml', 'server.yaml', 'start.sh', 'sql.sh', 'capture.sh', 'backup-metadata.sh', 'restore.sh', 'restore-native.sh']) fs.copyFileSync(path.join(root, 'db/dolt/host', name), path.join(definition, name));
  const sourceCompose = path.join(definition, 'compose.yaml');
  fs.writeFileSync(sourceCompose, fs.readFileSync(sourceCompose, 'utf8').replace(/image: dolthub\/dolt-sql-server:[^\n]+/u,
    'image: dolthub/dolt-sql-server:2.2.3@sha256:0243d2f3d1655a816d363885a7eb9e373f2aee9f96f8e289a0a0010f067314f3'));
  const homes = ['source', 'target'].map(name => path.join(base, name)); homes.forEach(home => fs.mkdirSync(home, { mode: 0o700 }));
  const plans = homes.map((home, index) => ({ root: index ? root : path.resolve(definition, '../../..'), home, port: 5340 + index * 4 }));
  const profiles = plans.map(startDoltPlan); const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const executors = await Promise.all(profiles.map(profile => doltExecutor(profile, { env })));
  t.after(async () => {
    for (const [index, profile] of profiles.entries()) assert.equal((await executors[index]([...doltComposeArgs(profile), 'down', '--volumes'], 90_000)).code, 0);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const sql = async (index, query, native = false) => {
    const command = native
      ? ['env', 'DOLT_CLI_PASSWORD=', 'dolt', '--host=127.0.0.1', '--port=3306', '--user=root', '--no-tls', 'sql', '--result-format=json', '--query', query]
      : ['/bin/bash', '/etc/noticeos/sql.sh', 'root', query];
    const result = await executors[index]([...doltComposeArgs(profiles[index]), 'exec', '--no-TTY', 'dolt', ...command]);
    assert.equal(result.code, 0, 'Owned SQL failed; raw diagnostics withheld');
    return JSON.parse(result.stdout.trim().split('\n').at(-1)).rows ?? [];
  };
  assert.equal((await prepareFreshDolt(plans[0], { fresh: true, env })).ok, true);
  await sql(0, "CREATE DATABASE synthetic_tasks; USE synthetic_tasks; CREATE TABLE task_content(id varchar(50) PRIMARY KEY,body text); INSERT INTO task_content VALUES ('base','Committed Ω'); CALL DOLT_ADD('.'); CALL DOLT_COMMIT('-m','Synthetic history','--author','Synthetic <synthetic@example.com>'); CALL DOLT_BRANCH('side'); CALL DOLT_TAG('synthetic-tag'); INSERT INTO task_content VALUES ('staged','Staged Ω'); CALL DOLT_ADD('task_content'); INSERT INTO task_content VALUES ('working','Working Ω'); USE `synthetic_tasks/side`; INSERT INTO task_content VALUES ('side-working','Side Ω');");
  await sql(0, "CREATE USER 'root'@'localhost'; GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION; CREATE USER 'retained'@'localhost'; GRANT SELECT ON synthetic_tasks.* TO 'retained'@'localhost'; DROP USER 'noticeos'@'%'; DROP USER 'noticeos_owner'@'localhost';");
  const sourceArgs = doltComposeArgs(profiles[0]);
  // Native installations have no fresh-service completion marker.
  assert.equal((await executors[0]([...sourceArgs, 'exec', '--no-TTY', 'dolt', 'rm', '/var/lib/dolt/.noticeos-initialized'])).code, 0);
  const evidence = async (index, native = false) => ({
    roots: await sql(index, "USE synthetic_tasks; SELECT DOLT_HASHOF_DB('HEAD') AS head,DOLT_HASHOF_DB('STAGED') AS staged,DOLT_HASHOF_DB('WORKING') AS working", native),
    rows: await sql(index, 'USE synthetic_tasks; SELECT id,body FROM task_content ORDER BY id', native),
    side: await sql(index, 'USE `synthetic_tasks/side`; SELECT id,body FROM task_content ORDER BY id', native),
    history: await sql(index, 'USE synthetic_tasks; SELECT commit_hash FROM dolt_log ORDER BY commit_hash', native),
    branches: await sql(index, 'USE synthetic_tasks; SELECT name,hash FROM dolt_branches ORDER BY name', native),
    tags: await sql(index, 'USE synthetic_tasks; SELECT tag_name,tag_hash FROM dolt_tags ORDER BY tag_name', native),
    retainedGrant: await sql(index, "SELECT Host,Db,User,Select_priv FROM mysql.db WHERE User='retained'", native),
    branchRules: await sql(index, 'USE synthetic_tasks; SELECT `database`,branch,user,host,permissions FROM dolt_branch_control ORDER BY `database`,branch,user,host', native),
  });
  const before = await evidence(0, true);
  assert.deepEqual(await sql(0, 'SELECT DOLT_VERSION() AS version', true), [{ version: '2.2.3' }]);
  assert.equal((await executors[0]([...sourceArgs, 'stop', 'dolt'], 90_000)).code, 0);
  const exported = path.join(base, 'stopped-source'); fs.mkdirSync(exported, { mode: 0o700 });
  assert.equal((await executors[0]([...sourceArgs, 'cp', 'dolt:/var/lib/dolt/.', exported], 120_000)).code, 0);
  const coldPlan = { sourceDirectory: exported, outputDirectory: path.join(base, 'capture'), sourceVersion: '2.2.3', databases: ['synthetic_tasks'],
    service: { brew: '/synthetic/bin/brew', home: base, name: 'dolt', label: 'synthetic.dolt' },
    files: [{ name: 'global-config', path: path.join(exported, '.noticeos-home/.dolt/config_global.json'), required: true }],
    approval: 'Synthetic owned service only', writerFence: 'Owned source container is stopped; exported source has no writers' };
  const stopped = async (binary, args) => {
    assert.equal(binary, '/synthetic/bin/brew'); assert.deepEqual(args, ['services', 'info', 'dolt', '--json']);
    const state = await executors[0]([...sourceArgs, 'ps', '--all', '--format', 'json', 'dolt']);
    assert.equal(state.code, 0); assert.equal(JSON.parse(state.stdout.trim()).State, 'exited');
    return { code: 0, stdout: JSON.stringify([{ name: 'dolt', service_name: 'synthetic.dolt', running: false, loaded: false, schedulable: false, pid: null, status: 'none' }]) };
  };
  await captureStoppedDoltSource(coldPlan, { run: stopped });
  const captureBefore = verifyStoppedDoltCapture(coldPlan.outputDirectory);
  const restored = await restoreNativeDoltCapture(profiles[1], coldPlan.outputDirectory, { env });
  assert.equal(restored.targetVersion, DOLT_VERSION);
  assert.deepEqual(await evidence(1), before, 'Cold restoration retains all roots/history/data and unrelated grants');
  const accounts = await sql(1, 'SELECT User,Host FROM mysql.user ORDER BY User,Host');
  assert.ok(accounts.some(row => row.User === 'noticeos' && row.Host === '%'));
  assert.ok(accounts.some(row => row.User === 'noticeos_owner' && row.Host === 'localhost'));
  assert.ok(accounts.some(row => row.User === 'retained' && row.Host === 'localhost'));
  assert.equal(accounts.some(row => row.User === 'root'), false);
  const denied = await executors[1]([...doltComposeArgs(profiles[1]), 'exec', '--no-TTY', 'dolt', 'env', 'DOLT_CLI_PASSWORD=',
    'dolt', '--host=127.0.0.1', '--port=3306', '--user=root', '--no-tls', 'sql', '--query', 'SELECT 1']);
  assert.notEqual(denied.code, 0);
  await sql(1, "USE synthetic_tasks; INSERT INTO task_content VALUES ('target-only','Target write');");
  assert.deepEqual(verifyStoppedDoltCapture(coldPlan.outputDirectory), captureBefore, 'Target auth adaptation and writes leave protected original capture untouched');
  assert.deepEqual(await sql(1, 'SELECT DOLT_VERSION() AS version'), [{ version: DOLT_VERSION }]);
});
