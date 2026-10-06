import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const { transpileModule, ModuleKind, ScriptTarget } = createRequire(new URL('../workers/ingest/package.json', import.meta.url))('typescript');
// Execute the actual setup with fault-injected bindings, without starting a
// Workers runtime or connecting to a database. Hooks are registered, not run.
const source = readFileSync(new URL('../workers/ingest/test/clean-start.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
}).outputText.replace(/^import .*;\n/gmu, '').replace(/^export \{\};\n/gmu, '');

function setup(overrides = {}) {
  const noop = () => undefined;
  return runInNewContext(`(async () => { ${compiled} })()`, {
    env: { TEST_POSTGRES: { fetch: async () => ({ ok: true }) } },
    // The setup owns these per VM; it must never replace Node's real globals.
    AbortSignal: { timeout: noop },
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    createTestTimeoutSignals: (_timers, timeout) => ({ timeout, run: callback => callback() }),
    fenceStore: noop,
    settle: noop,
    takeReached: () => new Set(),
    vi: { resetModules: noop, useRealTimers: noop, unstubAllGlobals: noop, unstubAllEnvs: noop },
    reset: noop,
    clearRawSignals: noop,
    seedTestSites: noop,
    forgetIsolateState: noop,
    aroundAll: noop,
    aroundEach: noop,
    beforeEach: noop,
    ...overrides,
  });
}

test('an ingest file setup failure names the awaited operation and preserves its cause without retrying', async () => {
  const steps = [
    ['settle', 'settling work left by the previous test file'],
    ['reset', 'resetting R2 and the Cache API'],
    ['clearRawSignals', 'resetting R2 and the Cache API'],
    ['postgres', "resetting this runtime's Postgres test copy"],
    ['seedTestSites', 'seeding the Postgres test sites'],
    ['forgetIsolateState', 'forgetting module state'],
  ];
  for (const [name, label] of steps) {
    let calls = 0;
    const cause = new Error('Network connection lost.');
    const fail = name === 'forgetIsolateState'
      ? () => { calls += 1; throw cause; }
      : async () => { calls += 1; throw cause; };
    const override = name === 'postgres' ? { env: { TEST_POSTGRES: { fetch: fail } } } : { [name]: fail };
    await assert.rejects(setup(override), (error) => {
      assert.equal(error.message, `ingest test file setup failed while ${label}`);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(calls, 1, `${name} was not retried`);
  }
});

test('a refused Postgres reset names the copy operation and its response status', async () => {
  await assert.rejects(setup({ env: { TEST_POSTGRES: { fetch: async () => ({ ok: false, status: 503 }) } } }), (error) => {
    assert.equal(error.message, "ingest test file setup failed while resetting this runtime's Postgres test copy");
    assert.equal(error.cause.message, 'the copy service answered 503');
    return true;
  });
});

test('the setup asks for the second Postgres copy again only after a file reached it (issue #23)', async () => {
  for (const [reached, other] of [[[], false], [['env.POSTGRES'], false], [['env.POSTGRES', 'env.POSTGRES_OTHER'], true]]) {
    const asked = [];
    await setup({
      takeReached: () => new Set(reached),
      env: { TEST_POSTGRES: { fetch: async (url, init) => { asked.push([url, JSON.parse(init.body)]); return { ok: true }; } } },
    });
    assert.deepEqual(asked, [['http://test-postgres/reset', { other }]], reached.join(', '));
  }
});

test('successful ingest file setup still registers its file and test hooks', async () => {
  const hooks = [];
  await setup({
    aroundAll: () => hooks.push('file'),
    aroundEach: () => hooks.push('test'),
    beforeEach: () => hooks.push('timeout fence'),
  });
  assert.deepEqual(hooks, ['file', 'test', 'timeout fence']);
});
