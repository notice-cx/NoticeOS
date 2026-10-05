import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { captureStoppedDoltSource } from './dolt-migration-capture.mjs';
import { startDoltPlan } from './dolt-profile.mjs';
import { readSpokeMigrationPlan, rehearseSpokeMigration, installSpokeMigration, rollbackSpokeMigration } from './dolt-migration-spokes.mjs';

async function fixture(t, { configuration = '# Synthetic comment\nno-git-ops: true\nimport.auto: false\nissue-prefix: sy\ndolt.server.port: 3308\n' } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-spoke-migration-')); fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'opaque'), 'Synthetic native working state');
  const files = []; const before = []; const spokes = [];
  for (const database of ['active', 'retired']) {
    fs.mkdirSync(path.join(source, database, '.dolt'), { recursive: true });
    const repo = path.join(base, database); fs.mkdirSync(path.join(repo, '.beads'), { recursive: true });
    const projectId = database === 'active' ? '11111111-1111-1111-1111-111111111111' : '22222222-2222-2222-2222-222222222222';
    const meta = JSON.stringify({ database: 'dolt', backend: 'dolt', dolt_mode: 'server', dolt_database: database, project_id: projectId,
      dolt_server_host: '127.0.0.1', dolt_server_port: 3308, dolt_server_user: 'root', preserved: 'Synthetic unknown property' });
    for (const [name, body, filename] of [[`${database}-metadata`, meta, 'metadata.json'], [`${database}-config`, configuration, 'config.yaml']]) {
      const file = path.join(repo, '.beads', filename); fs.writeFileSync(file, body, { mode: 0o644 }); files.push({ name, path: file, required: true }); before.push({ file, body });
    }
    spokes.push({ repo, database, prefix: 'sy', projectId, metadataName: `${database}-metadata`, configName: `${database}-config` });
  }
  const capture = path.join(base, 'capture');
  await captureStoppedDoltSource({ sourceDirectory: source, outputDirectory: capture, sourceVersion: '2.2.3', databases: ['active', 'retired'],
    service: { brew: '/synthetic/brew', home: base, name: 'dolt', label: 'homebrew.mxcl.dolt' }, files, approval: 'Synthetic approval', writerFence: 'Synthetic no writers' },
  { run: async () => ({ code: 0, stdout: JSON.stringify([{ name: 'dolt', service_name: 'homebrew.mxcl.dolt', running: false, loaded: false, schedulable: false, pid: null, status: 'none' }]) }) });
  const doltHome = path.join(base, 'target'); fs.mkdirSync(doltHome, { mode: 0o700 });
  const profile = startDoltPlan({ root: path.resolve('.'), home: doltHome, port: 63305 });
  fs.mkdirSync(profile.secretsDir, { recursive: true, mode: 0o700 });
  for (const key of ['root', 'noticeos']) fs.writeFileSync(path.join(profile.secretsDir, key), 'a'.repeat(64) + '\n', { mode: 0o600 });
  fs.writeFileSync(profile.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${'a'.repeat(64)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(doltHome, 'dolt/profile.json'), JSON.stringify(profile), { mode: 0o600 });
  const input = { format: 'noticeos-dolt-spokes-v1', capture, doltHome, rehearsal: path.join(base, 'rehearsal'), journal: path.join(base, 'journal.json'), spokes,
    approval: 'Synthetic approval only', writerFence: 'Synthetic no writers' };
  const file = path.join(base, 'plan.json'); fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  return { base, file, input, before, profile };
}

test('copied rehearsal spokes preserve every identity and unknown field, select one profile and leave originals untouched', async t => {
  const f = await fixture(t); const result = rehearseSpokeMigration(f.file);
  assert.equal(result.projects.length, 2);
  for (const [index, spoke] of f.input.spokes.entries()) {
    const copied = path.join(result.projects[index].repo, '.beads');
    const metadata = JSON.parse(fs.readFileSync(path.join(copied, 'metadata.json')));
    assert.equal(metadata.project_id, spoke.projectId); assert.equal(metadata.dolt_database, spoke.database);
    assert.equal(metadata.dolt_server_port, f.profile.port); assert.equal(metadata.dolt_server_user, 'noticeos');
    assert.equal(metadata.preserved, 'Synthetic unknown property');
    const config = fs.readFileSync(path.join(copied, 'config.yaml'), 'utf8');
    assert.ok(config.includes('# Synthetic comment')); assert.ok(config.includes('issue-prefix: sy')); assert.match(config, /^dolt\.server\.port: 63308$/mu);
    assert.equal(fs.statSync(path.join(result.projects[index].repo, '.beads.gate.lock')).mode & 0o777, 0o600);
  }
  for (const old of f.before) assert.equal(fs.readFileSync(old.file, 'utf8'), old.body);
  assert.throws(() => rehearseSpokeMigration(f.file)); assert.equal(fs.existsSync(f.input.journal), false);
});

test('all original files change atomically with retained modes and rollback restores exact captured bytes', async t => {
  const f = await fixture(t); const oldInode = fs.statSync(f.before[0].file).ino;
  assert.equal(installSpokeMigration(f.file).files, 4);
  assert.notEqual(fs.statSync(f.before[0].file).ino, oldInode);
  assert.equal(fs.statSync(f.before[0].file).mode & 0o777, 0o644);
  assert.equal(JSON.parse(fs.readFileSync(f.before[0].file)).dolt_server_port, f.profile.port);
  assert.throws(() => installSpokeMigration(f.file));
  assert.equal(rollbackSpokeMigration(f.file).rolledBack, true);
  for (const old of f.before) assert.equal(fs.readFileSync(old.file, 'utf8'), old.body);
  assert.equal(JSON.parse(fs.readFileSync(f.input.journal)).rolledBack, true);
});

test('source drift, unsafe paths, immutable capture changes and identity mismatch refuse before any original replacement', async t => {
  const f = await fixture(t);
  fs.appendFileSync(f.before.at(-1).file, '# Later independent change\n');
  assert.throws(() => installSpokeMigration(f.file)); assert.equal(fs.existsSync(f.input.journal), false);
  assert.equal(fs.readFileSync(f.before[0].file, 'utf8'), f.before[0].body);
  fs.writeFileSync(f.before.at(-1).file, f.before.at(-1).body);
  for (const patch of [{ journal: path.join(f.input.capture, 'journal.json') }, { rehearsal: path.join(f.input.spokes[0].repo, '.beads/rehearsal') },
    { spokes: [{ ...f.input.spokes[0], projectId: f.input.spokes[1].projectId }, f.input.spokes[1]] }]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.input, ...patch })); assert.throws(() => readSpokeMigrationPlan(f.file));
  }
  fs.writeFileSync(f.file, JSON.stringify(f.input)); fs.chmodSync(f.file, 0o644); assert.throws(() => readSpokeMigrationPlan(f.file)); fs.chmodSync(f.file, 0o600);
  fs.appendFileSync(path.join(f.input.capture, 'metadata/active-metadata'), ' '); assert.throws(() => installSpokeMigration(f.file));
});

test('later independent edits and linked source files cannot be overwritten during install or rollback', async t => {
  const f = await fixture(t); const selected = f.before[0].file;
  fs.renameSync(selected, selected + '.held'); fs.symlinkSync(selected + '.held', selected);
  assert.throws(() => installSpokeMigration(f.file)); assert.equal(fs.existsSync(f.input.journal), false);
  fs.unlinkSync(selected); fs.renameSync(selected + '.held', selected);
  installSpokeMigration(f.file); fs.appendFileSync(selected, ' ');
  assert.throws(() => rollbackSpokeMigration(f.file));
  assert.equal(JSON.parse(fs.readFileSync(f.before[2].file)).dolt_server_user, 'noticeos');
});

test('partial replacement journals roll back both installed entries and untouched originals without adopting unknown temporary files', async t => {
  const f = await fixture(t); const before = f.before.map(entry => fs.statSync(entry.file));
  installSpokeMigration(f.file);
  const receipt = JSON.parse(fs.readFileSync(f.input.journal)); receipt.complete = false;
  // Model a crash before entries 2..4 were renamed, preserving the journaled
  // original identity. The first entry models rename before its final journal.
  for (let index = 1; index < f.before.length; index++) {
    fs.writeFileSync(f.before[index].file, f.before[index].body);
    const stat = fs.statSync(f.before[index].file);
    receipt.entries[index].before.ino = stat.ino; receipt.entries[index].before.birthtimeMs = stat.birthtimeMs;
    receipt.entries[index].after = null;
  }
  assert.notEqual(before[0].ino, fs.statSync(f.before[0].file).ino);
  fs.writeFileSync(f.input.journal, JSON.stringify(receipt));
  assert.equal(rollbackSpokeMigration(f.file).rolledBack, true);
  for (const old of f.before) assert.equal(fs.readFileSync(old.file, 'utf8'), old.body);
});

test('interrupted rollback resumes after the restore rename using its previously journaled inode', async t => {
  const f = await fixture(t); installSpokeMigration(f.file);
  const selected = f.before[0].file; const rename = mutableFs.renameSync;
  // Simulate process loss immediately after the real filesystem rename, before
  // the helper can publish its next journal. Only this owned fixture is touched.
  mutableFs.renameSync = (from, to) => { rename(from, to); if (to === selected) throw Error('Synthetic interruption after restore rename'); };
  syncBuiltinESMExports();
  try { assert.throws(() => rollbackSpokeMigration(f.file), /Synthetic interruption/u); }
  finally { mutableFs.renameSync = rename; syncBuiltinESMExports(); }
  const interrupted = JSON.parse(fs.readFileSync(f.input.journal));
  assert.equal(fs.readFileSync(selected, 'utf8'), f.before[0].body);
  assert.equal(interrupted.entries[0].restored.ino, fs.statSync(selected).ino);
  assert.equal(fs.existsSync(interrupted.entries[0].restoreTemp), false);
  assert.equal(interrupted.rolledBack, undefined);
  assert.equal(rollbackSpokeMigration(f.file).rolledBack, true);
  for (const old of f.before) assert.equal(fs.readFileSync(old.file, 'utf8'), old.body);
});

test('duplicate safety keys of either order or matching values refuse before rehearsal, journal or original replacements', async t => {
  for (const [key, good, bad] of [['no-git-ops', 'true', 'false'], ['import.auto', 'false', 'true']]) {
    for (const values of [[good, bad], [bad, good], [good, good]]) {
      const other = key === 'no-git-ops' ? 'import.auto: false' : 'no-git-ops: true';
      const f = await fixture(t, { configuration: `${other}\n${key}: ${values[0]}\n${key}: ${values[1]}\n` });
      assert.throws(() => rehearseSpokeMigration(f.file)); assert.throws(() => installSpokeMigration(f.file));
      assert.equal(fs.existsSync(f.input.rehearsal), false); assert.equal(fs.existsSync(f.input.journal), false);
      for (const old of f.before) assert.equal(fs.readFileSync(old.file, 'utf8'), old.body);
    }
  }
});
