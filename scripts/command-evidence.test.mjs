import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandEvidence } from './test-fixtures/command-evidence.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-command-evidence-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, 'commands');
  return { base, directory, receipt: name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) };
}

test('refusal preserves complete redacted output, argv, exit, timeout and signal before caller assertions', async t => {
  const f = fixture(t);
  const secret = 'synthetic-private-value';
  const record = commandEvidence(f.directory, { secrets: [secret] });
  const result = { code: 1, stdout: 'x'.repeat(65536) + '\nLAST OUTPUT\n',
    stderr: `Designated migrator required.\nhttp://user:${secret}@example.invalid/?token=synthetic-token\nBearer synthetic-bearer\n${secret}\n`,
    signal: 'SIGTERM', timedOut: true };
  assert.equal(await record('unforced', ['--sandbox', '--token', secret, 'migrate', 'schema'], async () => result), result);
  const saved = f.receipt('0001-unforced.json');
  assert.equal(saved.result.stdout, result.stdout, 'output is never silently truncated');
  assert.equal(saved.result.code, 1); assert.equal(saved.result.signal, 'SIGTERM'); assert.equal(saved.result.timedOut, true);
  assert.match(saved.result.stderr, /Designated migrator required/u);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-private-value|synthetic-token|synthetic-bearer/u);
  assert.match(saved.result.stderr, /\[redacted\]|\[REDACTED\]/u);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.directory, '0001-unforced.json')).mode & 0o777, 0o600);
});

test('spawn refusal is recorded without raw secrets or an automatic retry', async t => {
  const f = fixture(t); let attempts = 0;
  const record = commandEvidence(f.directory, { secrets: ['synthetic-private-value'] });
  await assert.rejects(record('spawn', ['migrate'], async () => { attempts++; throw new Error('password=synthetic-private-value'); }), /redacted evidence retained/u);
  assert.equal(attempts, 1);
  const saved = f.receipt('0001-spawn.json');
  assert.equal(saved.result.code, null); assert.match(saved.result.error, /password=\[redacted\]/iu);
});

test('receipt custody never adopts or overwrites an existing directory', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory, 'existing'), 'preserve');
  assert.throws(() => commandEvidence(f.directory), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(f.directory, 'existing'), 'utf8'), 'preserve');
  const link = path.join(f.base, 'link'); fs.symlinkSync(f.directory, link);
  assert.throws(() => commandEvidence(link), { code: 'EEXIST' });
});
