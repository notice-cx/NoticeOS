import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { testFixtureRoot } from './test-fixture-root.mjs';

test('owned fixture roots are canonical through a symlinked temp parent', t => {
  const own = testFixtureRoot('fixture-root-proof-');
  t.after(() => fs.rmSync(own, { recursive: true, force: true }));
  const real = path.join(own, 'real'), alias = path.join(own, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, 'dir');
  const fixture = testFixtureRoot('fixture-', alias);
  assert.equal(path.dirname(fixture), real);
  assert.equal(fixture, fs.realpathSync(fixture));
  fs.writeFileSync(path.join(fixture, 'owned'), 'fixture');
  assert.equal(fs.readFileSync(path.join(alias, path.basename(fixture), 'owned'), 'utf8'), 'fixture');
});
