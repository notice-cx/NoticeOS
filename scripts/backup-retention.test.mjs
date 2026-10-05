import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainedBackupDates, backupDate, backupReportComplete } from './backup-retention.mjs';

const legacyCounts = `# ReindexOS backup — 2026-09-01
Written by \`scripts/os-up.mjs\` in the example repo (nightly 04:00 UTC, or
a manual \`pnpm os:backup\`).
## This run
- D1: 3/3 database(s)
- R2: 2/2 database(s) + 7495 blob(s)
- task hub: 7/7 database(s)
`;

const legacyStatuses = `# ReindexOS backup — 2026-09-23
Created at 2026-09-23T04:31:20.452Z by \`scripts/host-backup.mjs\` (nightly 04:00 UTC or
manual \`pnpm os:backup\`).
## Backup set
- D1: completed; 3/3 copied
- R2: completed; 12404/12404 copied
- Task hub: completed; 7/7 copied
`;

test('historical reports remain recognizable across the product rename without overstating old counts', () => {
  assert.equal(backupReportComplete(legacyCounts, '2026-09-01'), 'legacy_unverified');
  assert.equal(backupReportComplete(legacyStatuses, '2026-09-23'), true);
  assert.equal(backupReportComplete(legacyStatuses.replace('ReindexOS', 'NoticeOS'), '2026-09-23'), true);
});

test('Postgres reports without manifests retain the same complete-set safeguards', () => {
  const postgres = legacyStatuses.replace('- D1: completed; 3/3 copied', '- Postgres: completed; 1/1 copied');
  assert.equal(backupReportComplete(postgres, '2026-09-23'), true);
  assert.equal(backupReportComplete(postgres.replace('Postgres: completed; 1/1', 'Postgres: failed; 0/1'), '2026-09-23'), false);
  assert.equal(backupReportComplete(postgres + '- Asset databases: failed; 0/1 copied\n', '2026-09-23'), false);
  assert.equal(backupReportComplete(postgres + '- Analytical history: completed; 1/1 copied\n', '2026-09-23'), true);
  assert.equal(backupReportComplete(postgres + '- Analytical history: failed; 0/1 copied\n', '2026-09-23'), false);
  assert.equal(backupReportComplete(postgres + '- Analytical history: not_configured; 0/unknown copied\n', '2026-09-23'), true);
  assert.equal(backupReportComplete(postgres + '- Analytical history: completed; 0/1 copied\n', '2026-09-23'), false);
  assert.equal(backupReportComplete(postgres + '- D1: completed; 3/3 copied\n', '2026-09-23'), null);
});

test('partial counts and failed statuses cannot become weekly recovery anchors', () => {
  assert.equal(backupReportComplete(legacyCounts.replace('2/2', '1/2'), '2026-09-01'), false);
  assert.equal(backupReportComplete(legacyStatuses.replace('R2: completed; 12404/12404', 'R2: failed; 11605/11606'), '2026-09-23'), false);
  assert.equal(backupReportComplete(legacyStatuses.replace('12404/12404', '12403/12404'), '2026-09-23'), false);
  assert.equal(backupReportComplete(legacyStatuses + '- Asset databases: failed; 0/1 copied\n', '2026-09-23'), false);
  assert.equal(backupReportComplete(legacyStatuses + '- Asset databases: not_configured; 0/unknown copied\n', '2026-09-23'), true);
});

test('unrelated, truncated, or mismatched reports remain outside automatic deletion', () => {
  assert.equal(backupReportComplete(legacyCounts, '2026-09-02'), null);
  assert.equal(backupReportComplete(legacyStatuses.replace('by `scripts/host-backup.mjs`', 'manual snapshot'), '2026-09-23'), null);
  assert.equal(backupReportComplete(legacyStatuses.replace('- Task hub: completed; 7/7 copied\n', ''), '2026-09-23'), null);
  assert.equal(backupReportComplete(legacyStatuses + '- Asset databases: unavailable\n', '2026-09-23'), null);
});

test('two daily and two weekly copies remain bounded over months of actual pruning', () => {
  let dates = [];
  const start = Date.parse('2026-08-03T00:00:00Z'); // Monday
  for (let index = 0; index < 90; index += 1) {
    const now = start + index * 86_400_000;
    const day = new Date(now).toISOString().slice(0, 10);
    dates = [...retainedBackupDates([...dates, day], { daily: 2, weekly: 2 })].sort();
    assert.ok(dates.length <= 4);
    assert.ok(dates.includes(day));
    if (index > 0) assert.ok(dates.includes(new Date(now - 86_400_000).toISOString().slice(0, 10)));
    if (index >= 7) assert.ok(dates.some((date) => now - backupDate(date) >= 7 * 86_400_000));
  }
});

test('missed days and week boundaries preserve available complete restore points', () => {
  assert.deepEqual([...retainedBackupDates(['2026-08-24', '2026-09-08', '2026-09-12', '2026-09-16'], { daily: 2, weekly: 2 })].sort(),
    ['2026-09-08', '2026-09-12', '2026-09-16']);
  assert.equal(backupDate('2026-02-31'), null);
  assert.deepEqual([...retainedBackupDates(['2026-09-02', '2026-09-12', '2026-09-14'], { daily: 2, weekly: 2 })].sort(),
    ['2026-09-02', '2026-09-12', '2026-09-14']);
});
