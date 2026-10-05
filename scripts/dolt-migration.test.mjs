import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, readDoltMigrationPlan } from './dolt-migration.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-migration-cli-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const input = { format: 'noticeos-dolt-migration-plan-v1', capture: {
    sourceDirectory: path.join(base, 'source'), outputDirectory: path.join(base, 'capture'), sourceVersion: '2.2.3',
    databases: ['synthetic_tasks'], service: { brew: path.join(base, 'brew'), home: base, name: 'dolt', label: 'homebrew.mxcl.dolt' },
    files: [{ name: 'global-config', path: path.join(base, 'absent-global.json'), required: false }],
    approval: 'Synthetic fixture only', writerFence: 'Synthetic source has no clients or service' },
    target: { root: path.resolve('.'), home: path.join(base, 'target'), towerPort: 5344, globalConfigName: 'global-config' } };
  const file = path.join(base, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  let output = ''; let error = '';
  const streams = { stdout: { write(value) { output += value; } }, stderr: { write(value) { error += value; } } };
  return { base, input, file, streams, output: () => output, error: () => error };
}

test('describe reads only the protected plan, never absent source, target, service or capture resources', async t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.base);
  const code = await main(['describe', '--plan', f.file], { ...f.streams, run() { assert.fail('describe cannot execute any process'); } });
  assert.equal(code, 0);
  const result = JSON.parse(f.output());
  assert.equal(result.sourceDirectory, f.input.capture.sourceDirectory);
  assert.deepEqual(result.sourceServiceRead, [f.input.capture.service.brew, 'services', 'info', 'dolt', '--json']);
  assert.equal(result.target.port, 5347);
  assert.deepEqual(fs.readdirSync(f.base), before);
  assert.equal(f.error(), '');
});

test('unprotected, linked, oversized, invalid-version and ambiguous plan files are refused', t => {
  const f = fixture(t);
  fs.chmodSync(f.file, 0o644); assert.throws(() => readDoltMigrationPlan(f.file));
  fs.chmodSync(f.file, 0o600);
  const link = path.join(f.base, 'link.json'); fs.symlinkSync(f.file, link);
  assert.throws(() => readDoltMigrationPlan(link));
  const linkedBase = path.join(f.base, 'linked'); fs.symlinkSync(f.base, linkedBase);
  assert.throws(() => readDoltMigrationPlan(path.join(linkedBase, 'plan.json')));
  for (const input of [{ ...f.input, format: 'unknown' }, { ...f.input, target: { ...f.input.target, towerPort: 0 } },
    { ...f.input, capture: { ...f.input.capture, writerFence: '' } },
    { ...f.input, capture: { ...f.input.capture, sourceVersion: 'unknown' } }]) {
    fs.writeFileSync(f.file, JSON.stringify(input)); assert.throws(() => readDoltMigrationPlan(f.file));
  }
  fs.writeFileSync(f.file, ' '.repeat(65 * 1024)); assert.throws(() => readDoltMigrationPlan(f.file));
  assert.throws(() => readDoltMigrationPlan('plan.json'));
});

test('explicit capture and verify share one protected plan and keep fixture source bytes unchanged', async t => {
  const f = fixture(t);
  const sourceFile = path.join(f.input.capture.sourceDirectory, 'synthetic_tasks/.dolt/chunk');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourceFile, 'Synthetic opaque committed, staged and working state');
  let calls = 0;
  const run = async (binary, args) => {
    assert.equal(binary, f.input.capture.service.brew); assert.deepEqual(args, ['services', 'info', 'dolt', '--json']); calls++;
    return { code: 0, stdout: JSON.stringify([{ name: 'dolt', service_name: 'homebrew.mxcl.dolt',
      running: false, loaded: false, schedulable: false, pid: null, status: 'none' }]) };
  };
  assert.equal(await main(['capture', '--plan', f.file], { ...f.streams, run }), 0);
  assert.equal(calls, 2);
  assert.equal(await main(['verify', '--plan', f.file], { ...f.streams, run() { assert.fail('verify cannot execute a process'); } }), 0);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'Synthetic opaque committed, staged and working state');
  assert.equal(fs.existsSync(f.input.target.home), false);
  const marker = JSON.parse(fs.readFileSync(path.join(f.input.capture.outputDirectory, 'capture.json'), 'utf8'));
  assert.equal(marker.sourceVersion, '2.2.3');
  fs.writeFileSync(f.file, JSON.stringify({ ...f.input, capture: { ...f.input.capture, databases: ['different_tasks'] } }));
  assert.equal(await main(['restore', '--plan', f.file], { ...f.streams, run() { assert.fail('wrong capture identity cannot contact Docker'); } }), 1);
});

test('real CLI ignores poisoned ambient endpoints and requires one explicit operation without retry', t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('./dolt-migration.mjs', import.meta.url));
  const before = fs.readdirSync(f.base);
  const env = { ...process.env, HOME: path.join(f.base, 'poison-home'), BEADS_DOLT_SERVER_PORT: '3308',
    DOLT_CLI_PASSWORD: 'synthetic-poison-credential', NOTICEOS_TASK_CLIENT_PROFILE: '/missing/ambient-profile' };
  const result = spawnSync(process.execPath, [cli, 'describe', '--plan', f.file], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).target.port, 5347);
  assert.equal(result.stdout.includes('synthetic-poison-credential'), false);
  for (const args of [['stop', '--plan', f.file], ['describe', '--plan', f.file, '--restore'], ['restore']]) {
    const denied = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
    assert.equal(denied.status, 1); assert.equal(denied.stdout, ''); assert.match(denied.stderr, /Dolt migration refused/u);
  }
  assert.deepEqual(fs.readdirSync(f.base), before);
});
