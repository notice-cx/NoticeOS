// Generated data and an owned Compose project only; never a real task hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { startDoltPlan, prepareFreshDolt, doltExecutor, doltComposeArgs, DOLT_VERSION } from './dolt-host.mjs';
import { captureTargetState, compareTargetState } from './dolt-migration-state.mjs';

test('owned Dolt reconciliation reads full TEXT families without changing scalar encodings or losing duplicate rows', {
  skip: process.env.NOTICEOS_TEST_DOLT_STATE !== '1', timeout: 180_000,
}, async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-dolt-state-'));
  const home = path.join(base, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const plan = { root: path.resolve(import.meta.dirname, '..'), home, port: 5360 };
  const profile = startDoltPlan(plan);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const run = await doltExecutor(profile, { env });
  const args = doltComposeArgs(profile);
  t.after(async () => {
    assert.equal((await run([...args, 'down', '--volumes'], 90_000)).code, 0, 'Remove only the owned project and volumes');
    fs.rmSync(base, { recursive: true, force: true });
  });
  assert.equal((await prepareFreshDolt(plan, { fresh: true, env })).ok, true);
  const queries = [];
  const execute = async sql => run([...args, 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', sql], 60_000);
  const query = async sql => {
    queries.push(sql);
    const reply = await execute(sql);
    assert.equal(reply.code, 0, 'Owned SQL failed; no raw record content emitted');
    return JSON.parse(reply.stdout.trim().split('\n').at(-1)).rows ?? [];
  };
  assert.deepEqual(await query('SELECT DOLT_VERSION() AS version'), [{ version: DOLT_VERSION }]);
  await query(`CREATE DATABASE synthetic_tasks; USE synthetic_tasks;
    CREATE TABLE schema_migrations (version INT); INSERT INTO schema_migrations VALUES (53);
    CREATE TABLE metadata (\`key\` VARCHAR(80) PRIMARY KEY,value VARCHAR(255));
    INSERT INTO metadata VALUES ('_project_id','11111111-1111-4111-8111-111111111111');
    CREATE TABLE config (\`key\` VARCHAR(80) PRIMARY KEY,value VARCHAR(255)); INSERT INTO config VALUES ('issue_prefix','sy');
    CREATE TABLE comments (id INT PRIMARY KEY,issue_id VARCHAR(50),author VARCHAR(50),text TEXT,created_at DATETIME);
    INSERT INTO comments VALUES
      (1,'same','fixture',REPEAT('abcde',8000),'2026-09-30 12:34:56'),
      (2,'same','fixture',REPEAT('abcde',8000),'2026-09-30 12:34:56'),
      (3,'same','fixture',NULL,'2026-09-30 12:34:56'),
      (4,'same','fixture','','2026-09-30 12:34:56'),
      (5,'same','fixture',CONCAT(REPEAT('日本🙂',3000),CHAR(10),'quote',CHAR(34),'slash',CHAR(92)),'2026-09-30 12:34:56');
    CREATE TABLE long_values (small TINYTEXT,medium MEDIUMTEXT,large LONGTEXT);
    INSERT INTO long_values VALUES ('tiny Ω',REPEAT('medium ',30000),REPEAT('long unicode 🙂',20000));
    CREATE TABLE scalars (id INT,amount DECIMAL(20,6),value DOUBLE,flag BOOLEAN,day DATE,stamp TIMESTAMP(6),plain VARCHAR(16000),doc JSON);
    INSERT INTO scalars VALUES (12,1.234500,-2.5,true,'2026-09-30','2026-09-30 12:34:56.123456',REPEAT('🙂',15000),JSON_OBJECT('a','quote')),
      (NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    CALL DOLT_ADD('.'); CALL DOLT_COMMIT('-m','Synthetic reconciliation baseline','--author','Synthetic <synthetic@example.com>');`);

  const failed = await execute('SELECT SHA2(JSON_ARRAY(CAST(text AS CHAR)),256) AS digest FROM synthetic_tasks.comments ORDER BY digest');
  assert.notEqual(failed.code, 0, 'The original query must reproduce out-of-line TEXT failure');
  assert.match(failed.stderr, /unsupported type: \*val\.TextStorage/u);
  const before = await captureTargetState(['synthetic_tasks'], query);
  assert.equal(before.databases[0].tables.find(row => row.table === 'comments').count, 5);
  assert.equal(compareTargetState(before, await captureTargetState(['synthetic_tasks'], query), { upgraded: false }).semanticContentPreserved, true);
  const commentDigest = queries.find(sql => sql.startsWith('SELECT SHA2(JSON_ARRAY') && sql.includes('`synthetic_tasks`.`comments`'));
  assert.equal(commentDigest, "SELECT SHA2(JSON_ARRAY(CAST(`issue_id` AS CHAR),CAST(`author` AS CHAR),CAST(CONCAT('',`text`) AS CHAR),CAST(`created_at` AS CHAR)),256) AS digest FROM `synthetic_tasks`.`comments` ORDER BY digest LIMIT 100001");
  const scalarDigest = queries.find(sql => sql.startsWith('SELECT SHA2(JSON_ARRAY') && sql.includes('`synthetic_tasks`.`scalars`'));
  const columns = ['id', 'amount', 'value', 'flag', 'day', 'stamp', 'plain', 'doc'];
  const originalScalarQuery = `SELECT SHA2(JSON_ARRAY(${columns.map(column => 'CAST(`' + column + '` AS CHAR)').join(',')}),256) AS digest FROM \`synthetic_tasks\`.\`scalars\` ORDER BY digest LIMIT 100001`;
  assert.equal(scalarDigest, originalScalarQuery, 'DATE and every other scalar use the exact previous CAST encoding');
  const scalarRows = await query(originalScalarQuery);
  assert.equal(createHash('sha256').update(scalarRows.map(row => row.digest).sort().join('\n')).digest('hex'), before.databases[0].tables.find(row => row.table === 'scalars').sha256);

  const bytes = await query("SELECT id,OCTET_LENGTH(CAST(CONCAT('',text) AS CHAR)) AS bytes,SHA2(CAST(CONCAT('',text) AS CHAR),256) AS digest,CAST(CONCAT('',text) AS CHAR) IS NULL AS is_null FROM synthetic_tasks.comments ORDER BY id");
  const values = ['abcde'.repeat(8000), 'abcde'.repeat(8000), null, '', '日本🙂'.repeat(3000) + '\nquote"slash\\'];
  for (const [index, row] of bytes.entries()) {
    const value = values[index];
    if (value === null) {
      assert.equal(Number(row.is_null), 1); assert.equal(row.bytes ?? null, null); assert.equal(row.digest ?? null, null);
    } else {
      assert.equal(Number(row.bytes), Buffer.byteLength(value)); assert.equal(Number(row.is_null), 0);
      assert.equal(row.digest, createHash('sha256').update(value).digest('hex'));
    }
  }
  const largeBytes = await query("SELECT OCTET_LENGTH(CAST(CONCAT('',large) AS CHAR)) AS bytes,SHA2(CAST(CONCAT('',large) AS CHAR),256) AS digest FROM synthetic_tasks.long_values");
  const largeValue = 'long unicode 🙂'.repeat(20000);
  assert.equal(Number(largeBytes[0].bytes), Buffer.byteLength(largeValue));
  assert.equal(largeBytes[0].digest, createHash('sha256').update(largeValue).digest('hex'));
  const framed = await query("SELECT SHA2(JSON_ARRAY(CAST(CONCAT('',NULL) AS CHAR)),256) AS null_digest,SHA2(JSON_ARRAY(CAST(CONCAT('','') AS CHAR)),256) AS empty_digest,SHA2(JSON_ARRAY('a','bc'),256) AS left_digest,SHA2(JSON_ARRAY('ab','c'),256) AS right_digest");
  assert.notEqual(framed[0].null_digest, framed[0].empty_digest);
  assert.notEqual(framed[0].left_digest, framed[0].right_digest);

  await query("UPDATE synthetic_tasks.long_values SET large=CONCAT(large,'changed tail')");
  const changed = await captureTargetState(['synthetic_tasks'], query, { baseline: before });
  assert.notEqual(changed.databases[0].tables.find(row => row.table === 'long_values').sha256, before.databases[0].tables.find(row => row.table === 'long_values').sha256, 'Full-value tail corruption changes the digest');
  assert.throws(() => compareTargetState(before, changed, { upgraded: false }));
  await query("DELETE FROM synthetic_tasks.comments WHERE id=2");
  const removed = await captureTargetState(['synthetic_tasks'], query, { baseline: before });
  assert.equal(removed.databases[0].tables.find(row => row.table === 'comments').count, 4, 'Duplicate multiplicity remains visible');
  assert.throws(() => compareTargetState(before, removed, { upgraded: false }));
});
