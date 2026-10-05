import fs from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { HISTORY_FORMAT, schemaOf, sha256, contentOf, writePeriod, copyToParquet, publishManifest } from '../history-files.mjs';

export async function heldHistory(installation) {
  const output = path.join(installation, 'analytical-history');
  await fs.mkdir(output, { recursive: true });
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const schema = schemaOf([['id', 'VARCHAR'], ['report_date', 'VARCHAR'], ['value', 'VARCHAR'], ['fingerprint', 'VARCHAR']]);
  const derivation = { id: 'synthetic-held-tables' };
  const rows = [
    { id: 'held-1', report_date: '2024-01-01', value: 'retained observation' },
    { id: 'held-2', report_date: '2024-02-01', value: 'retained insight' },
  ].map(row => ({ ...row, fingerprint: sha256(JSON.stringify([row.id, row.report_date, row.value])) }));
  const files = [];
  const manifests = [];
  const insightRows = [{ id: 'held-insight-1', report_date: '2024-01-15', value: 'held insight snapshot' }]
    .map(row => ({ ...row, fingerprint: sha256(JSON.stringify([row.id, row.report_date, row.value])) }));
  try {
    const context = { connection, output, derivation, writeFile: copyToParquet, written: { tables: 0, files: [] } };
    for (const row of rows) files.push(await writePeriod(context, {
      dataset: 'signal_runs', folder: 'table-signal-runs', partition: row.report_date.slice(0, 7), schema,
      batches: [[row]], inputsFingerprint: row.fingerprint,
      encode: value => schema.columns.map(([name]) => value[name]), dayOf: value => value.report_date,
      compareDays: (left, right) => left.localeCompare(right),
    }));
    const insightFile = await writePeriod(context, {
      dataset: 'insight_snapshots', folder: 'table-insight-snapshots', partition: '2024-01', schema,
      batches: [insightRows], inputsFingerprint: insightRows[0].fingerprint,
      encode: value => schema.columns.map(([name]) => value[name]), dayOf: value => value.report_date,
      compareDays: (left, right) => left.localeCompare(right),
    });
    for (let generation = 1; generation <= 2; generation++) {
      const selected = files.slice(0, generation);
      const dataset = { name: 'signal_runs', table: 'signal_runs', schema,
        rowOrder: ['id'], rows: generation, digest: sha256(rows.slice(0, generation).map(row => row.fingerprint).sort().join('\n')),
        exportedThrough: '2024-02-29', files: selected };
      const manifest = {
        format: HISTORY_FORMAT, generation, publishedAt: `2026-09-0${generation}T00:00:00.000Z`,
        asset: null, derivation, sources: null, datasets: [],
        tables: { workspaceId: '00000000-0000-4000-8000-000000000001', backup: { sha256: 'a'.repeat(64) },
          asOf: '2026-09-02T00:00:00.000Z', derivation, datasets: [dataset, {
            name: 'insight_snapshots', table: 'insight_snapshots', schema, rowOrder: ['id'], rows: 1,
            digest: sha256(insightRows[0].fingerprint), exportedThrough: '2024-02-29', files: [insightFile],
          }] },
      };
      manifest.content = contentOf(manifest);
      await publishManifest(output, manifest);
      manifests.push(manifest);
    }
    files.push(insightFile);
  } finally { connection.closeSync(); instance.closeSync(); }
  return { output, relative: 'analytical-history', files, manifests, rows, insightRows };
}

export async function heldRows(restored, manifest, table = 'signal_runs') {
  const { tableFiles, sqlString } = await import('../history-files.mjs');
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const files = tableFiles(restored, manifest, table);
    return (await connection.runAndReadAll(`SELECT * FROM read_parquet([${files.map(sqlString).join(',')}]) ORDER BY id`)).getRowObjectsJS();
  } finally { connection.closeSync(); instance.closeSync(); }
}
