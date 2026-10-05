// THE SUITE'S WORKER RUNS ON THE BINDINGS THE TEST DECLARES, AND NO OTHERS
// (bead ro-ujb9.182).
//
// In a checkout that runs the OS, `workers/ingest/.dev.vars` holds the
// installation's real secrets, and wrangler reads it from beside whatever
// config it is given. The pool now gets a copy of wrangler.jsonc in a folder
// with no secrets (vitest.config.ts, scripts/worker-config-folder.mts). These
// tests hold that from inside the Worker: its env names nothing the config
// does not declare, the bootstrap secrets are the test's own, and no provider
// binding arrives unless the config sets it. A test that exercises a legacy env
// binding sets it on its own env copy (test/credentials.test.ts).

import { env } from 'cloudflare:test';
import { INTEGRATION_PROVIDERS } from '@noticeos/contract';
import { describe, expect, it } from 'vitest';
import { ASSET_TOKENS, CREDENTIALS_KEY, OPERATOR_TOKEN } from './fixtures';

const bindings = env as unknown as Record<string, unknown>;
const declared = new Set(env.TEST_BINDING_NAMES);
/** The pool's own plumbing (its runner, loopback and eval bindings), never a secret. */
const POOL_OWN = /^__VITEST_POOL_WORKERS_/;
/** Each test's own store, set by test/clean-start.ts as a Worker call's is (src/call-store.ts): not a binding. */
const PER_TEST = new Set(['STORE']);

/** Every env name a provider credential can be read from: its fields, and any older single-site binding. */
const providerBindings = INTEGRATION_PROVIDERS.flatMap((provider) =>
  provider.fields.flatMap((field) => [field.name, ...(field.legacyAssetBinding ? [field.legacyAssetBinding.name] : [])]),
);

describe('the Worker env under test', () => {
  it('holds exactly the bindings vitest.config.ts and wrangler.jsonc declare', () => {
    expect(Object.keys(bindings).filter((name) => !declared.has(name) && !POOL_OWN.test(name) && !PER_TEST.has(name)).sort()).toEqual([]);
    expect([...declared].filter((name) => !(name in bindings)).sort()).toEqual([]);
  });

  it('carries the three bootstrap secrets as the test’s own values only', () => {
    // Compared here and reported by name, so a failure never prints a value.
    const own: Record<string, string> = { CREDENTIALS_KEY, OPERATOR_TOKEN, ASSET_TOKENS: JSON.stringify(ASSET_TOKENS) };
    expect(Object.keys(own).filter((name) => bindings[name] !== own[name])).toEqual([]);
  });

  it('carries no provider binding the test config does not set', () => {
    expect(providerBindings.length).toBeGreaterThan(0);
    expect(providerBindings.filter((name) => !declared.has(name) && bindings[name] !== undefined).sort()).toEqual([]);
  });
});
