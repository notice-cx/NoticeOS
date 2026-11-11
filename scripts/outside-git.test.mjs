import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertOutsideGit } from './test-fixtures/outside-git.mjs';

test('a fixture tree inside a Git checkout is refused before anything is written there', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-fixture-git-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, 'scratch/fixture');
  await fs.mkdir(nested, { recursive: true });
  assertOutsideGit(nested);
  await fs.mkdir(path.join(root, '.git'));
  assert.throws(() => assertOutsideGit(nested), /Test fixtures must be outside Git checkouts/);
  assert.deepEqual(await fs.readdir(nested), []);
});
