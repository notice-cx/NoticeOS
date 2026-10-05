import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { rmSync, writeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { runBackup, backupRunOutcome, hostBackupFile, readOffsiteBackupDir } from './host-backup.mjs';
import { runJobLane } from './os-up.mjs';
import { createWorkflowRecorder } from './workflow-trace.mjs';
import { isWorkflowStepOutput } from './workflow-output.mjs';
import { heldHistory, heldRows } from './test-fixtures/analytical-history.mjs';
import { verifyAnalyticalHistoryBackup } from './analytical-history-backup.mjs';
import { readCurrentGeneration } from './history-files.mjs';

const NOW = Date.parse('2026-09-14T04:00:00Z');
const DAY = '2026-09-14';

async function fixture(t, prefix = 'host-backup-') {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const postgres = path.join(repoRoot, 'postgres');
  const profileFile = path.join(postgres, 'profile.json');
  const r2 = path.join(repoRoot, '.wrangler/state/v3/r2');
  const backupRoot = path.join(repoRoot, '.local/backups');
  const destination = path.join(backupRoot, DAY);
  const syncParent = path.join(repoRoot, 'sync');
  const offsite = path.join(syncParent, 'backups');
  const hostFile = path.join(repoRoot, 'config/task-host.json');
  const write = async (file, contents = 'fixture') => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  const host = (repositories) => write(hostFile, JSON.stringify({ repositories }));
  const profile = { project: 'noticeos-test-backup', composeFile: path.join(postgres, 'compose.yaml'), secretsDir: path.join(postgres, 'secrets'), port: 5401 };
  await write(profileFile, JSON.stringify(profile));
  await write(profile.composeFile, 'synthetic compose');
  await fs.mkdir(profile.secretsDir);
  await write(path.join(r2, 'metadata.sqlite'), 'R2 metadata');
  await write(path.join(r2, 'metadata.sqlite-shm'), 'must not copy sidecars');
  await write(path.join(r2, 'blobs/archive'), 'raw archive');
  await host([{ database: 'ro', repo: '/missing/checkout' }, { database: 'mp' }]);
  await fs.mkdir(syncParent);
  const calls = [];
  const control = { fail: () => false, spawnError: false, timeout: false };
  function fakeSpawn(binary, args, options) {
    const child = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    let source, output, database;
    if (binary === 'docker') {
      if (args[0] === 'context') {
        child.stdout = new EventEmitter();
        queueMicrotask(() => { child.stdout.emit('data', control.context ?? 'unix:///synthetic/docker.sock'); child.emit('close', 0, null); });
        calls.push({ binary, args, options, context: true });
        return child;
      }
      assert.deepEqual(args.slice(0, 7), ['compose', '--env-file', '/dev/null', '-p', profile.project, '-f', profile.composeFile]);
      assert.ok(args.includes('--host=/var/run/postgresql'));
      assert.ok(args.includes('--no-password'));
      output = 'postgres/noticeos.dump';
    } else if (binary === 'sqlite3') {
      assert.equal(args[0], '-bail');
      assert.equal(new URL(args[1]).search, '?mode=rw');
      assert.deepEqual(args.slice(2, 4), ['.timeout 5000', '.filectrl persist_wal 0']);
      assert.equal(args.length, 5);
      source = fileURLToPath(args[1]);
      output = JSON.parse(args[4].slice('.backup '.length));
    } else {
      assert.equal(binary, '/controlled/bd');
      assert.deepEqual(args.slice(0, 4), ['-C', repoRoot, '--quiet', 'sql']);
      const match = /^USE (\w+); CALL DOLT_BACKUP\('sync-url', 'file:\/\/(.*)'\)$/.exec(args[4]);
      assert.ok(match, 'uses the consistent live-server backup command');
      [, database, output] = match;
      output = output.replaceAll("''", "'").replaceAll('\\\\', '\\');
    }
    const call = { binary, args, source, output, database, options };
    calls.push(call);
    queueMicrotask(async () => {
      try {
        if (control.spawnError) { child.emit('error', new Error('Executable unavailable')); return; }
        if (control.timeout) return;
        if (control.omitOutput) { child.emit('close', 0, null); return; }
        if (binary === 'docker') writeSync(options.stdio[1], Buffer.from('PGDMP synthetic dump'));
        else if (database) await write(path.join(output, 'snapshot'), database);
        else await fs.copyFile(source, output);
        child.emit('close', control.fail(call) ? 1 : 0, null);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  }
  const settings = { repoRoot, retentionDays: 30, offsiteBackupDir: offsite, bdBinary: '/controlled/bd' };
  const adapters = { cloudflareD1: { inventory: async () => null }, spawn: fakeSpawn, now: () => NOW, env: { PATH: '/controlled' }, claimNamespace: 'a'.repeat(64) };
  return {
    repoRoot, postgres, profileFile, profile, r2, backupRoot, destination, offsite, syncParent, hostFile,
    write, host, calls, control, settings, adapters, fakeSpawn,
    run: (overrides = {}) => runBackup(settings, { ...adapters, ...overrides }),
  };
}

async function absent(file) {
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
}

function nativeFixture(assets = ['first.example', 'second.example', 'third.example']) {
  const accountId = 'a'.repeat(32);
  const selection = { version: 1, accountId, targets: assets.map(asset => ({ asset, databaseId: randomUUID() })) };
  const sql = 'CREATE TABLE native_fixture(id INTEGER); INSERT INTO native_fixture VALUES(17);';
  const control = { failure: null, changed: false, inventoryCalls: 0, exports: [] };
  const client = {
    inventory: async () => { control.inventoryCalls++; return control.changed && control.inventoryCalls > 1 ? { ...selection, targets: [] } : selection; },
    exportTarget: async (_, target) => {
      control.exports.push(target.databaseId);
      if (control.failure === target.databaseId) throw new Error('Synthetic native export failure');
      return { version: 1, accountId, ...target, runId: randomUUID(), state: 'complete', startedAt: '2026-09-14T04:00:00Z', finishedAt: '2026-09-14T04:00:01Z',
        bytes: Buffer.byteLength(sql), sha256: createHash('sha256').update(sql).digest('hex'), failure: null };
    },
    artifact: async () => new Response(sql),
  };
  return { client, selection, control, sql };
}

test('native D1 backups cover every selected target with gzip and restore custody in local and offsite sets', async t => {
  const f = await fixture(t), native = nativeFixture();
  const result = await f.run({ cloudflareD1: native.client });
  assert.equal(result.ok, true, result.detail); assert.equal(result.stages.assets.expected, 3); assert.equal(result.stages.assets.copied, 3);
  assert.deepEqual(native.control.exports, native.selection.targets.map(target => target.databaseId));
  for (const base of [f.destination, path.join(f.offsite, DAY)]) {
    const manifest = JSON.parse(await fs.readFile(path.join(base, 'backup.json'), 'utf8'));
    assert.equal(manifest.complete, true); assert.equal(manifest.cloudflareD1.length, 3);
    for (const item of manifest.cloudflareD1) {
      const gzip = await fs.readFile(path.join(base, item.directory, 'export.sql.gz'));
      assert.equal(gunzipSync(gzip).toString(), native.sql);
      assert.equal(createHash('sha256').update(gzip).digest('hex'), item.gzip.sha256);
      assert.equal(createHash('sha256').update(gunzipSync(gzip)).digest('hex'), item.receipt.sha256);
      const { directory: _directory, ...custody } = item;
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(base, item.directory, 'receipt.json'), 'utf8')), custody);
    }
    assert.match(await fs.readFile(path.join(base, 'RESTORE.md'), 'utf8'), /Native D1:/);
  }
});
test('a failed native target still attempts the rest and preserves both prior complete sets and retention', async t => {
  const f = await fixture(t), native = nativeFixture();
  assert.equal((await f.run({ cloudflareD1: native.client })).ok, true);
  const before = await fs.readFile(path.join(f.destination, 'backup.json'));
  await previousSets(f, ['2026-07-01']); native.control.exports = []; native.control.failure = native.selection.targets[1].databaseId;
  const result = await f.run({ cloudflareD1: native.client });
  assert.equal(result.ok, false); assert.equal(result.stages.assets.expected, 3); assert.equal(result.stages.assets.copied, 2);
  assert.equal(result.stages.publication.status, 'blocked'); assert.equal(result.stages.retention.status, 'blocked');
  assert.equal(native.control.exports.length, 3);
  for (const base of [f.backupRoot, f.offsite]) {
    assert.deepEqual(await fs.readFile(path.join(base, DAY, 'backup.json')), before);
    assert.ok((await fs.readdir(base)).includes('2026-07-01'));
  }
});
test('a changed native selection refuses complete-set publication and leaves the prior backup intact', async t => {
  const f = await fixture(t), native = nativeFixture();
  assert.equal((await f.run({ cloudflareD1: native.client })).ok, true);
  const before = await fs.readFile(path.join(f.destination, 'backup.json')); native.control.changed = true; native.control.inventoryCalls = 0;
  const result = await f.run({ cloudflareD1: native.client });
  assert.equal(result.stages.assets.status, 'failed'); assert.equal(result.stages.assets.copied, 3);
  assert.equal(result.stages.publication.status, 'blocked'); assert.deepEqual(await fs.readFile(path.join(f.destination, 'backup.json')), before);
});
test('native and legacy coverage of the same asset is refused before either exporter runs', async t => {
  const f = await fixture(t), native = nativeFixture(['example.com']); await assetFixture(f);
  let legacyCalls = 0;
  const result = await f.run({ cloudflareD1: native.client, spawn: (binary, args, options) => {
    if (binary === 'npm') { legacyCalls++; assert.fail('overlap must refuse before execution'); }
    return f.fakeSpawn(binary, args, options);
  } });
  assert.equal(result.stages.assets.status, 'failed'); assert.match(result.stages.assets.errors[0].detail, /both legacy and native/);
  assert.equal(legacyCalls, 0); assert.equal(native.control.exports.length, 0);
});

for (const initial of ['disconnected', 'empty']) test(`a native selection added during legacy capture from ${initial} refuses publication`, async t => {
  const f = await fixture(t), native = nativeFixture(['native.example']);
  assert.equal((await f.run()).ok, true);
  const before = await fs.readFile(path.join(f.destination, 'backup.json'));
  await previousSets(f, ['2026-07-01']); await assetFixture(f);
  let selection = initial === 'disconnected' ? null : { ...native.selection, targets: [] };
  const result = await f.run({ cloudflareD1: { ...native.client, inventory: async () => selection },
    spawn: (binary, args, options) => {
      if (binary !== 'npm') return f.fakeSpawn(binary, args, options);
      selection = native.selection;
      return spawn(binary, args, options);
    } });
  assert.equal(result.stages.assets.status, 'failed');
  assert.equal(result.stages.assets.copied, 1);
  assert.equal(result.stages.publication.status, 'blocked');
  assert.equal(result.stages.offsite.status, 'blocked');
  assert.equal(result.stages.retention.status, 'blocked');
  assert.equal(native.control.exports.length, 0);
  for (const base of [f.backupRoot, f.offsite]) {
    assert.deepEqual(await fs.readFile(path.join(base, DAY, 'backup.json')), before);
    await fs.access(path.join(base, '2026-07-01/backup.json'));
  }
});

test('container job results give a bounded stage verdict without internal worker diagnostics', async t => {
  const f = await fixture(t);
  const result = await runBackup({ ...f.settings, transport: 'container' }, f.adapters);
  assert.equal(result.ok, false);
  assert.match(result.stages.preparation.errors[0].detail, /fixed worker installation/u);
  assert.equal(result.detail, 'Preparation: failed. Check the backup worker configuration and saved locks before retrying.');
  assert.ok(result.detail.split(/\s+/u).length <= 18);
  assert.doesNotMatch(result.detail, /worker installation|credential|SQL|\/state/u);
});

async function assetFixture(f, { script = 'node export.mjs', asset = 'example.com' } = {}) {
  const repo = path.join(f.repoRoot, asset);
  const exports = path.join(repo, 'backups');
  const source = { asset, repo: asset, args: ['--skip-confirmation'],
    scriptSha256: createHash('sha256').update(script).digest('hex') };
  await f.write(path.join(repo, 'package.json'), JSON.stringify({ scripts: {
    'backup:prod': script,
    'prebackup:prod': 'node forbidden-hook.mjs',
    'postbackup:prod': 'node forbidden-hook.mjs',
  } }));
  await f.write(path.join(repo, 'forbidden-hook.mjs'), 'process.exit(99)');
  await f.write(path.join(repo, 'export.mjs'), `
    import fs from 'node:fs';
    fs.writeFileSync(process.env.BACKUP_OUTPUT_DIR + '/new.sql', 'CREATE TABLE sample (id INTEGER); INSERT INTO sample VALUES (42);');
  `);
  await f.write(path.join(exports, 'manual.sql'), 'keep existing manual exports');
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({
    assetBackups: [source], retention: { daily: 2, weekly: 2 },
  }));
  return { repo, exports, source };
}

async function previousSets(f, dates) {
  for (const base of [f.backupRoot, f.offsite]) {
    for (const date of dates) await f.write(path.join(base, date, 'backup.json'), JSON.stringify({
      format: 'noticeos-backup-v1', complete: true,
    }));
  }
}

async function historyFixture(f, retention = { daily: 1, weekly: 1 }) {
  const history = await heldHistory(path.join(f.repoRoot, 'installation'));
  const file = path.join(f.repoRoot, 'installation/host-backup.json');
  const setting = value => f.write(file, JSON.stringify({ analyticalHistoryDirectory: value, ...(retention ? { retention } : {}) }));
  await setting(history.relative);
  return { history, setting };
}

test('the shared pipeline publishes restorable held tables in local and offsite custody', async t => {
  const f = await fixture(t);
  const { history } = await historyFixture(f);
  const result = await f.run();
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.stages.history.copied, 1);
  assert.equal(result.stages.offsite.status, 'completed');
  const local = JSON.parse(await fs.readFile(path.join(f.destination, 'backup.json'), 'utf8'));
  await fs.rm(history.output, { recursive: true });
  for (const base of [f.destination, path.join(f.offsite, DAY)]) {
    const directory = path.join(base, 'history');
    assert.deepEqual(await verifyAnalyticalHistoryBackup(directory), local.analyticalHistory);
    const manifest = await readCurrentGeneration(directory);
    assert.deepEqual(await heldRows(directory, manifest), history.rows);
    assert.deepEqual(await heldRows(directory, manifest, 'insight_snapshots'), history.insightRows);
    assert.match(await fs.readFile(path.join(base, 'RESTORE.md'), 'utf8'), /Analytical history: completed; 1\/1 copied/u);
  }
});

for (const failure of ['missing', 'unsafe', 'damaged', 'incomplete']) test(`${failure} configured history blocks publication and preserves the prior good set`, async t => {
  const f = await fixture(t);
  const { history, setting } = await historyFixture(f);
  assert.equal((await f.run()).ok, true);
  const before = await fs.readFile(path.join(f.destination, 'history/custody.json'), 'utf8');
  if (failure === 'missing') await setting('missing');
  if (failure === 'unsafe') await setting('../outside');
  if (failure === 'damaged') await fs.writeFile(path.join(history.output, history.files[0].path), 'damaged');
  if (failure === 'incomplete') await fs.writeFile(path.join(history.output, 'generations/00000002.json'), '{"format":"incomplete"}');
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.stages.history.status, 'failed');
  assert.equal(result.stages.publication.status, 'blocked');
  assert.equal(result.stages.retention.status, 'blocked');
  assert.equal(result.backupSet.complete, false);
  assert.equal(backupRunOutcome(result).outcome, 'failed');
  for (const base of [f.destination, path.join(f.offsite, DAY)]) {
    assert.equal(await fs.readFile(path.join(base, 'history/custody.json'), 'utf8'), before);
    await verifyAnalyticalHistoryBackup(path.join(base, 'history'));
  }
});

test('same-day history disable cannot replace the only held-table custody', async t => {
  const f = await fixture(t);
  const { setting } = await historyFixture(f);
  assert.equal((await f.run()).ok, true);
  await setting(null);
  const result = await f.run();
  assert.equal(result.stages.history.status, 'not_configured');
  assert.equal(result.stages.publication.status, 'failed');
  assert.equal(result.backupSet.complete, false);
  for (const base of [f.destination, path.join(f.offsite, DAY)]) await verifyAnalyticalHistoryBackup(path.join(base, 'history'));
});

for (const location of ['local', 'offsite']) for (const damage of ['incomplete', 'damaged']) {
  test(`interrupted ${location} publication preserves prior held custody when the target is ${damage}`, async t => {
    const f = await fixture(t);
    const { history } = await historyFixture(f);
    assert.equal((await f.run()).ok, true);
    const base = location === 'local' ? f.backupRoot : f.offsite;
    const target = path.join(base, DAY);
    const previous = path.join(base, `.backup-previous-${DAY}`);
    await fs.cp(target, previous, { recursive: true });
    const expected = await verifyAnalyticalHistoryBackup(path.join(previous, 'history'));
    if (damage === 'incomplete') await fs.rm(path.join(target, 'history'), { recursive: true });
    else await fs.writeFile(path.join(target, 'history', history.files[0].path), 'damaged replacement');
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.stages[location === 'local' ? 'preparation' : 'offsite'].status, 'failed');
    assert.deepEqual(await verifyAnalyticalHistoryBackup(path.join(previous, 'history')), expected);
    assert.deepEqual(await heldRows(path.join(previous, 'history'), await readCurrentGeneration(path.join(previous, 'history'))), history.rows);
  });
}

test('interrupted publication retires prior held custody only after the replacement verifies', async t => {
  const f = await fixture(t);
  await historyFixture(f);
  assert.equal((await f.run()).ok, true);
  for (const base of [f.backupRoot, f.offsite]) {
    await fs.cp(path.join(base, DAY), path.join(base, `.backup-previous-${DAY}`), { recursive: true });
  }
  assert.equal((await f.run()).ok, true);
  for (const base of [f.backupRoot, f.offsite]) {
    await absent(path.join(base, `.backup-previous-${DAY}`));
    await verifyAnalyticalHistoryBackup(path.join(base, DAY, 'history'));
  }
});

for (const policy of ['daily-weekly', 'age']) test(`${policy} rotation preserves held history after disable, then removes only redundant custody`, async t => {
  const f = await fixture(t);
  const { history, setting } = await historyFixture(f, policy === 'age' ? null : { daily: 1, weekly: 1 });
  assert.equal((await f.run()).ok, true);
  await setting(null);
  const next = await f.run({ now: () => Date.parse('2026-10-15T04:00:00Z') });
  assert.equal(next.ok, true, next.detail);
  for (const base of [f.backupRoot, f.offsite]) {
    await verifyAnalyticalHistoryBackup(path.join(base, DAY, 'history'));
    await fs.access(path.join(base, '2026-10-15/backup.json'));
  }
  await setting(history.relative);
  const replaced = await f.run({ now: () => Date.parse('2026-11-16T04:00:00Z') });
  assert.equal(replaced.ok, true, replaced.detail);
  for (const base of [f.backupRoot, f.offsite]) {
    await absent(path.join(base, DAY));
    await verifyAnalyticalHistoryBackup(path.join(base, '2026-11-16/history'));
  }
});

test('a smaller published history closure cannot rotate away older held rows', async t => {
  const f = await fixture(t);
  const { history } = await historyFixture(f);
  assert.equal((await f.run()).ok, true);
  await fs.unlink(path.join(history.output, 'generations/00000002.json'));
  const result = await f.run({ now: () => Date.parse('2026-10-15T04:00:00Z') });
  assert.equal(result.ok, true, result.detail);
  await fs.rm(history.output, { recursive: true });
  for (const base of [f.backupRoot, f.offsite]) {
    const retained = path.join(base, DAY, 'history');
    await verifyAnalyticalHistoryBackup(retained);
    assert.deepEqual(await heldRows(retained, await readCurrentGeneration(retained)), history.rows);
    assert.equal((await verifyAnalyticalHistoryBackup(path.join(base, '2026-10-15/history'))).heldFiles.length, 2);
  }
});

test('offsite history byte mismatch preserves the prior handoff and blocks all rotation despite a complete local copy', async t => {
  const f = await fixture(t);
  const { history } = await historyFixture(f);
  assert.equal((await f.run()).ok, true);
  await previousSets(f, ['2026-08-01']);
  const result = await f.run({ fs: { ...fs, cp: async (from, to, ...options) => {
    await fs.cp(from, to, ...options);
    if (path.dirname(to) === f.offsite) await fs.writeFile(path.join(to, 'history', history.files[0].path), 'damaged handoff');
  } } });
  assert.equal(result.backupSet.complete, true, 'Local publication can succeed before the failed handoff');
  assert.equal(result.stages.history.status, 'completed');
  assert.equal(result.stages.offsite.status, 'failed');
  assert.equal(result.stages.retention.status, 'blocked');
  assert.equal(result.ok, false);
  assert.equal(backupRunOutcome(result).outcome, 'failed');
  await verifyAnalyticalHistoryBackup(path.join(f.offsite, DAY, 'history'));
  for (const base of [f.backupRoot, f.offsite]) await fs.access(path.join(base, '2026-08-01/backup.json'));
});

test('a real scratch npm task produces restorable gzip in both sets and removes only fresh SQL', async (t) => {
  const f = await fixture(t);
  const asset = await assetFixture(f);
  const calls = [];
  const result = await f.run({ spawn: (binary, args, options) => {
    if (binary !== 'npm') return f.fakeSpawn(binary, args, options);
    calls.push({ args, options });
    return spawn(binary, args, options);
  } });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.stages.assets.copied, 1);
  assert.deepEqual(calls[0].args, ['--ignore-scripts', 'run', 'backup:prod', '--', '--skip-confirmation']);
  assert.equal(calls[0].options.cwd, await fs.realpath(asset.repo));
  for (const base of [f.destination, path.join(f.offsite, DAY)]) {
    const sql = gunzipSync(await fs.readFile(path.join(base, 'assets/example.com/new.sql.gz'))).toString();
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(sql);
      assert.equal(db.prepare('SELECT id FROM sample').get().id, 42);
    } finally { db.close(); }
    await absent(path.join(base, 'assets/example.com/new.sql'));
  }
  assert.deepEqual(await fs.readdir(asset.exports), ['manual.sql']);
});

for (const scenario of ['failed', 'empty', 'missing', 'changed-task', 'compression-failed']) {
  test(`asset ${scenario} cannot report success, publish bad SQL, or prune earlier copies`, async (t) => {
    const f = await fixture(t);
    const asset = await assetFixture(f);
    await previousSets(f, ['2026-08-01', '2026-09-07']);
    if (scenario === 'changed-task') await f.write(path.join(asset.repo, 'package.json'), JSON.stringify({
      scripts: { 'backup:prod': 'node unapproved.mjs' },
    }));
    let invoked = 0;
    const result = await f.run({
      fs: { ...fs, open: (file, ...args) => {
        if (scenario === 'compression-failed' && String(file).endsWith('.gz')) throw new Error('Disk full');
        return fs.open(file, ...args);
      } },
      spawn: (binary, args, options) => {
        if (binary !== 'npm') return f.fakeSpawn(binary, args, options);
        invoked += 1;
        const child = new EventEmitter();
        queueMicrotask(async () => {
          if (scenario !== 'missing') await f.write(path.join(options.env.BACKUP_OUTPUT_DIR, 'new.sql'), scenario === 'empty' ? '' : 'SQL');
          child.emit('close', scenario === 'failed' ? 1 : 0, null);
        });
        return child;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stages.assets.status, 'failed');
    assert.equal(result.stages.retention.status, 'blocked');
    assert.equal(result.stages.taskHub.status, 'completed');
    assert.equal(invoked, scenario === 'changed-task' ? 0 : 1);
    assert.deepEqual(await fs.readdir(asset.exports), ['manual.sql']);
    for (const base of [f.backupRoot, f.offsite]) {
      await absent(path.join(base, DAY, 'assets/example.com'));
      assert.ok((await fs.readdir(base)).includes('2026-08-01'));
    }
  });
}

test('asset exports cannot use symlinks to pull a manual SQL file into the set', async (t) => {
  const f = await fixture(t);
  const asset = await assetFixture(f);
  const result = await f.run({ spawn: (binary, args, options) => {
    if (binary !== 'npm') return f.fakeSpawn(binary, args, options);
    const child = new EventEmitter();
    queueMicrotask(async () => {
      await fs.symlink(path.join(asset.exports, 'manual.sql'), path.join(options.env.BACKUP_OUTPUT_DIR, 'new.sql'));
      child.emit('close', 0, null);
    });
    return child;
  } });
  assert.equal(result.stages.assets.status, 'failed');
  assert.match(result.stages.assets.errors[0].detail, /regular SQL file/);
  assert.equal(await fs.readFile(path.join(asset.exports, 'manual.sql'), 'utf8'), 'keep existing manual exports');
});

test('a failed asset does not skip the next, and a concurrent manual export is untouched', async (t) => {
  const f = await fixture(t);
  const first = await assetFixture(f);
  const second = await assetFixture(f, { asset: 'second.example.com' });
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ assetBackups: [first.source, second.source] }));
  const result = await f.run({ spawn: (binary, args, options) => {
    if (binary !== 'npm') return f.fakeSpawn(binary, args, options);
    const child = new EventEmitter();
    queueMicrotask(async () => {
      await f.write(path.join(options.cwd, 'backups', 'concurrent.sql'), 'manual export');
      await f.write(path.join(options.env.BACKUP_OUTPUT_DIR, 'new.sql'), 'new SQL with different contents');
      child.emit('close', options.cwd.endsWith('/example.com') ? 1 : 0, null);
    });
    return child;
  } });
  assert.equal(result.ok, false);
  assert.equal(result.stages.assets.expected, 2);
  assert.equal(result.stages.assets.copied, 1);
  assert.equal(await fs.readFile(path.join(first.exports, 'manual.sql'), 'utf8'), 'keep existing manual exports');
  for (const asset of [first, second]) assert.equal(await fs.readFile(path.join(asset.exports, 'concurrent.sql'), 'utf8'), 'manual export');
  assert.deepEqual(result.backupSet, { path: null, complete: false });
  assert.equal(result.stages.publication.status, 'blocked');
  await absent(f.destination);
  await absent(path.join(f.offsite, DAY));
});

test('an asset timeout terminates its command and removes partial raw output', async (t) => {
  const f = await fixture(t);
  const asset = await assetFixture(f);
  let killed = false;
  const result = await f.run({ commandTimeoutMs: 30, spawn: (binary, args, options) => {
    if (binary !== 'npm') return f.fakeSpawn(binary, args, options);
    const child = new EventEmitter();
    const created = f.write(path.join(options.env.BACKUP_OUTPUT_DIR, 'partial.sql'), 'unfinished');
    child.kill = (signal) => {
      killed = signal === 'SIGKILL';
      created.then(() => child.emit('close', null, signal));
    };
    return child;
  } });
  assert.equal(killed, true);
  assert.equal(result.stages.assets.status, 'failed');
  assert.match(result.stages.assets.errors[0].detail, /timed out/);
  assert.deepEqual(await fs.readdir(asset.exports), ['manual.sql']);
});

test('daily and weekly rotation applies to all stores in both roots, preserving unrecognized folders', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ retention: { daily: 2, weekly: 2 } }));
  await previousSets(f, ['2026-08-31', '2026-09-01', '2026-09-07', '2026-09-08', '2026-09-12', '2026-09-13']);
  for (const base of [f.backupRoot, f.offsite]) {
    await f.write(path.join(base, '2026-09-06', 'RESTORE.md'), '# NoticeOS backup — 2026-09-06\nCreated by `scripts/host-backup.mjs`\n## Backup set\n- D1: completed; 1/1 copied\n- R2: completed; 1/1 copied\n- Task hub: completed; 1/1 copied\n');
    await f.write(path.join(base, '2026-01-01', 'manual-copy'));
    await f.write(path.join(base, '2026-02-31', 'backup.json'), JSON.stringify({ format: 'noticeos-backup-v1', complete: true }));
    await f.write(path.join(base, 'pre-migration', 'manual-copy'));
    await f.write(path.join(base, '2026-09-11', 'backup.json'), JSON.stringify({ format: 'noticeos-backup-v1', complete: false }));
  }
  const result = await f.run();
  assert.equal(result.ok, true, result.detail);
  for (const base of [f.backupRoot, f.offsite]) assert.deepEqual((await fs.readdir(base)).sort(), [
    '2026-01-01', '2026-02-31', '2026-09-07', '2026-09-13', DAY, 'pre-migration',
  ]);
});

test('failed handoff blocks rotation of local and offsite older sets', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ retention: { daily: 2, weekly: 2 } }));
  await previousSets(f, ['2026-08-01', '2026-08-10', '2026-09-07']);
  const result = await f.run({ fs: { ...fs, cp: async () => { throw new Error('Sync folder unavailable'); } } });
  assert.equal(result.stages.retention.status, 'blocked');
  for (const base of [f.backupRoot, f.offsite]) assert.ok((await fs.readdir(base)).includes('2026-08-01'));
});

test('rotation includes both earlier generated formats and keeps the week-old complete copy', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ retention: { daily: 2, weekly: 2 } }));
  await previousSets(f, ['2026-09-24', '2026-09-28', '2026-09-29']);
  for (const base of [f.backupRoot, f.offsite]) {
    await f.write(path.join(base, '2026-09-01', 'RESTORE.md'), '# ReindexOS backup — 2026-09-01\nWritten by `scripts/os-up.mjs`\n## This run\n- D1: 3/3 database(s)\n- R2: 2/2 database(s) + 7495 blob(s)\n- task hub: 7/7 database(s)\n');
    await f.write(path.join(base, '2026-09-23', 'RESTORE.md'), '# ReindexOS backup — 2026-09-23\nCreated by `scripts/host-backup.mjs`\n## Backup set\n- D1: completed; 3/3 copied\n- R2: completed; 12404/12404 copied\n- Task hub: completed; 7/7 copied\n');
    await f.write(path.join(base, '2026-09-22', 'RESTORE.md'), '# ReindexOS backup — 2026-09-22\nCreated by `scripts/host-backup.mjs`\n## Backup set\n- D1: completed; 3/3 copied\n- R2: failed; 11605/11606 copied\n- Task hub: completed; 7/7 copied\n');
    await f.write(path.join(base, '2026-09-21', 'RESTORE.md'), 'Unrelated manual backup');
  }
  const result = await f.run({ now: () => Date.parse('2026-09-30T04:00:00Z') });
  assert.equal(result.ok, true, result.detail);
  for (const base of [f.backupRoot, f.offsite]) assert.deepEqual((await fs.readdir(base)).sort(), [
    '2026-09-21', '2026-09-23', '2026-09-28', '2026-09-29', '2026-09-30',
  ]);
});

test('count-only history stays until an explicitly complete week-old set exists', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ retention: { daily: 2, weekly: 2 } }));
  for (const base of [f.backupRoot, f.offsite]) {
    await f.write(path.join(base, '2026-09-01', 'RESTORE.md'), '# ReindexOS backup — 2026-09-01\nWritten by `scripts/os-up.mjs`\n## This run\n- D1: 3/3 database(s)\n- R2: 2/2 database(s) + 7495 blob(s)\n- task hub: 7/7 database(s)\n');
  }
  assert.equal((await f.run()).ok, true);
  for (const base of [f.backupRoot, f.offsite]) assert.ok((await fs.readdir(base)).includes('2026-09-01'));
  assert.equal((await f.run({ now: () => Date.parse('2026-09-21T04:00:00Z') })).ok, true);
  for (const base of [f.backupRoot, f.offsite]) assert.deepEqual((await fs.readdir(base)).sort(), [DAY, '2026-09-21']);
});

test('invalid retention fails closed rather than falling back to destructive age pruning', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ retention: { daily: 0, weekly: 2 } }));
  await previousSets(f, ['2026-08-01']);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.stages.retention.status, 'failed');
  for (const base of [f.backupRoot, f.offsite]) assert.ok((await fs.readdir(base)).includes('2026-08-01'));
});

/** Real sqlite3 for SQLite snapshots; the controlled fake for task-hub commands. */
function realSqlite(f) {
  return (binary, args, options) =>
    binary === 'sqlite3' ? spawn(binary, args, options) : f.fakeSpawn(binary, args, options);
}

async function recordedRun(f, adapters) {
  const file = path.join(f.repoRoot, 'job-runs.jsonl');
  const trace = createWorkflowRecorder({ now: () => NOW });
  const result = await runJobLane('backup', () => trace.run('execute', () => f.run(adapters)), backupRunOutcome, {
    file, now: () => NOW, emit: () => {}, ship: async () => {},
  });
  const record = JSON.parse((await fs.readFile(file, 'utf8')).trim());
  const output = trace.steps[0].output;
  assert.ok(isWorkflowStepOutput(output));
  assert.equal(output.items.length, Object.keys(result.stages).length);
  for (const [id, stage] of Object.entries(result.stages)) {
    const item = output.items.find((entry) => entry.label === id);
    assert.equal(item.state, stage.status === 'completed' ? 'succeeded'
      : stage.status === 'not_configured' ? 'skipped' : 'failed');
    const attempted = item.fields.find((field) => field.key === 'attempted');
    if (stage.expected === null) assert.equal(attempted, undefined);
    else assert.equal(attempted.value, stage.expected);
  }
  return { result, record, output };
}

test('a complete operation copies all physical stores, instructions and handoff, and records success', async (t) => {
  const f = await fixture(t);
  // Physical inventory still covers a database absent from saved membership.
  await f.write(path.join(f.repoRoot, 'config/beads.json'), JSON.stringify({ spokes: [] }));
  const { result, record } = await recordedRun(f);
  assert.equal(result.ok, true);
  assert.equal(record.outcome, 'ran');
  assert.deepEqual(result.backupSet, { path: f.destination, complete: true });
  assert.equal(result.stages.postgres.copied, 1);
  assert.equal(result.stages.r2.copied, 2);
  assert.equal(result.stages.taskHub.copied, 2);
  assert.deepEqual(f.calls.filter((call) => call.database).map((call) => call.database), ['ro', 'mp']);
  assert.equal(await fs.readFile(path.join(f.destination, 'r2/blobs/archive'), 'utf8'), 'raw archive');
  assert.equal((await fs.stat(path.join(f.destination, 'postgres/noticeos.dump'))).mode & 0o777, 0o600);
  await absent(path.join(f.destination, 'central.sqlite'));
  await absent(path.join(f.destination, 'r2/metadata.sqlite-shm'));
  const readme = await fs.readFile(path.join(f.destination, 'RESTORE.md'), 'utf8');
  assert.match(readme, /# NoticeOS backup — 2026-09-14/);
  assert.match(readme, /Postgres: completed; 1\/1 copied/);
  assert.match(readme, /pruned after 30 days/);
  assert.match(readme, /Never restore over a RUNNING system/);
  assert.match(readme, /dolt backup restore/);
  assert.match(readme, /does not establish restore verification/);
  assert.match(readme, /does not establish completed remote synchronization/);
  assert.equal(await fs.readFile(path.join(f.offsite, DAY, 'RESTORE.md'), 'utf8'), readme);
  assert.equal((await fs.stat(path.join(f.offsite, DAY, 'postgres/noticeos.dump'))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(f.backupRoot), [DAY]);
  assert.deepEqual(await fs.readdir(f.offsite), [DAY]);
});

async function composeHubFixture(f, { failure, doltHome = f.repoRoot } = {}) {
  const home = path.join(doltHome, 'dolt');
  const profile = {
    project: 'noticeos-start-0123456789abcdef',
    composeFile: path.join(home, 'compose.yaml'),
    secretsDir: path.join(home, 'secrets'),
    credentialsFile: path.join(home, 'credentials'), port: 19450,
  };
  await f.write(path.join(home, 'profile.json'), JSON.stringify(profile));
  const password = 'a'.repeat(64);
  for (const [file, contents] of [
    [path.join(profile.secretsDir, 'root'), `${'b'.repeat(64)}\n`],
    [path.join(profile.secretsDir, 'noticeos'), `${password}\n`],
    [profile.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${password}\n`],
  ]) {
    await f.write(file, contents);
    await fs.chmod(file, 0o600);
  }
  const calls = [];
  let stage;
  const runDolt = async (binary, args, options) => {
    assert.equal(binary, 'docker');
    calls.push({ args, options });
    if (args[0] === 'context') return { code: 0, stdout: 'unix:///synthetic/docker.sock', stderr: '' };
    assert.deepEqual(args.slice(0, 7), ['compose', '-p', profile.project, '-f', profile.composeFile, '--env-file', '/dev/null']);
    assert.equal(options.env.DOCKER_HOST, 'unix:///synthetic/docker.sock');
    assert.equal(options.env.BEADS_CREDENTIALS_FILE, profile.credentialsFile);
    assert.equal(options.env.BEADS_DOLT_PASSWORD, undefined);
    assert.equal(options.env.MYSQL_PWD, undefined);
    const command = args.slice(7);
    if (command[0] === 'exec' && command.includes('/etc/noticeos/capture.sh')) {
      stage = command[5];
      assert.match(stage, /^\/tmp\/noticeos-backup-[a-f0-9]{32}$/u);
      assert.deepEqual(command.slice(6), ['ro', 'mp']);
      if (failure === 'capture') return { code: 1, stdout: '', stderr: password };
    } else if (command[0] === 'cp') {
      assert.equal(command[1], `dolt:${stage}/.`);
      const output = command[2];
      for (const database of ['ro', 'mp']) {
        await f.write(path.join(output, 'databases', database, 'manifest'), `snapshot ${database}`);
        await f.write(path.join(output, 'status', `${database}.json`), JSON.stringify({ rows: [{ status: failure === 'status' ? 1 : 0 }] }));
        for (const name of ['config.json', 'repo_state.json']) {
          await f.write(path.join(output, 'metadata', 'databases', database, `${name}.absent`), '');
        }
      }
      if (failure !== 'metadata') await f.write(path.join(output, 'metadata', 'privileges.db'), 'synthetic permissions');
      for (const name of ['branch_control.db', 'server-config.json', 'global-config.json']) {
        await f.write(path.join(output, 'metadata', `${name}.absent`), '');
      }
      if (failure === 'copy') return { code: 1, stdout: '', stderr: password };
    } else {
      assert.deepEqual(command, ['exec', '--no-TTY', 'dolt', 'rm', '-rf', '--', stage]);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { profile, calls, runDolt, password };
}

test('an explicit independent Dolt home owns capture; absence cannot select the legacy hub', async t => {
  const f = await fixture(t);
  const doltHome = path.join(f.repoRoot, 'independent-task-home');
  const hub = await composeHubFixture(f, { doltHome });
  const result = await runBackup({ ...f.settings, doltHome }, { ...f.adapters, runDolt: hub.runDolt });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.stages.taskHub.copied, 2);
  assert.equal(f.calls.some(call => call.database), false);
  await fs.rm(path.join(doltHome, 'dolt/profile.json'));
  f.calls.length = 0;
  const failed = await runBackup({ ...f.settings, doltHome }, f.adapters);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /legacy capture was refused/u);
  assert.equal(f.calls.some(call => call.database), false);
  assert.equal(failed.stages.publication.status, 'blocked');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, 'backup.json'), 'utf8')).complete, true);
});

test('Compose task backups publish online snapshots and private recovery metadata in both complete sets', async (t) => {
  const f = await fixture(t);
  const hub = await composeHubFixture(f);
  const result = await f.run({ runDolt: hub.runDolt, env: {
    ...f.adapters.env, BEADS_DOLT_PASSWORD: 'inherited-secret', MYSQL_PWD: 'wrong-server-secret',
  } });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.stages.taskHub.expected, 2);
  assert.equal(result.stages.taskHub.copied, 2);
  assert.equal(f.calls.some(call => call.database), false, 'no host bd fallback');
  for (const base of [f.destination, path.join(f.offsite, DAY)]) {
    const root = path.join(base, 'beads');
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'backup.json'), 'utf8'));
    assert.equal(manifest.complete, true);
    assert.deepEqual(manifest.databases, ['ro', 'mp']);
    const relative = 'metadata/secrets/noticeos';
    assert.equal(manifest.files[relative].sha256, createHash('sha256').update(`${hub.password}\n`).digest('hex'));
    assert.equal((await fs.stat(path.join(root, relative))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(root, 'metadata/beads-credentials'))).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(path.join(root, 'databases/mp/manifest'), 'utf8'), 'snapshot mp');
    const instructions = await fs.readFile(path.join(base, 'RESTORE.md'), 'utf8');
    assert.match(instructions, /db\/dolt\/host\/README.md/);
    assert.match(instructions, /not one transaction across all projects/);
    assert.doesNotMatch(instructions, /dolt backup restore file/);
  }
  assert.equal(JSON.stringify(result).includes(hub.password), false);
});

for (const failure of ['capture', 'copy', 'status', 'metadata']) {
  test(`Compose task ${failure} failure blocks publication and preserves earlier complete backups`, async (t) => {
    const f = await fixture(t);
    const hub = await composeHubFixture(f, { failure });
    await previousSets(f, ['2026-08-01']);
    const result = await f.run({ runDolt: hub.runDolt });
    assert.equal(result.ok, false);
    assert.equal(result.stages.taskHub.status, 'failed');
    assert.equal(result.stages.taskHub.copied, 0);
    assert.equal(result.stages.publication.status, 'blocked');
    assert.equal(result.stages.retention.status, 'blocked');
    assert.equal(JSON.stringify(result).includes(hub.password), false);
    assert.equal(f.calls.some(call => call.database), false);
    for (const base of [f.backupRoot, f.offsite]) {
      await absent(path.join(base, DAY));
      assert.deepEqual(await fs.readdir(base), ['2026-08-01']);
    }
    assert.ok(hub.calls.at(-1).args.includes(stageArgument(hub.calls)), 'only the invocation staging directory is cleaned');
  });
}

function stageArgument(calls) {
  return calls.find(call => call.args.includes('/etc/noticeos/capture.sh')).args.at(-3);
}

test('a malformed Compose profile fails closed without falling back to the host hub', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.repoRoot, 'dolt/profile.json'), '{broken');
  const result = await f.run({ runDolt: () => assert.fail('malformed profile cannot select Docker') });
  assert.equal(result.stages.taskHub.status, 'failed');
  assert.equal(result.stages.publication.status, 'blocked');
  assert.equal(f.calls.some(call => call.database), false);
});

test('a declared Compose task hub with no inventory fails even in linked-installation mode', async (t) => {
  const f = await fixture(t);
  await composeHubFixture(f);
  await f.host([]);
  const result = await runBackup({ ...f.settings, taskHub: 'linked' }, {
    ...f.adapters, runDolt: () => assert.fail('no invented database inventory'),
  });
  assert.equal(result.stages.taskHub.status, 'failed');
  assert.equal(result.stages.publication.status, 'blocked');
});

for (const store of ['postgres', 'r2', 'taskHub']) {
  test(`${store} inventory unavailable records failure and still copies other stores`, async (t) => {
    const f = await fixture(t);
    await fs.rm(store === 'taskHub' ? f.hostFile : f[store], { recursive: true });
    const { result, record } = await recordedRun(f);
    assert.equal(result.ok, false);
    assert.equal(record.outcome, 'failed');
    assert.equal(result.stages[store].status, 'failed');
    assert.equal(result.stages[store].expected, store === 'postgres' ? 1 : null);
    for (const other of ['postgres', 'r2', 'taskHub'].filter((key) => key !== store)) {
      assert.equal(result.stages[other].status, 'completed');
    }
    assert.deepEqual(result.backupSet, { path: null, complete: false });
    assert.equal(result.stages.offsite.status, 'blocked');
    await absent(f.destination);
  });
}

test('failed Postgres and hub copies block publication while later databases still copy', async (t) => {
  const f = await fixture(t);
  f.control.fail = ({ binary, database }) => binary === 'docker' || database === 'ro';
  const { result, record } = await recordedRun(f);
  assert.equal(record.outcome, 'failed');
  assert.equal(result.stages.postgres.copied, 0);
  assert.equal(result.stages.postgres.expected, 1);
  assert.equal(result.stages.taskHub.copied, 1);
  assert.equal(result.stages.taskHub.expected, 2);
  assert.deepEqual(result.backupSet, { path: null, complete: false });
  await absent(f.destination);
  assert.deepEqual(await fs.readdir(f.backupRoot), []);
});

test('a partial R2 blob copy is counted, removed and reported through the job record', async (t) => {
  const f = await fixture(t);
  const { result, record } = await recordedRun(f, { fs: { ...fs, copyFile: async (source, output) => {
    await fs.copyFile(source, output);
    throw new Error('Interrupted blob copy');
  } } });
  assert.equal(result.stages.r2.copied, 1);
  assert.equal(result.stages.r2.expected, 2);
  assert.equal(result.stages.r2.status, 'failed');
  assert.equal(result.stages.taskHub.status, 'completed');
  assert.equal(record.outcome, 'failed');
  assert.match(record.detail, /R2: failed/);
  await absent(path.join(f.destination, 'r2/blobs/archive'));
});

test('R2 metadata failure is a failed run even when every blob copies', async (t) => {
  const f = await fixture(t);
  f.control.fail = ({ source }) => source?.endsWith('metadata.sqlite');
  const { result, record } = await recordedRun(f);
  assert.equal(record.outcome, 'failed');
  assert.equal(result.stages.r2.copied, 1);
  await absent(path.join(f.destination, 'r2/metadata.sqlite'));
  await absent(f.destination);
});

test('missing Postgres/hub inventories fail; a readable empty R2 store is a valid empty store', async (t) => {
  const f = await fixture(t);
  await fs.rm(f.profileFile);
  await fs.rm(f.r2, { recursive: true });
  await fs.mkdir(f.r2);
  await f.host([]);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.stages.postgres.status, 'failed');
  assert.equal(result.stages.taskHub.status, 'failed');
  assert.equal(result.stages.r2.status, 'completed');
  assert.equal(result.stages.r2.expected, 0);
});

test('an installation pnpm start runs backs up only the task databases it links, each through its own checkout', async (t) => {
  // bead ro-ujb9.174: linking none is not configured, not a failed set.
  const f = await fixture(t);
  for (const inventory of ['empty', 'absent']) {
    if (inventory === 'empty') await f.host([]);
    else await fs.rm(f.hostFile);
    const none = await runBackup({ ...f.settings, taskHub: 'linked' }, f.adapters);
    assert.equal(none.ok, true, inventory);
    assert.equal(none.stages.taskHub.status, 'not_configured', inventory);
    assert.deepEqual(none.backupSet, { path: f.destination, complete: true });
  }
  assert.equal(f.calls.some((call) => call.database), false);

  await f.host([{ database: 'shop', repo: '../shop.example' }, { database: 'shop', repo: '../other.example' }]);
  const checkouts = [];
  const linked = await runBackup({ ...f.settings, taskHub: 'linked' }, { ...f.adapters, spawn: (binary, args, options) => {
    if (binary === '/controlled/bd') {
      checkouts.push(args[1]);
      return f.fakeSpawn(binary, ['-C', f.repoRoot, ...args.slice(2)], options);
    }
    return f.fakeSpawn(binary, args, options);
  } });
  assert.equal(linked.ok, true);
  assert.equal(linked.stages.taskHub.status, 'completed');
  assert.deepEqual(checkouts, [path.resolve(f.repoRoot, '../shop.example')], 'one copy per database, through its first linked checkout');
});

test('malformed task inventory fails only that store', async (t) => {
  const f = await fixture(t);
  await f.write(f.hostFile, '{broken');
  const result = await f.run();
  assert.equal(result.stages.taskHub.status, 'failed');
  assert.equal(result.stages.postgres.status, 'completed');
  assert.equal(result.stages.r2.status, 'completed');
});

test('invalid task names fail the inventory while valid deduplicated names are still copied', async (t) => {
  const f = await fixture(t);
  await f.host([{ database: ' ro ' }, { database: 'ro' }, { database: 'bad;name' }, { database: 'mp' }]);
  const result = await f.run();
  assert.equal(result.stages.taskHub.status, 'failed');
  assert.equal(result.stages.taskHub.expected, 3);
  assert.equal(result.stages.taskHub.copied, 2);
  assert.deepEqual(f.calls.filter((call) => call.database).map((call) => call.database), ['ro', 'mp']);
});

test('an unconfigured offsite handoff is explicit and optional', async (t) => {
  const f = await fixture(t);
  f.settings.offsiteBackupDir = null;
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.stages.offsite.status, 'not_configured');
  await absent(f.offsite);
});

// Bead ro-ujb9.120: the offsite folder is THIS host's setting, read from its
// installation's host-backup.json at each run — never a path written into the
// runner. The runner passes no folder; these runs do the same.
test("the offsite folder is read from the installation's host-backup.json, in the real file shape", async (t) => {
  const f = await fixture(t);
  delete f.settings.offsiteBackupDir;
  // The product default names no folder; the installation's own copy wins.
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ offsiteBackupDir: null }, null, 2));
  await f.write(
    path.join(f.repoRoot, 'installation/host-backup.json'),
    `${JSON.stringify({ offsiteBackupDir: f.offsite }, null, 2)}\n`,
  );
  assert.equal(hostBackupFile(f.repoRoot), path.join(f.repoRoot, 'installation', 'host-backup.json'));
  assert.equal(await readOffsiteBackupDir({ repoRoot: f.repoRoot }), f.offsite);
  const { result, record } = await recordedRun(f);
  assert.equal(result.ok, true);
  assert.equal(record.outcome, 'ran');
  assert.equal(result.stages.offsite.status, 'completed');
  assert.equal(
    await fs.readFile(path.join(f.offsite, DAY, 'RESTORE.md'), 'utf8'),
    await fs.readFile(path.join(f.destination, 'RESTORE.md'), 'utf8'),
  );
});

test("a fresh clone's default takes no offsite copy, and says so", async (t) => {
  const f = await fixture(t);
  delete f.settings.offsiteBackupDir;
  await f.write(path.join(f.repoRoot, 'config/host-backup.json'), JSON.stringify({ offsiteBackupDir: null }, null, 2));
  assert.equal(hostBackupFile(f.repoRoot), path.join(f.repoRoot, 'config', 'host-backup.json'));
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.stages.offsite.status, 'not_configured');
  assert.match(result.detail, /Offsite handoff: not_configured/);
  await absent(f.offsite);
  // No file at all reads the same as the default.
  await fs.rm(path.join(f.repoRoot, 'config/host-backup.json'));
  assert.equal(await readOffsiteBackupDir({ repoRoot: f.repoRoot }), null);
});

test('an unreadable host-backup.json fails the handoff by name while local stores are still snapshotted', async (t) => {
  for (const [contents, why] of [
    ['{ "offsiteBackupDir": ', /installation\/host-backup\.json is not valid JSON/],
    [JSON.stringify({ offsiteBackupDir: 'Backups/relative' }), /offsiteBackupDir must be an absolute folder path/],
    [JSON.stringify({ offsiteBackupDir: 42 }), /offsiteBackupDir must be an absolute folder path/],
  ]) {
    const f = await fixture(t);
    delete f.settings.offsiteBackupDir;
    await f.write(path.join(f.repoRoot, 'installation/host-backup.json'), contents);
    const { result, record } = await recordedRun(f);
    assert.equal(result.stages.postgres.status, 'completed');
    assert.equal(result.stages.r2.status, 'completed');
    assert.equal(result.backupSet.path, result.stages.assets.status === 'failed' ? null : f.destination);
    assert.equal(result.backupSet.complete, result.stages.assets.status !== 'failed');
    assert.equal(result.stages.offsite.status, 'failed');
    assert.match(result.stages.offsite.errors[0].detail, why);
    assert.equal(result.ok, false);
    assert.equal(record.outcome, 'failed');
    assert.match(result.detail, /Offsite handoff: failed/);
    await absent(f.offsite);
  }
});

test('a missing configured sync parent fails the recorded run without creating a phantom tree', async (t) => {
  const f = await fixture(t);
  await fs.rm(f.syncParent, { recursive: true });
  const { result, record } = await recordedRun(f);
  assert.equal(result.backupSet.complete, true);
  assert.equal(result.stages.offsite.status, 'failed');
  assert.equal(record.outcome, 'failed');
  await absent(f.syncParent);
});

test('an interrupted offsite copy preserves the previous handoff and removes partial staging', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.offsite, DAY, 'previous'), 'previous handoff');
  const { result, record } = await recordedRun(f, { fs: { ...fs, cp: async (source, output) => {
    await fs.copyFile(path.join(source, 'postgres/noticeos.dump'), path.join(output, 'partial'));
    throw new Error('Interrupted handoff');
  } } });
  assert.equal(record.outcome, 'failed');
  assert.equal(result.stages.offsite.status, 'failed');
  assert.equal(await fs.readFile(path.join(f.offsite, DAY, 'previous'), 'utf8'), 'previous handoff');
  assert.deepEqual(await fs.readdir(f.offsite), [DAY]);
});

test('a failed same-day rerun retains both completed sets and cannot prune the last good copy', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).ok, true);
  const before = await fs.readFile(path.join(f.destination, 'RESTORE.md'));
  await f.write(path.join(f.destination, 'previous'), 'last completed set');
  await f.write(path.join(f.backupRoot, '2026-08-01', 'last-good'));
  await fs.rm(f.r2, { recursive: true });
  await f.host([{ database: 'mp' }]);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.backupSet, { path: null, complete: false });
  assert.equal(result.stages.retention.status, 'blocked');
  assert.equal(await fs.readFile(path.join(f.destination, 'previous'), 'utf8'), 'last completed set');
  for (const base of [f.destination, path.join(f.offsite, DAY)]) {
    assert.deepEqual(await fs.readFile(path.join(base, 'RESTORE.md')), before);
    await fs.access(path.join(base, 'r2/blobs/archive'));
    await fs.access(path.join(base, 'beads/ro/snapshot'));
  }
  await fs.access(path.join(f.backupRoot, '2026-08-01', 'last-good'));
});

test('a complete same-day rerun replaces the whole set without stale files', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).ok, true);
  await f.write(path.join(f.destination, 'stale'));
  await f.host([{ database: 'mp' }]);
  assert.equal((await f.run()).ok, true);
  for (const base of [f.destination, path.join(f.offsite, DAY)]) {
    await absent(path.join(base, 'stale'));
    await absent(path.join(base, 'beads/ro'));
    await fs.access(path.join(base, 'postgres/noticeos.dump'));
  }
});

test('an incomplete rerun preserves a complete offsite copy even when the local copy is missing', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).ok, true);
  await fs.rm(f.destination, { recursive: true });
  await fs.rm(f.r2, { recursive: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.backupSet.complete, false);
  assert.equal(result.stages.offsite.status, 'blocked');
  assert.equal(result.stages.retention.status, 'blocked');
  assert.match(await fs.readFile(path.join(f.offsite, DAY, 'RESTORE.md'), 'utf8'), /R2: completed/);
});

test('an overlapping run cannot copy, prune or hand off another run\'s set', async (t) => {
  const f = await fixture(t);
  let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const copying = new Promise((resolve) => { entered = resolve; });
  const first = f.run({ fs: { ...fs, cp: async (source, output, options) => {
    entered();
    await blocked;
    return fs.cp(source, output, options);
  } } });
  await copying;
  try {
    const calls = f.calls.length;
    const second = await f.run();
    assert.equal(second.ok, false);
    assert.equal(second.stages.preparation.status, 'failed');
    assert.match(second.detail, /Another backup holds the host claim/);
    assert.equal(second.stages.retention.status, 'blocked');
    assert.equal(second.stages.offsite.status, 'blocked');
    assert.equal(f.calls.length, calls);
  } finally { release(); }
  assert.equal((await first).ok, true);
  assert.deepEqual(await fs.readdir(f.backupRoot), [DAY]);
});

test('a run recovers a claim left by an exited process', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  const abandoned = path.join(f.backupRoot, `.backup-claim-${child.pid}-abandoned`);
  await fs.mkdir(abandoned, { recursive: true });
  await fs.writeFile(path.join(abandoned, 'owner.json'), JSON.stringify({ format: 'noticeos-backup-claim-v1', namespace: f.adapters.claimNamespace, pid: child.pid }), { mode: 0o600 });
  assert.equal((await f.run()).ok, true);
  await absent(abandoned);
});

test('a live claim from another process blocks manual-versus-runner overlap', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  const active = path.join(f.backupRoot, `.backup-claim-${child.pid}-active`);
  await fs.mkdir(active, { recursive: true });
  await fs.writeFile(path.join(active, 'owner.json'), JSON.stringify({ format: 'noticeos-backup-claim-v1', namespace: f.adapters.claimNamespace, pid: child.pid }), { mode: 0o600 });
  try {
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.stages.preparation.status, 'failed');
    assert.equal(result.stages.retention.status, 'blocked');
    assert.equal(f.calls.length, 0);
    assert.ok((await fs.stat(active)).isDirectory());
  } finally {
    child.stdin.end();
    await exited;
  }
  assert.equal((await f.run()).ok, true);
  await absent(active);
});

test('failed claim cleanup is reported and does not permanently block the same runner', async (t) => {
  const f = await fixture(t);
  const first = await f.run({ fs: { ...fs, rm: (file, options) => {
    if (path.basename(file).startsWith('.backup-claim-')) throw new Error('Claim cleanup unavailable');
    return fs.rm(file, options);
  } } });
  assert.equal(first.ok, false);
  assert.equal(first.stages.cleanup.status, 'failed');
  assert.equal((await f.run()).ok, true);
  assert.deepEqual(await fs.readdir(f.backupRoot), [DAY]);
});

test('failed local publication rolls back the previous dated set and never hands off old data as new', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.destination, 'previous'), 'previous set');
  const result = await f.run({ fs: { ...fs, rename: (source, target) => {
    if (target === f.destination && !path.basename(source).startsWith('.backup-previous-')) throw new Error('Cannot publish');
    return fs.rename(source, target);
  } } });
  assert.equal(result.ok, false);
  assert.equal(result.stages.publication.status, 'failed');
  assert.equal(result.stages.offsite.status, 'blocked');
  assert.equal(result.backupSet.path, null);
  assert.equal(await fs.readFile(path.join(f.destination, 'previous'), 'utf8'), 'previous set');
  assert.deepEqual(await fs.readdir(f.backupRoot), [DAY]);
  await absent(f.offsite);
});

test('a failed offsite replacement restores the previous dated handoff', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.offsite, DAY);
  await f.write(path.join(target, 'previous'), 'previous handoff');
  const result = await f.run({ fs: { ...fs, rename: (source, destination) => {
    if (destination === target && !path.basename(source).startsWith('.backup-previous-')) throw new Error('Cannot publish handoff');
    return fs.rename(source, destination);
  } } });
  assert.equal(result.ok, false);
  assert.equal(result.backupSet.complete, true);
  assert.equal(result.stages.offsite.status, 'failed');
  assert.equal(await fs.readFile(path.join(target, 'previous'), 'utf8'), 'previous handoff');
  assert.deepEqual(await fs.readdir(f.offsite), [DAY]);
});

test('a failed rollback retains the previous set and reports its recovery location', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.destination, 'previous'), 'previous set');
  const result = await f.run({ fs: { ...fs, rename: (source, target) => {
    if (target === f.destination) throw new Error('Destination unavailable');
    return fs.rename(source, target);
  } } });
  assert.equal(result.ok, false);
  assert.equal(result.stages.publication.status, 'failed');
  const [retained] = await fs.readdir(f.backupRoot);
  const recovery = path.join(f.backupRoot, retained);
  assert.equal(await fs.readFile(path.join(recovery, 'previous'), 'utf8'), 'previous set');
  assert.ok(result.stages.publication.errors[0].detail.includes(recovery));
});

test('an instruction write failure is recorded and cannot publish an unexplained set', async (t) => {
  const f = await fixture(t);
  const { result, record } = await recordedRun(f, { fs: { ...fs, writeFile: (file, ...args) => {
    if (file.endsWith('/RESTORE.md')) throw new Error('Cannot write restore instructions');
    return fs.writeFile(file, ...args);
  } } });
  assert.equal(record.outcome, 'failed');
  assert.equal(result.stages.taskHub.copied, 2);
  assert.equal(result.stages.instructions.status, 'failed');
  assert.equal(result.stages.publication.status, 'blocked');
  await absent(f.destination);
});

test('failed partial-file cleanup blocks publication but does not stop other stores', async (t) => {
  const f = await fixture(t);
  f.control.fail = ({ binary }) => binary === 'docker';
  const result = await f.run({ fs: { ...fs, rm: (file, options) => {
    if (file.endsWith('noticeos.dump')) throw new Error('Cannot remove partial file');
    return fs.rm(file, options);
  } } });
  assert.equal(result.ok, false);
  assert.equal(result.stages.postgres.failureCount, 2);
  assert.equal(result.stages.taskHub.status, 'completed');
  assert.equal(result.stages.publication.status, 'blocked');
  await absent(f.destination);
});

test('retention keeps its existing dated-directory cutoff in both destinations', async (t) => {
  const f = await fixture(t);
  for (const base of [f.backupRoot, f.offsite]) {
    for (const day of ['2026-08-14', '2026-08-16', 'not-a-date']) await f.write(path.join(base, day, 'copy'));
  }
  assert.equal((await f.run()).ok, true);
  for (const base of [f.backupRoot, f.offsite]) {
    assert.deepEqual((await fs.readdir(base)).sort(), ['2026-08-16', DAY, 'not-a-date']);
  }
});

test('retention errors are reported separately from complete copied data', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.backupRoot, '2026-08-01', 'copy'));
  const result = await f.run({ fs: { ...fs, rm: (file, options) => {
    if (file.endsWith('2026-08-01')) throw new Error('Cannot prune expired set');
    return fs.rm(file, options);
  } } });
  assert.equal(result.ok, false);
  assert.equal(result.backupSet.complete, true);
  assert.equal(result.stages.retention.status, 'failed');
  assert.equal(result.stages.offsite.status, 'completed');
});

for (const failure of ['spawnError', 'timeout']) {
  test(`${failure} fails every affected copy without hanging or abandoning other stores`, async (t) => {
    const f = await fixture(t);
    f.control[failure] = true;
    const result = await f.run({ commandTimeoutMs: 5 });
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 5);
    assert.equal(result.stages.postgres.status, 'failed');
    assert.equal(result.stages.r2.status, 'failed');
    assert.equal(result.stages.taskHub.status, 'failed');
  });
}

test('missing or unknown backup results cannot be recorded as successful', () => {
  for (const result of [undefined, null, {}, { ok: 'true' }, { ok: false }]) {
    assert.equal(backupRunOutcome(result).outcome, 'failed');
  }
});

test('a command exit of zero without a copied artifact cannot claim success', async (t) => {
  const f = await fixture(t);
  f.control.omitOutput = true;
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.stages.postgres.copied, 0);
  assert.equal(result.stages.taskHub.copied, 0);
  assert.equal(result.stages.r2.copied, 1); // The ordinary blob copy still completes.
});

test('real SQLite snapshots include committed WAL data and remain independently readable without sidecars', async (t) => {
  const f = await fixture(t, 'host backup "quoted" \' ?#% café-');
  await fs.rm(f.r2, { recursive: true });
  await fs.mkdir(f.r2);
  const source = path.join(f.r2, 'active.sqlite');
  const writer = new DatabaseSync(source);
  t.after(() => writer.close());
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES (\'committed in WAL\');');
  assert.ok((await fs.stat(source + '-wal')).size > 0);
  // Quotes, spaces and URI delimiters exercise source and output escaping.
  f.settings.offsiteBackupDir = null;
  const result = await f.run({ spawn: realSqlite(f) });
  assert.equal(result.ok, true, result.detail);
  const snapshot = path.join(f.destination, 'r2/active.sqlite');
  await absent(snapshot + '-wal');
  await absent(snapshot + '-shm');
  const reader = new DatabaseSync(snapshot, { readOnly: true });
  try {
    assert.equal(reader.prepare('SELECT value FROM evidence').get().value, 'committed in WAL');
    assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { reader.close(); }
  // The live writer keeps its sidecars and its uncheckpointed data: the
  // snapshot's connection was not the last one, so it neither checkpointed
  // nor removed anything from under the writer.
  assert.ok((await fs.stat(source + '-wal')).size > 0);
  await fs.access(source + '-shm');
  writer.exec('INSERT INTO evidence VALUES (\'written after the snapshot\');');
  assert.equal(writer.prepare('SELECT count(*) AS n FROM evidence').get().n, 2);
  assert.equal(writer.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('an idle WAL database without sidecars snapshots and is left exactly as found (ro-paxb)', async (t) => {
  // Miniflare's stores between requests: WAL mode, the last connection has
  // closed, so SQLite removed the -wal/-shm. A read-only connection cannot
  // create the -shm index it needs, and failed with "unable to open database
  // file" every night from 2026-09-15 for the R2 metadata database.
  const f = await fixture(t);
  async function idleWal(file, rows) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE objects (key TEXT PRIMARY KEY, blob_id TEXT);');
    for (const [key, blob] of rows) db.prepare('INSERT INTO objects VALUES (?, ?)').run(key, blob);
    db.close();
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.startsWith(path.basename(file))),
      [path.basename(file)], 'fixture must be an idle WAL database with no sidecars');
    return fs.readFile(file);
  }
  await fs.rm(f.r2, { recursive: true });
  const r2Dir = path.join(f.r2, 'miniflare-R2BucketObject');
  const r2Source = path.join(r2Dir, 'metadata.sqlite');
  const r2Before = await idleWal(r2Source, [['ga4/2026-09-22.json', 'blob-1'], ['gsc/2026-09-22.json', 'blob-2']]);
  await f.write(path.join(f.r2, 'miniflare-R2BucketObject/blobs/blob-1'), 'raw archive');
  f.settings.offsiteBackupDir = null;

  const { result, record } = await recordedRun(f, { spawn: realSqlite(f) });
  assert.equal(result.ok, true, result.detail);
  assert.equal(record.outcome, 'ran');
  assert.equal(result.stages.postgres.copied, 1);
  assert.deepEqual([result.stages.r2.copied, result.stages.r2.expected], [2, 2]);
  assert.match(await fs.readFile(path.join(f.destination, 'RESTORE.md'), 'utf8'), /R2: completed; 2\/2 copied/);

  const snapshot = path.join(f.destination, 'r2/miniflare-R2BucketObject/metadata.sqlite');
  await absent(snapshot + '-wal');
  await absent(snapshot + '-shm');
  const reader = new DatabaseSync(snapshot, { readOnly: true });
  try {
    assert.deepEqual(reader.prepare('SELECT key FROM objects ORDER BY key').all().map((row) => row.key),
      ['ga4/2026-09-22.json', 'gsc/2026-09-22.json']);
    assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { reader.close(); }

  // Sources are byte-identical and their directories hold exactly what they
  // held before: no sidecars left behind (Apple's sqlite3 persists the WAL
  // unless told otherwise), and nothing created.
  assert.deepEqual(await fs.readFile(r2Source), r2Before);
  assert.deepEqual((await fs.readdir(r2Dir)).sort(), ['blobs', 'metadata.sqlite']);
  // The next miniflare open still finds an ordinary WAL database.
  const reopened = new DatabaseSync(r2Source);
  try {
    assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM objects').get().n, 2);
  } finally { reopened.close(); }
});

test('a source that vanishes before its snapshot is a failed copy, never a created empty database', async (t) => {
  const f = await fixture(t);
  const source = path.join(f.r2, 'metadata.sqlite');
  f.settings.offsiteBackupDir = null;
  const result = await f.run({ spawn: (binary, args, options) => {
    if (binary !== 'sqlite3') return f.fakeSpawn(binary, args, options);
    // Removed between the inventory's lstat and the sqlite3 open.
    if (fileURLToPath(args[1]) === source) rmSync(source);
    return spawn(binary, args, options);
  } });
  assert.equal(result.stages.r2.status, 'failed');
  await absent(source);
  await absent(path.join(f.destination, 'r2/metadata.sqlite'));
});

test('invalid or missing Postgres declarations refuse before Docker contact and retain completed backups', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).ok, true);
  const before = await fs.readFile(path.join(f.destination, 'postgres/noticeos.dump'));
  for (const value of [null, {}, { ...f.profile, project: '-another' }, { ...f.profile, composeFile: 'relative' },
    { ...f.profile, secretsDir: 'relative' }, { ...f.profile, port: 0 }, { ...f.profile, port: '5401' },
    { ...f.profile, password: 'SEKRIT-profile-must-not-echo' }]) {
    await f.write(f.profileFile, JSON.stringify(value));
    const previousCalls = f.calls.length;
    const result = await f.run();
    assert.equal(result.stages.postgres.status, 'failed');
    assert.equal(f.calls.slice(previousCalls).some((call) => call.binary === 'docker'), false);
    assert.equal(result.detail.includes('SEKRIT-profile'), false);
    assert.equal(result.backupSet.path, null);
    assert.deepEqual(await fs.readFile(path.join(f.destination, 'postgres/noticeos.dump')), before);
  }
});

test('remote Docker context refuses before Compose contact; dump never inherits app or PG secrets', async (t) => {
  const f = await fixture(t);
  f.control.context = 'tcp://another-host:2376';
  const refused = await f.run({ env: { PATH: '/controlled', DOCKER_CONTEXT: 'synthetic' } });
  assert.equal(refused.stages.postgres.status, 'failed');
  assert.equal(f.calls.some((call) => call.binary === 'docker' && !call.context), false);
  f.control.context = 'unix:///synthetic/docker.sock';
  const result = await f.run({ env: {
    PATH: '/controlled', DOCKER_CONTEXT: 'synthetic', COMPOSE_PROJECT_NAME: 'unrelated',
    PGHOST: 'another-host', PGPASSWORD: 'SEKRIT-pg', DATABASE_URL: 'SEKRIT-url', CREDENTIALS_KEY: 'SEKRIT-key',
  } });
  assert.equal(result.ok, true, result.detail);
  const dump = f.calls.find((call) => call.binary === 'docker' && !call.context);
  assert.deepEqual(dump.options.env, {
    PATH: '/controlled', DOCKER_CONTEXT: 'synthetic',
    NOTICEOS_POSTGRES_SECRETS: f.profile.secretsDir, NOTICEOS_POSTGRES_PORT: String(f.profile.port),
  });
  assert.equal(JSON.stringify(dump.args).includes('SEKRIT'), false);
  assert.equal(JSON.stringify(result).includes('SEKRIT'), false);
});

test('a failed handoff does not prune its last completed offsite set', async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.offsite, '2026-08-01', 'last-good'), 'last offsite copy');
  const result = await f.run({ fs: { ...fs, cp: () => { throw new Error('Handoff unavailable'); } } });
  assert.equal(result.ok, false);
  assert.equal(result.stages.offsite.status, 'failed');
  assert.equal(await fs.readFile(path.join(f.offsite, '2026-08-01', 'last-good'), 'utf8'), 'last offsite copy');
});

test('a process killed between publication renames retains the good set and the next failed run recovers it', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).ok, true);
  const before = await fs.readFile(path.join(f.destination, 'RESTORE.md'));
  const script = `
    import fs from 'node:fs/promises';
    import { writeSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { EventEmitter } from 'node:events';
    import { runBackup } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/host-backup.mjs')).href)};
    const settings = JSON.parse(process.argv[1]);
    const spawn = (binary, args, options) => {
      const child = new EventEmitter();
      if (binary === 'docker' && args[0] === 'context') child.stdout = new EventEmitter();
      queueMicrotask(async () => {
        if (child.stdout) child.stdout.emit('data', 'unix:///synthetic/docker.sock');
        else if (binary === 'docker') writeSync(options.stdio[1], Buffer.from('PGDMP complete-new-dump'));
        else if (binary === 'sqlite3') await fs.copyFile(fileURLToPath(args[1]), JSON.parse(args[4].slice('.backup '.length)));
        else {
          const folder = args[4].split('file://')[1].slice(0, -2);
          await fs.mkdir(folder, { recursive: true }); await fs.writeFile(folder + '/snapshot', 'hub');
        }
        child.emit('close', 0, null);
      });
      return child;
    };
    await runBackup(settings, { cloudflareD1: { inventory: async () => null }, spawn, claimNamespace: 'a'.repeat(64), now: () => ${NOW}, fs: { ...fs, rename: async (source, target) => {
      if (target === settings.repoRoot + '/.local/backups/${DAY}') {
        process.send('previous-retained'); await new Promise(() => {});
      }
      return fs.rename(source, target);
    } } });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.settings)], {
    cwd: path.resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  const exited = new Promise((resolve) => child.once('close', resolve));
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Interrupted-publication fixture did not reach its barrier: ${stderr}`)), 10_000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); reject(new Error(stderr)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  child.kill('SIGKILL');
  await exited;
  const recovery = path.join(f.backupRoot, `.backup-previous-${DAY}`);
  await absent(f.destination);
  assert.deepEqual(await fs.readFile(path.join(recovery, 'RESTORE.md')), before);
  f.control.fail = ({ binary }) => binary === 'docker';
  const failed = await f.run();
  assert.equal(failed.ok, false);
  assert.equal(failed.backupSet.path, null);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'RESTORE.md')), before);
  await absent(recovery);
});
