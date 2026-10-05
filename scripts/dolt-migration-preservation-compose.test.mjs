// Synthetic preservation proof only. This is not a native-source adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { startDoltPlan, prepareFreshDolt, preflightDolt, doltExecutor, doltComposeArgs, readDoltCredentials, DOLT_VERSION } from './dolt-host.mjs';
import { backupDolt, restoreDolt } from './dolt-backup.mjs';

const sourceImage = 'dolthub/dolt-sql-server:2.2.3@sha256:0243d2f3d1655a816d363885a7eb9e373f2aee9f96f8e289a0a0010f067314f3';

async function preservationProof(t, upgrade) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-dolt-preservation-'));
  const root = path.resolve(import.meta.dirname, '..');
  const homes = ['source', 'restored'].map(name => path.join(base, name));
  homes.forEach(home => fs.mkdirSync(home, { mode: 0o700 }));
  const plans = homes.map((home, index) => ({ root, home, port: 5340 + index * 4 }));
  if (upgrade) {
    // Only public host definitions are copied. Source data is generated below
    // in a new owned volume; no original installation is ever inspected.
    const definitionRoot = path.join(base, 'source-definition');
    const host = path.join(definitionRoot, 'db/dolt/host');
    fs.mkdirSync(host, { recursive: true });
    for (const name of ['compose.yaml', 'server.yaml', 'start.sh', 'sql.sh', 'capture.sh', 'backup-metadata.sh', 'restore.sh', 'restore-native.sh']) {
      fs.copyFileSync(path.join(root, 'db/dolt/host', name), path.join(host, name));
    }
    const compose = path.join(host, 'compose.yaml');
    fs.writeFileSync(compose, fs.readFileSync(compose, 'utf8').replace(/image: dolthub\/dolt-sql-server:[^\n]+/u, `image: ${sourceImage}`));
    plans[0].root = definitionRoot;
  }
  const profiles = plans.map(startDoltPlan);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const executors = await Promise.all(profiles.map(profile => doltExecutor(profile, { env })));
  const sql = async (index, query) => {
    const result = await executors[index]([...doltComposeArgs(profiles[index]), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', query]);
    assert.equal(result.code, 0, 'Owned SQL failed; raw diagnostics withheld');
    const last = result.stdout.trim().split('\n').at(-1);
    return last?.startsWith('{') ? JSON.parse(last).rows ?? [] : [];
  };
  t.after(async () => {
    for (const [index, profile] of profiles.entries()) {
      const removed = await executors[index]([...doltComposeArgs(profile), 'down', '--volumes'], 90_000);
      assert.equal(removed.code, 0, 'Only the owned project and volumes are removed');
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const prepared = await prepareFreshDolt(plans[0], { fresh: true, env });
  assert.equal(prepared.ok, true, prepared.line);
  assert.deepEqual(await sql(0, 'SELECT DOLT_VERSION() AS version'), [{ version: upgrade ? '2.2.3' : DOLT_VERSION }]);
  // The second physical database intentionally has no NoticeOS/spoke mapping.
  // Preservation uses the approved physical inventory, not active membership.
  const databases = ['synthetic_tasks', 'retired_tasks'];
  for (const database of databases) {
    await sql(0, `CREATE DATABASE ${database}; USE ${database}; CREATE TABLE issues (id varchar(50) PRIMARY KEY, body text);
      INSERT INTO issues VALUES ('base','Committed synthetic task'); CALL DOLT_ADD('.');
      CALL DOLT_COMMIT('-m','Synthetic history','--author','Synthetic <synthetic@example.com>');
      CALL DOLT_BRANCH('side'); CALL DOLT_TAG('synthetic-tag');
      INSERT INTO issues VALUES ('main-staged','Staged synthetic task'); CALL DOLT_ADD('issues');
      INSERT INTO issues VALUES ('main-working','Working synthetic task');
      USE \`${database}/side\`; INSERT INTO issues VALUES ('side-staged','Side staged synthetic task'); CALL DOLT_ADD('issues');
      INSERT INTO issues VALUES ('side-working','Side working synthetic task');`);
  }
  await sql(0, "GRANT SELECT ON synthetic_tasks.* TO 'noticeos'@'%'; USE synthetic_tasks; INSERT INTO dolt_branch_control (`database`,branch,user,host,permissions) VALUES ('synthetic_tasks','side','noticeos','%','read'); INSERT INTO dolt_branch_namespace_control (`database`,branch,user,host) VALUES ('synthetic_tasks','synthetic-%','noticeos','%');");
  const evidence = async index => {
    const projects = [];
    for (const database of databases) {
      const branches = [];
      for (const branch of ['main', 'side']) branches.push({ branch,
        roots: await sql(index, `USE \`${database}/${branch}\`; SELECT DOLT_HASHOF_DB('HEAD') AS head_root, DOLT_HASHOF_DB('STAGED') AS staged_root, DOLT_HASHOF_DB('WORKING') AS working_root`),
        rows: await sql(index, `USE \`${database}/${branch}\`; SELECT id,body FROM issues ORDER BY id`),
        status: await sql(index, `USE \`${database}/${branch}\`; SELECT table_name,staged,status FROM dolt_status ORDER BY table_name,staged`),
        history: await sql(index, `USE \`${database}/${branch}\`; SELECT commit_hash FROM dolt_log ORDER BY commit_hash`),
      });
      projects.push({ database, branches,
        heads: await sql(index, `USE ${database}; SELECT name,hash FROM dolt_branches ORDER BY name`),
        tags: await sql(index, `USE ${database}; SELECT tag_name,tag_hash FROM dolt_tags ORDER BY tag_name`),
      });
    }
    return { projects,
      accounts: await sql(index, 'SELECT User,Host FROM mysql.user ORDER BY User,Host'),
      globalGrants: await sql(index, 'SELECT GRANTEE,PRIVILEGE_TYPE,IS_GRANTABLE FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE,PRIVILEGE_TYPE'),
      databaseGrants: await sql(index, 'SELECT Host,Db,User,Select_priv FROM mysql.db ORDER BY Host,Db,User'),
      branchControls: await sql(index, 'USE synthetic_tasks; SELECT `database`,branch,user,host,permissions FROM dolt_branch_control ORDER BY `database`,branch,user,host'),
      namespaces: await sql(index, 'USE synthetic_tasks; SELECT `database`,branch,user,host FROM dolt_branch_namespace_control ORDER BY `database`,branch,user,host'),
    };
  };
  const before = await evidence(0);
  for (const project of before.projects) for (const branch of project.branches) {
    assert.equal(branch.rows.length, 3);
    assert.notEqual(branch.roots[0].head_root, branch.roots[0].staged_root);
    assert.notEqual(branch.roots[0].staged_root, branch.roots[0].working_root);
  }
  const snapshot = path.join(base, 'snapshot');
  if (upgrade) {
    // A source-version snapshot is NOT a current managed backup marker. Use
    // the fixed capture/restore transport directly for this disposable proof;
    // never rewrite a completed backup or bypass restoreDolt's version guard.
    const sourceStage = `/tmp/noticeos-backup-${randomBytes(16).toString('hex')}`;
    const sourceArgs = doltComposeArgs(profiles[0]);
    assert.equal((await executors[0]([...sourceArgs, 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/capture.sh', sourceStage, ...databases], 120_000)).code, 0);
    fs.mkdirSync(snapshot, { mode: 0o700 });
    assert.equal((await executors[0]([...sourceArgs, 'cp', `dolt:${sourceStage}/.`, snapshot], 120_000)).code, 0);
    assert.equal((await executors[0]([...sourceArgs, 'exec', '--no-TTY', 'dolt', 'rm', '-rf', '--', sourceStage])).code, 0);
    for (const database of databases) {
      const status = JSON.parse(fs.readFileSync(path.join(snapshot, 'status', `${database}.json`), 'utf8'));
      assert.equal(status.rows.length, 1);
      assert.ok([0, '0'].includes(status.rows[0].status));
    }
  } else {
    await backupDolt(profiles[0], databases, snapshot, { env });
    const marker = JSON.parse(fs.readFileSync(path.join(snapshot, 'backup.json')));
    assert.deepEqual(marker.databases, databases);
    assert.equal(marker.version, DOLT_VERSION);
  }
  assert.deepEqual(await evidence(0), before, 'Online capture leaves source data, history and permissions unchanged');
  if (upgrade) {
    const empty = await preflightDolt(plans[1], { env });
    assert.equal(empty.ok, true, empty.line);
    const credentials = readDoltCredentials(profiles[0]);
    fs.mkdirSync(path.dirname(profiles[1].credentialsFile), { mode: 0o700 });
    fs.mkdirSync(profiles[1].secretsDir, { mode: 0o700 });
    fs.mkdirSync(path.join(path.dirname(profiles[1].credentialsFile), 'client-home'), { mode: 0o700 });
    for (const name of ['root', 'noticeos']) fs.writeFileSync(path.join(profiles[1].secretsDir, name), credentials[name], { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(profiles[1].credentialsFile, `[127.0.0.1:${profiles[1].port}]\npassword=${credentials.noticeos.trim()}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(homes[1], 'dolt/profile.json'), JSON.stringify(profiles[1]), { mode: 0o600, flag: 'wx' });
    const args = doltComposeArgs(profiles[1]);
    const stage = `/var/lib/dolt/.noticeos-restore-${randomBytes(16).toString('hex')}`;
    assert.equal((await executors[1]([...args, 'create', 'dolt'], 120_000)).code, 0);
    assert.equal((await executors[1]([...args, 'cp', `${snapshot}/.`, `dolt:${stage}`], 120_000)).code, 0);
    assert.equal((await executors[1]([...args, 'run', '--rm', '--no-deps', '--no-TTY', '--entrypoint', '/bin/bash', 'dolt', '/etc/noticeos/restore.sh', stage, ...databases], 120_000)).code, 0);
    assert.equal((await executors[1]([...args, 'up', '--detach', '--wait', '--wait-timeout', '90', 'dolt'], 120_000)).code, 0);
  } else await restoreDolt(profiles[1], snapshot, { env });
  assert.deepEqual(await sql(1, 'SELECT DOLT_VERSION() AS version'), [{ version: DOLT_VERSION }]);
  assert.deepEqual(await evidence(1), before, 'Restore retains every declared database and every branch working set');
  await sql(1, "USE synthetic_tasks; INSERT INTO issues VALUES ('first-target-write','Target-only synthetic task');");
  assert.equal((await sql(1, 'USE synthetic_tasks; SELECT COUNT(*) AS count FROM issues'))[0].count, '4');
  assert.deepEqual(await evidence(0), before, 'Source remains a preserved rollback copy after target accepts a new write');
}

for (const upgrade of [false, true]) test(upgrade
  ? 'synthetic Dolt 2.2.3 to current stable upgrade preserves every database, branch working set, grant and source rollback'
  : 'synthetic current stable recovery preserves tags, history, every branch working set and rollback source', {
  skip: process.env.NOTICEOS_TEST_DOLT_PRESERVATION !== '1', timeout: 180_000,
}, t => preservationProof(t, upgrade));
