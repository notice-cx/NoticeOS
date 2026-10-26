import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DuckDBInstance } from '@duckdb/node-api';

const workerRequire = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
const { build } = createRequire(workerRequire.resolve('wrangler/package.json'))('esbuild');

// Translate scalar dialect differences only: the production aggregation,
// joins, grouping and session eligibility execute unchanged against fixtures.
// This checks arithmetic semantics, not acceptance by PostHog's HogQL parser.
function duckSql(sql) {
  return sql.replace(/\bPREWHERE\b/g, 'WHERE')
    .replaceAll('properties.$session_id', 'properties.session_id')
    .replace(/\bmatch\(/g, 'regexp_matches(');
}

const literal = (value) => value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const numeric = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));

test('generated PostHog queries weight additive totals and deduplicate eligible pageview sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'posthog-weighting-'));
  let instance;
  let connection;
  try {
    const outfile = path.join(dir, 'queries.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../workers/ingest/src/posthog-queries.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { posthogQuery } = await import(pathToFileURL(outfile).href);
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    for (const sql of [
      'CREATE MACRO toString(x) AS CAST(x AS VARCHAR)',
      'CREATE MACRO toDate(x) AS CAST(x AS DATE)',
      'CREATE MACRO toDateTime(x) AS CAST(x AS TIMESTAMP)',
      'CREATE MACRO toFloatOrZero(x) AS coalesce(try_cast(x AS DOUBLE), 0)',
      'CREATE MACRO uniq(x) AS count(DISTINCT x)',
      'CREATE TABLE events (timestamp TIMESTAMP, event VARCHAR, person_id VARCHAR, properties STRUCT(sample_weight VARCHAR, session_id VARCHAR))',
    ]) await connection.run(sql);

    const fixtures = [
      // Repeated sampled pageviews count individually, but their session once.
      ['$pageview', 'sampled', 'sampled', 5],
      ['$pageview', 'sampled', 'sampled', 5],
      // A fully collected non-pageview must not reduce pageview inclusion weight.
      ['login', 'sampled', 'sampled', 1],
      ['$pageview', 'mixed', 'mixed', 5],
      ['$pageview', 'mixed', 'mixed', 1],
      ['$pageview', 'missing', 'missing', undefined],
      // Missing and empty session IDs remain excluded from session totals.
      ['$pageview', 'no-id', null, 5],
      ['$pageview', 'empty-id', '', 1],
      // Fully collected events without a pageview do not establish eligibility.
      ['login', 'login-only', 'login-only', 1],
      ...[0, -5, 1.5, 'bad', 1000000, '05'].map((weight, index) => ['$pageview', `invalid-${index}`, `invalid-${index}`, weight]),
      ['$pageview', 'outside', 'outside', 5, '2026-01-02'],
    ];
    for (const [event, person, session, weight, date = '2026-01-01'] of fixtures) {
      await connection.run(`INSERT INTO events VALUES (${literal(`${date} 12:00:00`)}, ${literal(event)}, ${literal(person)}, {'sample_weight': ${literal(weight)}, 'session_id': ${literal(session)}})`);
    }
    const query = async (family) => (await connection.runAndReadAll(duckSql(posthogQuery(family, { start: '2026-01-01', end: '2026-01-01' }).text))).getRowObjectsJS().map(numeric);
    assert.deepEqual(await query('web-daily'), [{
      date: '2026-01-01', pageviews: 13, people: 11, sessions: 9,
      estimated_pageviews: 29, sampled_events: 4, estimated_sessions: 13,
    }]);
    assert.deepEqual(await query('events'), [
      { event: '$pageview', count: 13, people: 11, first_seen: '2026-01-01', last_seen: '2026-01-01', estimated_count: 29, sampled_events: 4 },
      { event: 'login', count: 2, people: 2, first_seen: '2026-01-01', last_seen: '2026-01-01', estimated_count: 2, sampled_events: 0 },
    ]);
  } finally {
    connection?.closeSync();
    instance?.closeSync();
    await rm(dir, { recursive: true, force: true });
  }
});
