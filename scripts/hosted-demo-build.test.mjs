import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.join(import.meta.dirname, 'hosted-demo-build.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('a refused demo build says why, so a failed image build names its cause', () => {
  const usage = run();
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^Demo artifact build refused: usage: --out <new folder>/mu);
  const relative = run('--out', 'relative');
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /^Demo artifact build refused: the output must be a new absolute folder/mu);
});
