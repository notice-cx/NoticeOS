import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyticalHistoryDirectory, backupAnalyticalHistory, verifyAnalyticalHistoryBackup,
  retainedAnalyticalHistoryDates, assertAnalyticalHistoryReplacement } from './analytical-history-backup.mjs';
import { contentOf, publishManifest, readCurrentGeneration, sha256 } from './history-files.mjs';
import { heldHistory, heldRows } from './test-fixtures/analytical-history.mjs';

async function fixture(t) {
  const installation = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-history-custody-'));
  t.after(() => fs.rm(installation, { recursive: true, force: true }));
  const history = await heldHistory(installation);
  const output = path.join(installation, 'backup');
  return { installation, history, output,
    capture: (io = fs) => backupAnalyticalHistory({ installation, relative: history.relative, output, io }) };
}

test('all published generations and held rows restore without the original directory', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.history.output, 'unpublished.tmp'), 'not a published dataset');
  const receipt = await f.capture();
  assert.equal(receipt.generations.length, 2);
  assert.equal(receipt.files.length, 3, 'shared references copy once');
  assert.deepEqual([...new Set(receipt.heldFiles.map(file => file.table))].sort(), ['insight_snapshots', 'signal_runs']);
  await assert.rejects(fs.stat(path.join(f.output, 'unpublished.tmp')), { code: 'ENOENT' });
  await fs.rm(f.history.output, { recursive: true });
  assert.deepEqual(await verifyAnalyticalHistoryBackup(f.output), receipt);
  const manifest = await readCurrentGeneration(f.output);
  const rows = await heldRows(f.output, manifest);
  assert.deepEqual(rows, f.history.rows);
  assert.deepEqual(await heldRows(f.output, manifest, 'insight_snapshots'), f.history.insightRows);
  for (const row of rows) assert.equal(row.fingerprint, sha256(JSON.stringify([row.id, row.report_date, row.value])));
  assert.equal(sha256(rows.map(row => row.fingerprint).sort().join('\n')), manifest.tables.datasets[0].digest);
});

test('new immutable publication does not invalidate the pinned generation closure', async t => {
  const f = await fixture(t);
  let published = false;
  const io = { ...fs, mkdir: async (...args) => {
    if (args[0] === f.output && !published) {
      published = true;
      const next = structuredClone(f.history.manifests[1]);
      next.generation = 3;
      await publishManifest(f.history.output, next);
    }
    return fs.mkdir(...args);
  } };
  assert.deepEqual((await f.capture(io)).generations.map(row => row.generation), [1, 2]);
  assert.equal((await readCurrentGeneration(f.history.output)).generation, 3);
});

for (const issue of ['missing-file', 'damaged-file', 'incomplete-generation', 'changed-generation', 'removed-generation', 'conflicting-shared-file', 'symlink-file', 'symlink-directory']) {
  test(`${issue} cannot establish completed history custody`, async t => {
    const f = await fixture(t);
    const first = path.join(f.history.output, f.history.files[0].path);
    let io = fs;
    if (issue === 'missing-file') await fs.unlink(first);
    if (issue === 'damaged-file') await fs.writeFile(first, 'corrupt');
    if (issue === 'incomplete-generation') {
      const manifest = structuredClone(f.history.manifests[1]);
      delete manifest.tables.datasets[0].files[0].sha256;
      await fs.writeFile(path.join(f.history.output, 'generations/00000002.json'), JSON.stringify(manifest));
    }
    if (issue === 'conflicting-shared-file') {
      const manifest = structuredClone(f.history.manifests[1]);
      manifest.tables.datasets[0].files[0].sha256 = 'b'.repeat(64);
      await fs.writeFile(path.join(f.history.output, 'generations/00000002.json'), JSON.stringify(manifest));
    }
    if (issue === 'symlink-file') { await fs.rename(first, first + '.original'); await fs.symlink(first + '.original', first); }
    if (issue === 'symlink-directory') {
      const dir = path.dirname(first);
      await fs.rename(dir, dir + '-original');
      await fs.symlink(dir + '-original', dir);
    }
    if (['changed-generation', 'removed-generation'].includes(issue)) io = { ...fs, mkdir: async (...args) => {
      if (args[0] === f.output) {
        const file = path.join(f.history.output, 'generations/00000001.json');
        if (issue === 'removed-generation') await fs.unlink(file);
        else {
          const manifest = structuredClone(f.history.manifests[0]);
          manifest.tables.asOf = '2026-09-30T00:00:00.000Z';
          manifest.content = contentOf(manifest);
          await fs.writeFile(file, JSON.stringify(manifest));
        }
      }
      return fs.mkdir(...args);
    } };
    await assert.rejects(f.capture(io));
    await assert.rejects(verifyAnalyticalHistoryBackup(f.output));
  });
}

test('undeclared, missing and unsafe source paths refuse before copying', async t => {
  const f = await fixture(t);
  for (const value of ['', '../outside', '/absolute', 'a/../b', 'a//b', 'a\\b', 'a\0b', '.', 42]) {
    assert.throws(() => analyticalHistoryDirectory({ analyticalHistoryDirectory: value }), /inside the installation/u);
  }
  assert.equal(analyticalHistoryDirectory({}), null);
  assert.equal(analyticalHistoryDirectory({ analyticalHistoryDirectory: null }), null);
  await assert.rejects(backupAnalyticalHistory({ installation: f.installation, relative: 'missing', output: f.output }), { code: 'ENOENT' });
  await assert.rejects(backupAnalyticalHistory({ installation: f.installation, relative: '../outside', output: f.output }), /inside the installation/u);
  await fs.mkdir(path.join(f.installation, 'empty/generations'), { recursive: true });
  await assert.rejects(backupAnalyticalHistory({ installation: f.installation, relative: 'empty', output: f.output }), /no published generation/u);
  await assert.rejects(backupAnalyticalHistory({ installation: f.installation, relative: f.history.relative, output: path.join(f.history.output, 'backup') }), /separate folders/u);
});

test('restored byte damage or a missing retained generation fails custody verification', async t => {
  const f = await fixture(t);
  await f.capture();
  const file = path.join(f.output, f.history.files[0].path);
  const original = await fs.readFile(file);
  await fs.writeFile(file, 'damaged handoff');
  await assert.rejects(verifyAnalyticalHistoryBackup(f.output), /Parquet bytes/u);
  await fs.writeFile(file, original);
  await fs.unlink(path.join(f.output, 'generations/00000001.json'));
  await assert.rejects(verifyAnalyticalHistoryBackup(f.output), /generation closure/u);
});

test('rotation keeps the newest verified coverage for held table files after disabling or reducing history', async t => {
  const f = await fixture(t);
  const receipt = await f.capture();
  const base = path.join(f.installation, 'dated');
  const writeSet = async (day, source = f.output, custody = receipt) => {
    const folder = path.join(base, day);
    await fs.mkdir(folder, { recursive: true });
    if (custody) await fs.cp(source, path.join(folder, 'history'), { recursive: true });
    await fs.writeFile(path.join(folder, 'backup.json'), JSON.stringify({ format: 'noticeos-backup-v1', complete: true,
      ...(custody ? { analyticalHistory: custody } : {}) }));
  };
  await writeSet('2026-08-01');
  await writeSet('2026-09-01', null, null);
  assert.deepEqual([...await retainedAnalyticalHistoryDates(base, ['2026-08-01', '2026-09-01'], new Set(['2026-09-01']))].sort(),
    ['2026-08-01', '2026-09-01']);
  await fs.unlink(path.join(f.history.output, 'generations/00000002.json'));
  const smaller = path.join(f.installation, 'smaller');
  const smallerCustody = await backupAnalyticalHistory({ installation: f.installation, relative: f.history.relative, output: smaller });
  await writeSet('2026-09-02', smaller, smallerCustody);
  assert.deepEqual([...await retainedAnalyticalHistoryDates(base, ['2026-08-01', '2026-09-01', '2026-09-02'], new Set(['2026-09-02']))].sort(),
    ['2026-08-01', '2026-09-02']);
  await assert.rejects(assertAnalyticalHistoryReplacement(path.join(base, '2026-08-01'), path.join(base, '2026-09-02')), /discard retained/u);
  await writeSet('2026-09-03');
  assert.deepEqual([...await retainedAnalyticalHistoryDates(base, ['2026-08-01', '2026-09-02', '2026-09-03'], new Set(['2026-09-03']))], ['2026-09-03']);
  await fs.writeFile(path.join(base, '2026-09-03/history', f.history.files[0].path), 'damaged retained copy');
  await assert.rejects(retainedAnalyticalHistoryDates(base, ['2026-08-01', '2026-09-03'], new Set(['2026-09-03'])), /Parquet bytes/u);
});

test('coverage is derived once per candidate and a same-day replacement needs the entire held closure', async t => {
  const f = await fixture(t);
  const custody = await f.capture();
  const base = path.join(f.installation, 'dated');
  for (const date of ['2026-08-01', '2026-09-01']) {
    await fs.mkdir(path.join(base, date), { recursive: true });
    await fs.cp(f.output, path.join(base, date, 'history'), { recursive: true });
    await fs.writeFile(path.join(base, date, 'backup.json'), JSON.stringify({ format: 'noticeos-backup-v1', complete: true, analyticalHistory: custody }));
  }
  const opened = [];
  const io = { ...fs, open: async (...args) => { opened.push(args[0]); return fs.open(...args); } };
  assert.deepEqual([...await retainedAnalyticalHistoryDates(base, ['2026-08-01', '2026-09-01'], new Set(['2026-09-01']), { io })], ['2026-09-01']);
  for (const date of ['2026-08-01', '2026-09-01']) for (const file of custody.files) {
    assert.equal(opened.filter(name => name === path.join(base, date, 'history', file.path)).length, 1);
  }
  await assertAnalyticalHistoryReplacement(path.join(base, '2026-08-01'), path.join(base, '2026-09-01'));
  await fs.writeFile(path.join(base, '2026-09-01/backup.json'), JSON.stringify({ format: 'noticeos-backup-v1', complete: false, analyticalHistory: custody }));
  await assert.rejects(retainedAnalyticalHistoryDates(base, ['2026-08-01', '2026-09-01'], new Set(['2026-09-01'])), /Incomplete history custody/u);
});

for (const damage of ['missing-marker', 'unknown-format', 'missing-history-metadata']) {
  test(`${damage} cannot hide retained held rows from rotation or replacement`, async t => {
    const f = await fixture(t);
    const custody = await f.capture();
    const base = path.join(f.installation, 'dated');
    const previous = path.join(base, '2026-08-01');
    const next = path.join(base, '2026-09-01');
    await fs.mkdir(previous, { recursive: true }); await fs.mkdir(next);
    await fs.cp(f.output, path.join(previous, 'history'), { recursive: true });
    const marker = { format: 'noticeos-backup-v1', complete: true, analyticalHistory: custody };
    if (damage === 'unknown-format') marker.format = 'damaged-format';
    if (damage === 'missing-history-metadata') delete marker.analyticalHistory;
    if (damage !== 'missing-marker') await fs.writeFile(path.join(previous, 'backup.json'), JSON.stringify(marker));
    await fs.writeFile(path.join(next, 'backup.json'), JSON.stringify({ format: 'noticeos-backup-v1', complete: true }));
    await assert.rejects(retainedAnalyticalHistoryDates(base, ['2026-08-01', '2026-09-01'], new Set(['2026-09-01'])));
    await assert.rejects(assertAnalyticalHistoryReplacement(previous, next));
    assert.deepEqual(await verifyAnalyticalHistoryBackup(path.join(previous, 'history')), custody);
  });
}
