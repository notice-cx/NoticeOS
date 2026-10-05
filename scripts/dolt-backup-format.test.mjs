import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { finalizeDoltBackup, doltBackupInventory } from './dolt-backup-format.mjs';

function fixture(t) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-dolt-format-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const write = (name, contents = '') => {
    fs.mkdirSync(path.dirname(path.join(output, name)), { recursive: true });
    fs.writeFileSync(path.join(output, name), contents);
  };
  write('status/ro.json', JSON.stringify({ rows: [{ status: 0 }] }));
  write('databases/ro/manifest', 'synthetic immutable snapshot');
  write('metadata/privileges.db', 'synthetic grants');
  for (const name of ['branch_control.db', 'server-config.json', 'global-config.json']) write(`metadata/${name}.absent`);
  for (const name of ['config.json', 'repo_state.json']) write(`metadata/databases/ro/${name}.absent`);
  const credentials = { root: 'a'.repeat(64) + '\n', noticeos: 'b'.repeat(64) + '\n', credentials: '[dolt:3306]\npassword=' + 'b'.repeat(64) + '\n' };
  return { output, write, credentials };
}

test('one finalizer verifies SQL status, metadata custody and private hashed files', t => {
  const f = fixture(t);
  const result = finalizeDoltBackup(f.output, ['ro'], f.credentials, { transport: 'container' });
  assert.equal(result.format, 'noticeos-dolt-backup-v1');
  const marker = JSON.parse(fs.readFileSync(path.join(f.output, 'backup.json'), 'utf8'));
  assert.equal(marker.complete, true);
  assert.equal(marker.metadata['privileges.db'], true);
  assert.equal(marker.metadata['global-config.json'], false);
  const files = doltBackupInventory(f.output, '', false); delete files['backup.json'];
  assert.deepEqual(marker.files, files);
  for (const name of Object.keys(files)) assert.equal(fs.statSync(path.join(f.output, name)).mode & 0o777, 0o600);
});

for (const defect of ['nonzero-status', 'empty-privileges', 'conflicting-absence', 'symlink', 'hardlink']) {
  test(`${defect} cannot create a complete Dolt marker`, t => {
    const f = fixture(t);
    if (defect === 'nonzero-status') f.write('status/ro.json', JSON.stringify({ rows: [{ status: null }] }));
    if (defect === 'empty-privileges') f.write('metadata/privileges.db');
    if (defect === 'conflicting-absence') f.write('metadata/privileges.db.absent');
    if (defect === 'symlink') fs.symlinkSync(path.join(f.output, 'metadata/privileges.db'), path.join(f.output, 'alias'));
    if (defect === 'hardlink') fs.linkSync(path.join(f.output, 'metadata/privileges.db'), path.join(f.output, 'alias'));
    assert.throws(() => finalizeDoltBackup(f.output, ['ro'], f.credentials, {}), /no complete snapshot/u);
    assert.equal(fs.existsSync(path.join(f.output, 'backup.json')), false);
  });
}
