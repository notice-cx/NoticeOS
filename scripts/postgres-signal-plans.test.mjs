import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PostgresUnavailable, createWorkspace, withDisposablePostgres } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';

const require = createRequire(path.join(REPO_ROOT, 'apps/tower/package.json'));
const ts = require('typescript');

// Read the shipped statement, not a second SQL implementation maintained by
// the test. A changed function/query boundary must update this selection.
function statement(file, declaration, includes) {
  const source = ts.createSourceFile(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const matches = [];
  const walk = (node, selected = false) => {
    const current = selected || ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === declaration);
    if (current && ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes(includes)) matches.push(node.text);
    ts.forEachChild(node, child => walk(child, current));
  };
  walk(source);
  assert.equal(matches.length, 1, `${file}: exactly one ${declaration} statement`);
  return matches[0];
}

const cases = [
  ['collector prior values', 'workers/ingest/src/signal-store.ts', 'PRIOR_VALUES_SQL', 'SELECT o.observed_date',
    "'asset-1.example', 'ga4', 'property-1', 'UTC', '2026-09-03', '2026-09-30'"],
  ['watch aggregate', 'workers/ingest/src/watch-windows.ts', 'aggregateMetric', 'SELECT o.observed_date',
    "'asset-1.example', 'ga4', 'active_users', '2026-09-03', '2026-09-30'"],
  ['panel trend', 'workers/ingest/src/panel-source.ts', 'readPanelTrend', 'WITH current_property',
    "'asset-1.example', '2026-09-03'"],
  ['watch calibration history', 'apps/tower/worker/asset-detail-payload.ts', 'readWatchSeriesHistory', 'WITH current_property',
    "'asset-1.example', '2026-09-03', '2026-09-30'"],
];

function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test('the four stored-signal readers have indexed series/date paths on analyzed retained history', async t => {
  try {
    await withDisposablePostgres(async dev => {
      applyMigrations(dev);
      const workspace = createWorkspace(dev, { slug: 'signal-plan-proof' });
      // 20 assets × 730 days, with one stable measurement series per asset.
      // The 28 requested rows stay fixed while unrelated retained rows exist.
      // All inserts use normal triggers/constraints; the owner alone ANALYZEs.
      dev.psql(`
        INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
        SELECT '${workspace}', 'asset-'||a||'.example', 'asset-'||a||'.example', 'Synthetic asset '||a, 'live', a
        FROM generate_series(1,20) a;
        INSERT INTO noticeos.measurement_series(workspace_id,asset_id,integration,property_ref,time_zone,metric)
        SELECT '${workspace}', 'asset-'||a||'.example', 'ga4', 'property-'||a, 'UTC', 'active_users'
        FROM generate_series(1,20) a;
        INSERT INTO noticeos.signal_runs(workspace_id,run_id,asset_id,integration,credential_ref,property_ref,time_zone,
          started_at,finished_at,status,window_start,window_end,data_state,provider_rows,observation_count)
        SELECT '${workspace}', 'run-'||a||'-'||d, 'asset-'||a||'.example', 'ga4', 'fixture', 'property-'||a, 'UTC',
          ('2026-09-30'::date-d)::timestamptz, ('2026-09-30'::date-d)::timestamptz,
          'success', '2026-09-30'::date-d, '2026-09-30'::date-d, 'final', 1, 1
        FROM generate_series(1,20) a CROSS JOIN generate_series(0,729) d;
        INSERT INTO noticeos.signal_observations(workspace_id,run_seq,series_id,observed_date,value)
        SELECT r.workspace_id,r.run_seq,s.series_id,r.window_end,42
        FROM noticeos.signal_runs r JOIN noticeos.measurement_series s
          ON s.workspace_id=r.workspace_id AND s.asset_id=r.asset_id;
        ANALYZE noticeos.assets;
        ANALYZE noticeos.measurement_series;
        ANALYZE noticeos.signal_runs;
        ANALYZE noticeos.signal_observations;
      `);
      assert.equal(dev.psql('SELECT count(*) FROM noticeos.signal_observations').trim(), '14600');
      const indexes = JSON.parse(dev.psql(`SELECT json_agg(json_build_object('name',c.relname,'key',i.indkey::text,'unique',i.indisunique))
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='noticeos.signal_observations'::regclass`));
      assert.equal(indexes.length, 3, 'one primary identity, one unique run/series/date key, one series/date index');
      assert.equal(new Set(indexes.map(row => row.key)).size, indexes.length, 'no duplicate ordered-column index');
      assert.equal(indexes.filter(row => row.unique).length, 2, 'primary and observation uniqueness remain enforced');
      for (const [name, file, declaration, includes, parameters] of cases) {
        await t.test(name, () => {
          const sql = statement(file, declaration, includes);
          const read = settings => JSON.parse(dev.psql(`BEGIN;
            SET LOCAL ROLE noticeos_app;
            SET LOCAL noticeos.workspace_id='${workspace}';
            SET LOCAL TimeZone='UTC';
            ${settings}
            PREPARE stored_read AS ${sql};
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE stored_read(${parameters});
            ROLLBACK;`))[0];
          const natural = read('');
          assert.equal(natural.Plan['Actual Rows'], 28, 'the actual read returns only the selected 28 days');
          const observation = nodes(natural.Plan).filter(node => node['Relation Name'] === 'signal_observations');
          assert.ok(observation.length > 0);
          assert.ok(observation.every(node => !['Seq Scan','Parallel Seq Scan'].includes(node['Node Type'])), JSON.stringify(natural));
          // Separately prove that the index condition can carry every bound.
          // This forced-path check is not a production cost/latency claim.
          const indexed = read('SET LOCAL enable_seqscan=off;');
          const access = nodes(indexed.Plan).find(node => node['Index Name'] === 'signal_observations_series_date');
          assert.ok(access, JSON.stringify(indexed));
          assert.match(access['Index Cond'], /series_id =/u);
          assert.match(access['Index Cond'], /observed_date >=/u);
          if (name !== 'panel trend') assert.match(access['Index Cond'], /observed_date <=/u);
          for (const node of nodes(indexed.Plan)) {
            if (['signal_runs','measurement_series','signal_observations'].includes(node['Relation Name'])) {
              assert.notEqual(node['Node Type'], 'Seq Scan', JSON.stringify(indexed));
            }
          }
          t.diagnostic(`${name}: 14600 stored, 28 returned; natural ${natural['Execution Time']}ms; observation indexes ${observation.map(node => node['Index Name'] ?? node['Node Type']).join(', ')}`);
        });
      }
    });
  } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') return t.skip(error.message);
    throw error;
  }
});
