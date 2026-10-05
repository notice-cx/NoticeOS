import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { statePaths } from './os-runtime.mjs';

// scripts/runner/operator-token.mjs (bead ro-ujb9.22): the bearer the runner
// presents at its own door comes from HOME's secret files, whichever copy of
// the code runs. Each case runs the module in a fresh process whose home is a
// temporary folder holding an invented value, so nothing here reads the
// checkout's own secret files.

const MODULE = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner', 'operator-token.mjs'),
).href;

/** What operatorToken() answers for a home whose secrets file holds `bindings`. */
function tokenFor(bindings) {
  const home = mkdtempSync(path.join(tmpdir(), 'runner-token-'));
  try {
    const { devSecrets } = statePaths(home);
    mkdirSync(path.dirname(devSecrets), { recursive: true });
    writeFileSync(devSecrets, JSON.stringify(bindings));
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const m = await import(${JSON.stringify(MODULE)}); console.log(JSON.stringify(await m.operatorToken()));`],
      { env: { ...process.env, NOTICEOS_HOME: home }, encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("the bearer is read from home's secrets file, trimmed", () => {
  assert.equal(tokenFor({ OPERATOR_TOKEN: '  example-bearer  ' }), 'example-bearer');
});

test('a blank or missing bearer is no bearer, never an empty string', () => {
  assert.equal(tokenFor({ OPERATOR_TOKEN: '   ' }), null);
  assert.equal(tokenFor({ ASSET_TOKENS: 'example' }), null);
});
