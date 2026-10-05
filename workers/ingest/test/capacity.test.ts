import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openWorkspaceStore, type WorkspaceStore } from '@noticeos/postgres';
import tableCatalog from '../../../db/postgres/tables.json';
import {
  CAPACITY_LONG_DAYS,
  CAPACITY_SHORT_DAYS,
  type CapacityInventory,
  type TableCapacity,
  readCapacityInventory,
} from '../src/capacity.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { asOwner, call, reset, storeArchiveRuns, storeInsightSnapshots, storeSignalRuns } from './helpers.js';
import { addSites, removeSites } from './sites';

// The capacity inventory against a synthetic store (bead ro-ujb9.66). This test
// Postgres copy carries every migration, so it proves the operational catalog
// agrees with the schema. No capacity sample is written into D1.

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const SITE_A = 'capacity-a.example';
const SITE_B = 'capacity-b.example';
const LANE = 'capacity-test-lane';
const MARKER = 'capacity-stored-value-marker';

async function clearOwnRows(): Promise<void> {
  await removeSites([SITE_A, SITE_B]);
}

beforeEach(async () => {
  await reset();
  await clearOwnRows();
  await addSites([SITE_A, SITE_B].map((id) => ({ id, displayName: id, status: 'live', senseOnly: 1 })));
});

afterEach(async () => {
  await reset();
  await clearOwnRows();
});

function table(inventory: CapacityInventory, name: string): TableCapacity {
  const found = inventory.tables.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name} in the inventory`);
  return found;
}

function payloadOf(bytes: number): string {
  // '{"pad":""}' is ten bytes; the pad fills the rest with one-byte characters.
  return JSON.stringify({ pad: 'x'.repeat(bytes - 10) });
}

describe('GET /api/capacity', () => {
  it('answers only the operator', async () => {
    const anonymous = await call(new Request('https://ingest.local/api/capacity'));
    expect(anonymous.status).toBe(401);
    const wrong = await call(
      new Request('https://ingest.local/api/capacity', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);
  });

  it('measures every table the schema has, lists the views, and knows every table by its catalog', async () => {
    const res = await call(
      new Request('https://ingest.local/api/capacity', {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const inventory = (await res.json()) as CapacityInventory;

    const catalogued = Object.keys((tableCatalog as { tables: Record<string, unknown> }).tables).sort();
    expect(inventory.tables.map((t) => t.name).sort()).toEqual(catalogued);
    expect(inventory.store.missingTables).toEqual([]);
    expect(inventory.store.tables).toBe(catalogued.length);
    expect(inventory.store.views).toEqual(['current_flags', 'current_pulses', 'financial_ledger', 'mediavine_current_daily']);
    expect(inventory.tables.filter((t) => t.shape === 'undeclared')).toEqual([]);
    // Every table whose catalog names an arrival column is dated by it.
    for (const t of inventory.tables) {
      const entry = (tableCatalog as { tables: Record<string, { arrival: string | null }> }).tables[t.name];
      expect(t.arrival, t.name).toBe(entry?.arrival ?? null);
    }
    expect(inventory.store.bytes).toBeGreaterThan(0);
    expect(inventory.windows).toMatchObject({ shortDays: CAPACITY_SHORT_DAYS, longDays: CAPACITY_LONG_DAYS });
  });
});

describe('readCapacityInventory', () => {
  it('reads metadata only, through read-only transactions, with no D1 binding', async () => {
    const statements: string[] = [];
    const store: WorkspaceStore = {
      ...env.STORE,
      read: (work) => env.STORE.read((tx) => work({
        ...tx,
        query: (sql, params) => {
          statements.push(sql);
          return tx.query(sql, params);
        },
        execute: () => { throw new Error('capacity must not write'); },
      })),
      write: () => { throw new Error('capacity must not open a write transaction'); },
    };
    const inventory = await readCapacityInventory({ STORE: store, RAW_SIGNALS: env.RAW_SIGNALS }, NOW);
    expect(statements.every((sql) => /^\s*(SELECT|WITH)\b/.test(sql))).toBe(true);
    expect(inventory.tables.every((t) => t.scanMs >= 0)).toBe(true);
    expect(inventory.store.scanMs).toBeGreaterThan(0);
  });

  it('keeps other workspaces out of counts, growth, and physical byte totals', async () => {
    const workspaceId = await env.STORE.workspaceId();
    const scoped = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
    const other = '00000000-0000-4000-8000-000000000099';
    const before = table(await readCapacityInventory(env, NOW), 'egress_checks');
    await asOwner(`INSERT INTO noticeos.workspaces (workspace_id, slug, display_name)
      VALUES ('${other}', 'capacity-other', 'Other workspace');
      INSERT INTO noticeos.egress_checks (workspace_id, observed_at, up, detail)
      VALUES ('${other}', '${at(1)}', true, '{"note":"${MARKER}"}');`);
    try {
      const after = await readCapacityInventory({ STORE: scoped, RAW_SIGNALS: env.RAW_SIGNALS }, NOW);
      expect(table(after, 'egress_checks')).toMatchObject({
        rows: before.rows, valueBytes: before.valueBytes,
        rowsShortWindow: before.rowsShortWindow, rowsLongWindow: before.rowsLongWindow,
        bytesLongWindow: before.bytesLongWindow,
      });
      expect(after.store.bytes).toBeNull();
      expect(after.store.unattributedBytes).toBeNull();
      expect(after.tables.every((t) => t.relationBytes === null)).toBe(true);
      expect(after.archive?.bucket).toEqual({ error: 'Physical archive inventory requires a single-workspace store' });
      expect(JSON.stringify(after)).not.toContain(MARKER);
      expect(JSON.stringify(after)).not.toContain(other);
    } finally {
      await scoped.close();
      await asOwner(`TRUNCATE noticeos.egress_checks;
        DELETE FROM noticeos.workspaces WHERE workspace_id = '${other}';`);
    }
  });

  it('counts rows, stored bytes and arrivals in each window', async () => {
    const before = await readCapacityInventory(env, NOW);
    const envelope = JSON.stringify({ metrics: {}, note: MARKER, pad: 'p'.repeat(20_000) });
    await env.STORE.write(async (tx) => {
      for (const [i, daysAgo] of [2, 10, 40].entries()) {
        await tx.execute(
          `INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, received_at, envelope)
           VALUES ($1::uuid, $2, $3::date, $4::timestamptz, $5::json)`,
          [tx.workspaceId, SITE_A, `2026-08-0${i + 1}`, at(daysAgo), envelope],
        );
      }
    });
    const after = await readCapacityInventory(env, NOW);

    const was = table(before, 'pulses');
    const now = table(after, 'pulses');
    expect(now.rows - was.rows).toBe(3);
    expect((now.rowsShortWindow ?? 0) - (was.rowsShortWindow ?? 0)).toBe(1);
    expect((now.rowsLongWindow ?? 0) - (was.rowsLongWindow ?? 0)).toBe(2);
    expect(now.largestColumn?.name).toBe('envelope');
    // pg_column_size measures compressed stored bytes. This repeated pad
    // compresses under TOAST instead of being counted as its source text.
    const added = now.valueBytes - was.valueBytes;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(3 * envelope.length);
    const addedLong = (now.bytesLongWindow ?? 0) - (was.bytesLongWindow ?? 0);
    expect(addedLong).toBeGreaterThan(0);
    expect(addedLong).toBeLessThan(added);
    expect(now.relationBytes).toBeGreaterThan(0);
    expect(now.firstAt).toBe(at(40));
    expect(now.lastAt).toBe(at(2));
    expect(now.rowsPerDay).toBe(0.07);
    expect(after.store.historyRowsPerDay).toBe(
      Math.round(after.tables.filter((t) => t.shape === 'history').reduce((sum, t) => sum + (t.rowsPerDay ?? 0), 0) * 100) / 100,
    );

    // The answer carries sizes and dates, never a stored value.
    expect(JSON.stringify(after)).not.toContain(MARKER);
  });

  it('dates an observation by the run that wrote it', async () => {
    const before = table(await readCapacityInventory(env, NOW), 'signal_observations');
    const runs = [
      { id: 'capacity-run-recent', finished: at(3), observations: 5 },
      { id: 'capacity-run-old', finished: at(45), observations: 4 },
    ];
    await storeSignalRuns(runs.map((run) => ({
      run: { id: run.id, asset: SITE_A, integration: 'ga4', property_ref: 'properties/1',
        finished_at: run.finished, window_start: '2026-07-01', window_end: '2026-07-28' },
      values: Array.from({ length: run.observations }, (_, i) => ({ date: `2026-07-${String(i + 10)}`, metric: 'sessions', value: i })),
    })));
    const after = table(await readCapacityInventory(env, NOW), 'signal_observations');
    expect(after.arrival).toBe('finished_at');
    expect(after.rows - before.rows).toBe(9);
    expect((after.rowsLongWindow ?? 0) - (before.rowsLongWindow ?? 0)).toBe(5);
    expect((after.rowsShortWindow ?? 0) - (before.rowsShortWindow ?? 0)).toBe(5);
  });

  it('divides a new history table by the days actually observed', async () => {
    await env.STORE.write((tx) => tx.execute(
      `INSERT INTO noticeos.egress_checks (workspace_id, observed_at, up)
       SELECT $1::uuid, stamp, true FROM unnest($2::timestamptz[]) AS stamp`,
      [tx.workspaceId, [at(5), at(4), at(1)]],
    ));
    const measured = table(await readCapacityInventory(env, NOW), 'egress_checks');
    expect(measured.rowsPerDay).toBe(0.6);
    expect(measured.bytesPerDay).toBe(Math.round(measured.valueBytes / 5));
  });

  it('sizes insight snapshots per site: what is read, what is superseded, what arrives per day', async () => {
    const before = (await readCapacityInventory(env, NOW)).insightSnapshots;
    expect(before).not.toBeNull();
    const rows = [
      { asset: SITE_A, id: 'a-old', bytes: 3_000, daysAgo: 40 },
      { asset: SITE_A, id: 'a-mid', bytes: 2_000, daysAgo: 5 },
      { asset: SITE_A, id: 'a-new', bytes: 1_000, daysAgo: 1 },
      { asset: SITE_B, id: 'b-only', bytes: 4_000, daysAgo: 2 },
    ];
    await storeInsightSnapshots(rows.map((row) => ({
      id: `capacity-${row.id}`, asset: row.asset, generated_at: at(row.daysAgo), created_at: at(row.daysAgo),
      payload: payloadOf(row.bytes),
    })));
    const snapshots = (await readCapacityInventory(env, NOW)).insightSnapshots;
    expect(snapshots).not.toBeNull();
    const a = snapshots?.byAsset.find((s) => s.asset === SITE_A);
    const b = snapshots?.byAsset.find((s) => s.asset === SITE_B);
    expect(a).toEqual({
      asset: SITE_A,
      rows: 3,
      payloadBytes: 6_000,
      maxPayloadBytes: 3_000,
      rowsLongWindow: 2,
      bytesLongWindow: 3_000,
      publishDaysLongWindow: 2,
      newestPayloadBytes: 1_000,
    });
    expect(b).toMatchObject({ rows: 1, payloadBytes: 4_000, newestPayloadBytes: 4_000 });
    // The Tower reads each site's two newest (the site page the newest, the
    // Wall's feed both): a-new and a-mid, and b-only. Only a-old is kept unread.
    const added = (field: 'readRows' | 'readBytes' | 'supersededRows' | 'supersededBytes') =>
      (snapshots?.[field] ?? 0) - (before?.[field] ?? 0);
    expect(added('readRows')).toBe(3);
    expect(added('readBytes')).toBe(7_000);
    expect(added('supersededRows')).toBe(1);
    expect(added('supersededBytes')).toBe(3_000);
  });

  it('counts each archive object once, however many runs reuse it, and lists the bucket by producer', async () => {
    const manifest = (id: string, status: 'success' | 'unchanged' | 'error', key: string | null, bytes: number | null, daysAgo: number) => ({
      id, asset: SITE_A, integration: 'ga4', report: 'pages', credential_ref: 'test', property_ref: 'properties/1',
      report_date: '2026-09-01', finished_at: at(daysAgo), status, data_state: 'revision-window' as const,
      provider_rows: 1, request_count: 1, ...(key === null ? {} : { object_key: key }), ...(bytes === null ? {} : { object_bytes: bytes }),
      error_code: 'test_error', error_message: 'synthetic failure',
    });
    await storeArchiveRuns([
      manifest('m1', 'success', 'raw/capacity-test/ga4/one.json.gz', 100, 40),
      manifest('m2', 'unchanged', 'raw/capacity-test/ga4/one.json.gz', 100, 3),
      manifest('m3', 'success', 'raw/capacity-test/ga4/two.json.gz', 200, 2),
      manifest('m4', 'error', null, null, 1),
    ]);
    await env.RAW_SIGNALS.put('raw/capacity-test/ga4/one.json.gz', new Uint8Array(100));
    await env.RAW_SIGNALS.put('raw/capacity-test/ga4/two.json.gz', new Uint8Array(200));

    const archive = (await readCapacityInventory(env, NOW)).archive;
    const ga4 = archive?.manifests.byIntegration.find((row) => row.integration === 'ga4');
    expect(ga4).toEqual({
      integration: 'ga4',
      runs: 4,
      success: 2,
      unchanged: 1,
      error: 1,
      objects: 2,
      objectBytes: 300,
      newObjectsLongWindow: 1,
      newBytesLongWindow: 200,
    });
    const bucket = archive?.bucket;
    expect(bucket && 'byPrefix' in bucket ? bucket.byPrefix : null).toEqual([
      { prefix: 'raw/capacity-test/ga4', objects: 2, bytes: 300 },
    ]);
  });

  it('reports each lane’s nearest-rank p50 and p95 from the firings the runner recorded', async () => {
    await env.STORE.write(async (tx) => {
      for (let i = 0; i < 20; i += 1) {
        const started = NOW - (i + 1) * 3_600_000;
        await tx.execute(
          `INSERT INTO noticeos.job_runs (workspace_id, job, scheduled_at, started_at, finished_at, outcome, detail, recorded_at)
           VALUES ($1::uuid, $2, NULL, $3::timestamptz, $4::timestamptz, $5, NULL, $4::timestamptz)`,
          [tx.workspaceId, LANE, new Date(started).toISOString(), new Date(started + (i + 1) * 1_000).toISOString(), i === 0 ? 'failed' : 'ran'],
        );
      }
    });
    const lanes = (await readCapacityInventory(env, NOW)).lanes;
    expect(lanes?.find((lane) => lane.job === LANE)).toEqual({
      job: LANE,
      runs: 20,
      failed: 1,
      skipped: 0,
      p50Ms: 10_000,
      p95Ms: 19_000,
      maxMs: 20_000,
    });
  });

  it('still measures a table the catalog has never heard of, and says so', async () => {
    await asOwner(`CREATE TABLE noticeos.capacity_probe_undeclared (workspace_id uuid NOT NULL, body text);
      ALTER TABLE noticeos.capacity_probe_undeclared ENABLE ROW LEVEL SECURITY;
      ALTER TABLE noticeos.capacity_probe_undeclared FORCE ROW LEVEL SECURITY;
      CREATE POLICY scoped ON noticeos.capacity_probe_undeclared USING (workspace_id = noticeos.current_workspace_id());
      GRANT SELECT, INSERT ON noticeos.capacity_probe_undeclared TO noticeos_app;`);
    try {
      await env.STORE.write((tx) => tx.execute(
        `INSERT INTO noticeos.capacity_probe_undeclared (workspace_id, body) VALUES ($1::uuid, 'abcd')`, [tx.workspaceId],
      ));
      const probe = table(await readCapacityInventory(env, NOW), 'capacity_probe_undeclared');
      expect(probe).toMatchObject({
        shape: 'undeclared',
        rows: 1,
        arrival: null,
        rowsPerDay: null,
        largestColumn: { name: 'workspace_id', bytes: 16 },
      });
    } finally {
      await asOwner(`DROP TABLE noticeos.capacity_probe_undeclared;`);
    }
  });

  it('reports a catalogued table missing from the store', async () => {
    await asOwner(`ALTER TABLE noticeos.integration_leases RENAME TO capacity_missing_probe;
      ALTER TABLE noticeos.asset_insight_snapshots RENAME TO capacity_missing_snapshots;
      ALTER TABLE noticeos.job_runs RENAME TO capacity_missing_lanes;
      ALTER TABLE noticeos.archive_runs RENAME TO capacity_missing_archive;`);
    try {
      const inventory = await readCapacityInventory(env, NOW);
      expect(inventory.store.missingTables).toEqual(['archive_runs', 'asset_insight_snapshots', 'integration_leases', 'job_runs']);
      expect(table(inventory, 'capacity_missing_probe').shape).toBe('undeclared');
      expect(inventory.insightSnapshots).toBeNull();
      expect(inventory.lanes).toBeNull();
      expect(inventory.archive).toBeNull();
    } finally {
      await asOwner(`ALTER TABLE noticeos.capacity_missing_probe RENAME TO integration_leases;
        ALTER TABLE noticeos.capacity_missing_snapshots RENAME TO asset_insight_snapshots;
        ALTER TABLE noticeos.capacity_missing_lanes RENAME TO job_runs;
        ALTER TABLE noticeos.capacity_missing_archive RENAME TO archive_runs;`);
    }
  });
});
