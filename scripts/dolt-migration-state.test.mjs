import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticColumns, compareTargetState, captureTargetState } from './dolt-migration-state.mjs';
import { DOLT_VERSION } from './dolt-host.mjs';

const state = () => ({ format: 'noticeos-dolt-target-state-v1', version: DOLT_VERSION, databases: [{ database: 'synthetic', schema: 53,
  projectId: '11111111-1111-1111-1111-111111111111', prefix: 'sy', roots: [{ head: 'original', staged: 'staged', working: 'working' }],
  branches: [{ name: 'main', hash: 'old' }, { name: 'side', hash: 'side' }], tags: [{ tag_name: 'release', tag_hash: 'old' }],
  history: [{ commit_hash: 'old' }], tables: [{ table: 'comments', columns: ['issue_id', 'text'], count: 2, sha256: 'a'.repeat(64) }] }] });

test('schema53 to66 comparison retains task identities, duplicate row counts, semantic content and original histories', () => {
  const before = state(); const after = structuredClone(before); const db = after.databases[0];
  db.schema = 66; db.branches[0].hash = 'upgrade'; db.roots[0].working = 'upgrade'; db.history.push({ commit_hash: 'upgrade' });
  db.tables.push({ table: 'leases', columns: ['id'], count: 0, sha256: 'b'.repeat(64) });
  assert.equal(compareTargetState(before, after).semanticContentPreserved, true);
  for (const change of [value => { value.tables[0].count--; }, value => { value.tables[0].sha256 = 'b'.repeat(64); }, value => { value.projectId = 'changed'; },
    value => { value.prefix = 'changed'; }, value => { value.history = []; }, value => { value.branches[1].hash = 'changed'; }, value => { value.tags = []; },
    value => { value.tables[0].columns = ['text']; }]) {
    const changed = structuredClone(after); change(changed.databases[0]); assert.throws(() => compareTargetState(before, changed));
  }
  assert.throws(() => compareTargetState(before, after, { upgraded: false }));
  assert.equal(compareTargetState(before, before, { upgraded: false }).originalHistoryReachable, true);
});

test('only declared auxiliary IDs and blocked derivations are excluded; all task and dependency content remains compared', () => {
  assert.deepEqual(semanticColumns('issues', ['id', 'title', 'is_blocked']), ['id', 'title']);
  assert.deepEqual(semanticColumns('dependencies', ['id', 'issue_id', 'depends_on_issue_id', 'metadata']), ['issue_id', 'depends_on_issue_id', 'metadata']);
  assert.deepEqual(semanticColumns('events', ['id', 'issue_id', 'actor', 'comment']), ['issue_id', 'actor', 'comment']);
  assert.deepEqual(semanticColumns('unknown_table', ['id', 'is_blocked']), ['id', 'is_blocked']);
  assert.throws(() => semanticColumns('unsafe; table', ['id']));
});

test('bounded SQL state queries expose digests rather than record bodies, preserve duplicates and reuse original columns after upgrade', async () => {
  const queries = []; const query = async sql => {
    queries.push(sql);
    if (sql.includes('DOLT_VERSION')) return [{ version: DOLT_VERSION }];
    if (sql.includes('MAX(version)')) return [{ version: '53' }];
    if (sql.includes('_project_id')) return [{ project_id: '11111111-1111-1111-1111-111111111111' }];
    if (sql.includes('issue_prefix')) return [{ prefix: 'sy' }];
    if (sql.includes('HASHOF_DB')) return [{ head: 'original', staged: 'staged', working: 'working' }];
    if (sql.includes('dolt_branches')) return [{ name: 'main', hash: 'old' }];
    if (sql.includes('dolt_tags')) return [];
    if (sql.includes('dolt_log')) return [{ commit_hash: 'old' }];
    if (sql.includes('information_schema.COLUMNS')) return ['id', 'issue_id', 'text', 'created_at'].map(column_name => ({ table_name: 'comments', column_name,
      data_type: column_name === 'text' ? 'TEXT' : column_name === 'created_at' ? 'date' : 'varchar' }));
    if (sql.includes('information_schema.TABLES')) return [{ table_name: 'comments' }, { table_name: 'schema_migrations' }];
    if (sql.includes('SHA2(JSON_ARRAY')) return [{ digest: 'a'.repeat(64) }, { digest: 'a'.repeat(64) }];
    assert.fail('Unknown query');
  };
  const output = await captureTargetState(['synthetic'], query);
  assert.equal(output.databases[0].tables[0].count, 2);
  assert.deepEqual(output.databases[0].tables[0].columns, ['issue_id', 'text', 'created_at']);
  assert.equal(queries.at(-1), "SELECT SHA2(JSON_ARRAY(CAST(`issue_id` AS CHAR),CAST(CONCAT('',`text`) AS CHAR),CAST(`created_at` AS CHAR)),256) AS digest FROM `synthetic`.`comments` ORDER BY digest LIMIT 100001");
  assert.ok(queries.find(sql => sql.includes('information_schema.COLUMNS')).includes('DATA_TYPE AS data_type'));
  assert.ok(queries.at(-1).includes('LIMIT 100001')); assert.equal(queries.some(sql => /SELECT \*/u.test(sql)), false);
  assert.equal(queries.some(sql => /SHOW GRANTS|mysql\.user|authentication_string|password/iu.test(sql)), false);
  await assert.rejects(captureTargetState(['unsafe;source'], query));
  await assert.rejects(captureTargetState(['synthetic'], async sql => sql.includes('DOLT_VERSION') ? [{ version: '2.2.3' }] : query(sql)));
  for (const change of [rows => rows.map(({ data_type: _type, ...row }) => row), rows => [...rows, rows[1]], rows => rows.map(row => ({ ...row, data_type: '' }))]) {
    await assert.rejects(captureTargetState(['synthetic'], async sql => sql.includes('information_schema.COLUMNS') ? change(await query(sql)) : query(sql)));
  }
});
