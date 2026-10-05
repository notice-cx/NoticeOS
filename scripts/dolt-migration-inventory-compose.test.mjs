import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startDoltPlan, prepareFreshDolt, doltExecutor, doltComposeArgs, readDoltCredentials } from './dolt-host.mjs';
import { inventoryDoltMigration, runDoltInventoryQuery } from './dolt-migration-inventory.mjs';

test('metadata inventory queries run against an owned disposable pinned server without task or authentication values', {
  skip: process.env.NOTICEOS_TEST_DOLT_INVENTORY !== '1', timeout: 180_000,
}, async t => {
  const dolt = process.env.NOTICEOS_TEST_DOLT_CLIENT;
  assert.ok(path.isAbsolute(dolt ?? ''), 'Declare the exact local Dolt client');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-dolt-inventory-compose-'));
  const home = path.join(base, 'source'); const clientHome = path.join(base, 'client'); const repo = path.join(base, 'spoke');
  fs.mkdirSync(home); fs.mkdirSync(clientHome, { mode: 0o700 }); fs.mkdirSync(path.join(repo, '.beads'), { recursive: true });
  const root = path.resolve(import.meta.dirname, '..'); const options = { root, home, port: 5340 };
  const profile = startDoltPlan(options);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const execute = await doltExecutor(profile, { env }); const args = doltComposeArgs(profile);
  t.after(async () => {
    const removed = await execute([...args, 'down', '--volumes'], 90_000);
    assert.equal(removed.code, 0, 'Only the owned Compose project is removed');
    fs.rmSync(base, { recursive: true, force: true });
  });
  const prepared = await prepareFreshDolt(options, { fresh: true, env });
  assert.equal(prepared.ok, true, prepared.line);
  const sql = async query => {
    const result = await execute([...args, 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', query]);
    assert.equal(result.code, 0, 'Synthetic SQL setup failed; raw diagnostics withheld');
    const last = result.stdout.trim().split('\n').at(-1);
    return last?.startsWith('{') ? JSON.parse(last).rows : null;
  };
  await sql("CREATE DATABASE synthetic_tasks; USE synthetic_tasks; CREATE TABLE issues (id varchar(50) primary key, body text); INSERT INTO issues VALUES ('ex-synthetic', 'Synthetic task body never appears in inventory'); CALL DOLT_ADD('.'); CALL DOLT_COMMIT('-m','Synthetic private commit message','--author','Synthetic <synthetic@example.com>'); INSERT INTO issues VALUES ('ex-working', 'Synthetic uncommitted task body'); CALL DOLT_BRANCH('synthetic-history');");
  await sql("GRANT ALL ON *.* TO 'noticeos'@'%' WITH GRANT OPTION");
  await sql("CREATE ROLE synthetic_role; GRANT SELECT ON synthetic_tasks.* TO synthetic_role; GRANT SELECT ON synthetic_tasks.issues TO synthetic_role; GRANT synthetic_role TO 'noticeos'@'%'; USE synthetic_tasks; CALL DOLT_TAG('synthetic-tag'); INSERT INTO dolt_branch_namespace_control (`database`,branch,user,host) VALUES ('synthetic_tasks','synthetic-%','noticeos','%');");
  const files = { metadata: path.join(repo, '.beads', 'metadata.json'), config: path.join(repo, '.beads', 'config.yaml') };
  fs.writeFileSync(files.metadata, JSON.stringify({ dolt_database: 'synthetic_tasks', dolt_mode: 'server', dolt_server_host: '127.0.0.1', dolt_server_port: 5343, dolt_server_user: 'noticeos' }));
  fs.writeFileSync(files.config, 'issue-prefix: ex\nno-git-ops: true\nimport.auto: false\n');
  const receipt = { format: 'noticeos-dolt-migration-metadata-v1', scope: 'maps-only',
    hub: { host: '127.0.0.1', port: 5343, user: 'noticeos' },
    projects: [{ asset: 'tasks.example', prefix: 'ex', database: 'synthetic_tasks', repo, files }] };
  const before = await sql('USE synthetic_tasks; SELECT id,body FROM issues ORDER BY id');
  const password = readDoltCredentials(profile).noticeos.trim();
  const result = await inventoryDoltMigration(receipt, { dolt, clientHome,
    run: async (binary, command, invocation) => {
      const answer = await runDoltInventoryQuery(binary, command, { ...invocation,
        env: { ...invocation.env, DOLT_CLI_PASSWORD: password } });
      return answer;
    } });
  assert.equal(result.global[0].rows[0].version, '2.4.0');
  assert.equal(result.global[0].rows[0].account, 'noticeos@%');
  assert.deepEqual(result.databases[0].counts.map(item => [item.table, Number(item.rows?.[0]?.count)]), [['issues', 2]]);
  const missing = [...result.global, ...result.databases[0].summaries].filter(item => !item.available).map(item => item.name);
  assert.deepEqual(missing, [], `Unsupported metadata sections: ${missing.join(', ')}`);
  assert.equal(result.sqlMetadataComplete, true);
  assert.equal(result.global.find(item => item.name === 'schemaPrivileges').rows.length, 1);
  assert.equal(result.global.find(item => item.name === 'tablePrivileges').rows.length, 1);
  assert.equal(result.global.find(item => item.name === 'roleGrants').rows.length, 1);
  assert.deepEqual(result.databases[0].summaries.find(item => item.name === 'tags').rows.map(row => row.tag_name), ['synthetic-tag']);
  assert.equal(result.databases[0].summaries.find(item => item.name === 'branchNamespaces').rows.length, 1);
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes('Synthetic task body'));
  assert.ok(!JSON.stringify(result).includes('Synthetic private commit message'));
  assert.deepEqual(await sql('USE synthetic_tasks; SELECT id,body FROM issues ORDER BY id'), before);
});
