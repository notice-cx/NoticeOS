import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureStoppedDoltSource } from './dolt-migration-capture.mjs';
import { restoreNativeDoltCapture } from './dolt-migration-restore.mjs';
import { startDoltPlan } from './dolt-host.mjs';

async function fixture(t, initialized = false) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-native-restore-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(path.join(source, 'synthetic_tasks/.dolt'), { recursive: true });
  fs.writeFileSync(path.join(source, 'synthetic_tasks/.dolt/repo_state.json'), '{}');
  if (initialized) fs.writeFileSync(path.join(source, '.noticeos-initialized'), '');
  const global = path.join(base, 'global.json'); fs.writeFileSync(global, '{}');
  const capture = path.join(base, 'capture');
  await captureStoppedDoltSource({ sourceDirectory: source, outputDirectory: capture, sourceVersion: '2.2.3', databases: ['synthetic_tasks'],
    files: [{ name: 'global-config', path: global, required: true }], service: { brew: '/synthetic/bin/brew', home: base, name: 'dolt', label: 'synthetic.dolt' },
    approval: 'Synthetic', writerFence: 'Synthetic no writers' }, { run: async () => ({ code: 0, stdout: JSON.stringify([
      { name: 'dolt', service_name: 'synthetic.dolt', running: false, loaded: false, schedulable: false, pid: null, status: 'none' }]) }) });
  const home = path.join(base, 'target'); fs.mkdirSync(home, { mode: 0o700 });
  const profile = startDoltPlan({ root: base, home, port: 5344 });
  const calls = [];
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === 'context') return { code: 0, stdout: 'unix:///synthetic/docker.sock', stderr: '' };
    if (args[0] === 'volume') return { code: 1, stdout: '', stderr: 'No such volume' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { base, source, capture, home, profile, calls, run };
}

test('native restore uses only exact new project/volume and current image after immutable input verification', async t => {
  const f = await fixture(t);
  const result = await restoreNativeDoltCapture(f.profile, f.capture, { run: f.run, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.sourceVersion, '2.2.3'); assert.equal(result.targetVersion, '2.4.0');
  const restore = f.calls.find(call => call.args.includes('/etc/noticeos/restore-native.sh'));
  assert.ok(restore);
  assert.equal(restore.args.includes('--rm'), true);
  assert.equal(restore.args.includes('--no-deps'), true);
  assert.equal(f.calls.some(call => call.args.includes('--force') || call.args.includes('stop') || call.args.includes('restart')), false);
  for (const name of ['root', 'noticeos']) {
    const file = path.join(f.profile.secretsDir, name);
    const secret = fs.readFileSync(file, 'utf8').trim();
    assert.match(secret, /^[0-9a-f]{64}$/u); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(f.calls).includes(secret), false);
  }
  const create = f.calls.findIndex(call => call.args.includes('create'));
  const up = f.calls.findIndex(call => call.args.includes('up'));
  assert.ok(create < up && f.calls.indexOf(restore) < up, 'Listener opens only after target-only auth adaptation');
});

test('tampered capture, unsupported source version and managed-source marker refuse before any Docker or target setup', async t => {
  for (const bad of ['tampered', 'version', 'managed']) {
    const f = await fixture(t, bad === 'managed');
    if (bad === 'tampered') fs.appendFileSync(path.join(f.capture, 'data/synthetic_tasks/.dolt/repo_state.json'), 'tamper');
    if (bad === 'version') {
      const file = path.join(f.capture, 'capture.json'); const marker = JSON.parse(fs.readFileSync(file)); marker.sourceVersion = '2.4.1'; fs.writeFileSync(file, JSON.stringify(marker));
    }
    await assert.rejects(restoreNativeDoltCapture(f.profile, f.capture, { run: f.run }));
    assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(f.home, 'dolt')), false);
  }
});

test('existing target files/service/volume, foreign profile and linked target directories refuse without adoption', async t => {
  for (const bad of ['files', 'service', 'volume', 'profile', 'linked']) {
    const f = await fixture(t);
    if (bad === 'files') fs.mkdirSync(path.join(f.home, 'dolt'));
    if (bad === 'profile') f.profile.project = 'noticeos-start-0123456789abcdef';
    if (bad === 'linked') { fs.rmdirSync(f.home); fs.symlinkSync(path.join(f.base, 'source'), f.home); }
    const run = async (binary, args, options) => {
      if (bad === 'service' && args.includes('ps')) return { code: 0, stdout: 'Existing container' };
      if (bad === 'volume' && args[0] === 'volume') return { code: 0, stdout: 'Existing volume' };
      return f.run(binary, args, options);
    };
    await assert.rejects(restoreNativeDoltCapture(f.profile, f.capture, { run }));
    assert.equal(f.calls.some(call => call.args.includes('create') || call.args.includes('run') || call.args.includes('up')), false);
  }
});

test('failed target-only adaptation never opens listener or surfaces secret-bearing diagnostics', async t => {
  const f = await fixture(t);
  const run = async (binary, args, options) => args.includes('/etc/noticeos/restore-native.sh')
    ? { code: 1, stdout: 'protected original data', stderr: 'protected credential' } : f.run(binary, args, options);
  await assert.rejects(restoreNativeDoltCapture(f.profile, f.capture, { run }), error => !/credential|original data/u.test(error.message));
  assert.equal(f.calls.some(call => call.args.includes('up')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'dolt/profile.json')), true, 'Partial own target remains for explicit recovery');
});


test('native capture cannot restore into a shared installation project', async t => {
  const f = await fixture(t);
  for (const project of ['noticeos', 'noticeos-shared-example']) {
    await assert.rejects(restoreNativeDoltCapture({ ...f.profile, project }, f.capture, { run: f.run }));
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'dolt')), false);
  }
});
