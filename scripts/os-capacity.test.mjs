import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  backupLine,
  capacityLines,
  capacitySection,
  formatBytes,
  newestBackup,
  readCapacity,
} from './os-capacity.mjs';

// `pnpm os:doctor`'s capacity section (bead ro-ujb9.66): it asks the runtime
// over the door and never opens the store, it formats what it is told, and a
// store it cannot ask is one line saying why rather than a failed report.

const DOOR = 'http://127.0.0.1:7651';

/** A synthetic answer in the shape workers/ingest/src/capacity.ts returns. */
function inventory(overrides = {}) {
  return {
    generatedAt: '2026-09-24T12:00:00.000Z',
    windows: { shortDays: 7, longDays: 30, shortSince: '2026-09-17', longSince: '2026-08-25' },
    store: {
      bytes: 50 * 1024 * 1024,
      valueBytes: 40 * 1024 * 1024,
      unattributedBytes: 10 * 1024 * 1024,
      tables: 2,
      views: ['financial_ledger'],
      missingTables: ['notifications'],
      rows: 1500,
      historyRowsPerDay: 120.5,
      historyBytesPerDay: 2048,
      scanMs: 42,
    },
    tables: [
      {
        name: 'property_insight_snapshots',
        shape: 'history',
        rows: 500,
        valueBytes: 39 * 1024 * 1024,
        largestColumn: { name: 'payload', bytes: 38 * 1024 * 1024 },
        arrival: 'created_at',
        firstAt: '2026-07-06T00:00:00.000Z',
        lastAt: '2026-09-24T00:00:00.000Z',
        rowsShortWindow: 14,
        rowsLongWindow: 60,
        bytesLongWindow: 3 * 1024 * 1024,
        rowsPerDay: 2,
        bytesPerDay: 100 * 1024,
        scanMs: 30,
      },
      {
        name: 'integration_leases',
        shape: 'state',
        rows: 3,
        valueBytes: 300,
        largestColumn: null,
        arrival: null,
        firstAt: null,
        lastAt: null,
        rowsShortWindow: null,
        rowsLongWindow: null,
        bytesLongWindow: null,
        rowsPerDay: null,
        bytesPerDay: null,
        scanMs: 0,
      },
    ],
    insightSnapshots: {
      rows: 500,
      payloadBytes: 38 * 1024 * 1024,
      maxPayloadBytes: 900 * 1024,
      rowsPerDay: 2,
      bytesPerDay: 100 * 1024,
      readRows: 2,
      readBytes: 200 * 1024,
      supersededRows: 498,
      supersededBytes: 38 * 1024 * 1024 - 200 * 1024,
      byAsset: [
        {
          asset: 'a.example',
          rows: 300,
          payloadBytes: 20 * 1024 * 1024,
          maxPayloadBytes: 900 * 1024,
          rowsLongWindow: 40,
          bytesLongWindow: 2 * 1024 * 1024,
          publishDaysLongWindow: 28,
          newestPayloadBytes: 100 * 1024,
        },
      ],
    },
    archive: {
      manifests: {
        runs: 10,
        objects: 6,
        objectBytes: 6 * 1024 * 1024,
        objectsPerDay: 0.2,
        bytesPerDay: 200 * 1024,
        byIntegration: [
          {
            integration: 'ga4',
            runs: 10,
            success: 6,
            unchanged: 3,
            error: 1,
            objects: 6,
            objectBytes: 6 * 1024 * 1024,
            newObjectsLongWindow: 6,
            newBytesLongWindow: 6 * 1024 * 1024,
          },
        ],
      },
      bucket: {
        objects: 7,
        bytes: 7 * 1024 * 1024,
        truncated: false,
        byPrefix: [{ prefix: 'raw/google/ga4', objects: 7, bytes: 7 * 1024 * 1024 }],
      },
    },
    lanes: [
      { job: 'backup', runs: 30, failed: 0, skipped: 0, p50Ms: 61_000, p95Ms: 90_000, maxMs: 95_000 },
      { job: 'beads-snapshot', runs: 40_000, failed: 2, skipped: 1, p50Ms: 300, p95Ms: 900, maxMs: 4_000 },
    ],
    ...overrides,
  };
}

test('bytes read in binary units, one decimal from KB up', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(50 * 1024 * 1024), '50.0 MB');
  assert.equal(formatBytes(null), 'unknown');
});

test('the report states the store, every table, the snapshots, the archive and the lanes', () => {
  const text = capacityLines(inventory()).join('\n');
  assert.match(text, /store {7}50\.0 MB on disk · 40\.0 MB in stored values · 10\.0 MB indexes/u);
  assert.match(text, /\+120\.5 rows\/day and \+2\.0 KB\/day into tables that keep every row \(≈ 730\.0 KB\/year/u);
  assert.match(text, /not in this store \(migration not applied\): notifications/u);
  assert.match(text, /property_insight_snapshots +history +500 +39\.0 MB +2 +100\.0 KB +payload 38\.0 MB +2026-07-06/u);
  // A table with no arrival column says so instead of claiming zero growth.
  assert.match(text, /integration_leases +state +3 +300 B +— +— +— +—/u);
  assert.match(text, /kept but unread: 498 rows/u);
  assert.match(text, /a\.example +300 rows +20\.0 MB +40 new on 28 days in the last 30/u);
  assert.match(text, /manifests: 10 runs · 6 objects · 6\.0 MB/u);
  assert.match(text, /6 stored, 3 unchanged, 1 failed/u);
  assert.match(text, /raw\/google\/ga4 +7 objects +7\.0 MB/u);
  // Slowest lane first.
  assert.ok(text.indexOf('backup') < text.indexOf('beads-snapshot'));
  assert.match(text, /backup +30 +0 +61\.0 s +90\.0 s +95\.0 s/u);
});

test('a truncated bucket listing and a failed one are both said out loud', () => {
  const truncated = inventory();
  truncated.archive.bucket.truncated = true;
  assert.match(capacityLines(truncated).join('\n'), /listing stopped early; the true total is larger/u);
  const failed = inventory();
  failed.archive.bucket = { error: 'bucket unavailable' };
  assert.match(capacityLines(failed).join('\n'), /bucket listing failed: bucket unavailable/u);
});

test('readCapacity asks GET /api/capacity at the door with the operator bearer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(inventory()), { status: 200 });
  };
  const answer = await readCapacity({ door: DOOR, token: 'test-token', fetchImpl });
  assert.equal(answer.store.tables, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DOOR}/api/capacity`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
});

test('the doctor section never throws: a door that is down or refuses is one line', async () => {
  const down = await capacitySection({
    door: DOOR,
    token: async () => 'test-token',
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(down[0], '## Capacity (metadata only, asked through the ingest door)');
  assert.match(down[1], /unavailable — the ingest door did not answer/u);

  const refused = await capacitySection({
    door: DOOR,
    token: async () => 'wrong',
    fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }),
  });
  assert.match(refused[1], /unavailable — \/api\/capacity answered HTTP 401/u);

  const noToken = await capacitySection({
    door: DOOR,
    token: async () => {
      throw new Error('OPERATOR_TOKEN is not set');
    },
    fetchImpl: async () => assert.fail('no request without a token'),
  });
  assert.match(noToken[1], /unavailable — OPERATOR_TOKEN is not set/u);
});

test('the backup line sizes the newest dated backup folder from stat alone', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'os-capacity-'));
  try {
    assert.equal(await newestBackup(path.join(root, 'absent')), null);
    await fs.mkdir(path.join(root, '2026-09-22', 'postgres'), { recursive: true });
    await fs.writeFile(path.join(root, '2026-09-22', 'postgres', 'noticeos.dump'), Buffer.alloc(10));
    await fs.mkdir(path.join(root, '2026-09-23', 'postgres'), { recursive: true });
    await fs.writeFile(path.join(root, '2026-09-23', 'postgres', 'noticeos.dump'), Buffer.alloc(2048));
    await fs.writeFile(path.join(root, '2026-09-23', 'RESTORE.md'), Buffer.alloc(1024));
    await fs.mkdir(path.join(root, 'not-a-date'));
    await fs.mkdir(path.join(root, '.backup-previous-2026-09-24'));
    await fs.writeFile(path.join(root, '.backup-previous-2026-09-24', 'noticeos.dump'), Buffer.alloc(4096));

    // Sizes come from stat: a reader that opened a file would fail here.
    const fsp = {
      readdir: fs.readdir,
      stat: fs.stat,
      open: () => assert.fail('a backup file was opened'),
      readFile: () => assert.fail('a backup file was read'),
    };
    const backup = await newestBackup(root, { fsp });
    assert.deepEqual(backup, { name: '2026-09-23', files: 2, bytes: 3072, truncated: false });
    assert.match(backupLine(backup), /newest 2026-09-23: 2 files, 3\.0 KB/u);
    assert.match(backupLine(null), /no nightly backup folder yet/u);

    const section = await capacitySection({
      door: DOOR,
      token: async () => 'test-token',
      fetchImpl: async () => new Response(JSON.stringify(inventory()), { status: 200 }),
      backupsDir: root,
      fsp,
    });
    assert.match(section.at(-1), /newest 2026-09-23/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
