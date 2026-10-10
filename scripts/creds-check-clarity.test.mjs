// creds:check resolves the data-source register's path at import, so this file
// points the installation folder at a fixture before loading it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'creds-check-clarity-'));
const writeRegister = (assets) =>
  fs.writeFile(path.join(dir, 'integrations.json'), JSON.stringify({ assets }));
// The register must exist before the import, or the path falls back to config/.
await writeRegister({});
process.env.NOTICEOS_INSTALLATION_DIR = dir;
const { LANES } = await import('./creds-check.mjs');
const clarity = LANES.find((lane) => lane.id === 'clarity');

test.after(() => fs.rm(dir, { recursive: true, force: true }));

/** Probes Clarity against a stub and answers which bearer it presented. The
 * probe's call-cap warning is kept off stdout, which carries the runner's own
 * protocol. */
async function probe(vars, status = 200) {
  const original = { fetch: globalThis.fetch, write: process.stdout.write };
  const bearers = [];
  globalThis.fetch = async (url, init) => {
    bearers.push(init.headers.Authorization);
    return new Response('[]', { status });
  };
  process.stdout.write = () => true;
  try {
    return { result: await clarity.probe(vars), bearers };
  } finally {
    globalThis.fetch = original.fetch;
    process.stdout.write = original.write;
  }
}

test('a legacy single-project token serves the asset the register gives the Clarity lane', async () => {
  await writeRegister({
    'blog.example.com': { gsc: { status: 'live' } },
    'shop.example.com': { clarity: { status: 'live' } },
  });
  const vars = { CLARITY_PROJECT_API_TOKEN: 'single' };
  assert.equal(clarity.configured(vars), true);
  const { result, bearers } = await probe(vars);
  assert.deepEqual(bearers, ['Bearer single']);
  assert.deepEqual(result.proofs, [{ integrationId: 'clarity', assets: ['shop.example.com'] }]);

  // A refusal names the binding the token came from.
  const refused = await probe(vars, 401);
  assert.match(refused.result.rows[0].sub[0], /^fix: CLARITY_PROJECT_API_TOKEN /);
});

test('the per-asset map wins over the legacy token for the same asset', async () => {
  await writeRegister({ 'shop.example.com': { clarity: { status: 'live' } } });
  const { bearers } = await probe({
    CLARITY_TOKENS: JSON.stringify({ 'shop.example.com': 'mapped' }),
    CLARITY_PROJECT_API_TOKEN: 'single',
  });
  assert.deepEqual(bearers, ['Bearer mapped']);
});

test('a legacy token with no Clarity lane in the register serves nobody', async () => {
  await writeRegister({ 'shop.example.com': { gsc: { status: 'live' } } });
  const vars = { CLARITY_PROJECT_API_TOKEN: 'single' };
  assert.equal(clarity.configured(vars), false);
  const { result, bearers } = await probe(vars);
  assert.deepEqual(bearers, []);
  assert.equal(result.rows[0].state, 'skip');
});
