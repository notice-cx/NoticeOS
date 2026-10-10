// Bing and DataForSEO not connected are no work, not a failure — the same rule
// Google has (test/google-not-connected.test.ts). A stranger's first action is
// adding a site, and System health must not then read "Needs attention" for
// the nightly pull (step bing), Traffic and search archives (the Bing half)
// and the weekly search sweep — sources nobody set up. With no credential
// anywhere those steps read skipped and write no failure rows, while a stored
// row this Worker cannot open still fails loudly.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowRecorder } from '../../../scripts/workflow-trace.mjs';
import { putCredential } from '../src/credentials.js';
import { DATAFORSEO_DUMPS_CRON, PULL_CRON, SIGNAL_DUMPS_CRON } from '../src/crons.js';
import { runCron } from '../src/dispatch.js';
import { ARCHIVE_RUNS, pgFirst, reset, storedCount } from './helpers.js';
import { addSites, removeSites } from './sites';

const SITE = 'recipes.example.com';

/** The suite's env with no Bing, DataForSEO or Google credential anywhere: the
 * vitest.config.ts bindings removed, and nothing stored. Google goes too, so
 * the archives step has no other half to succeed or fail. */
function nothingConnected(overrides: Record<string, unknown> = {}): IngestEnv {
  const copy = { ...env, ...overrides } as Record<string, unknown>;
  for (const binding of [
    'BING_WEBMASTER_API_KEY',
    'DATAFORSEO_LOGIN',
    'DATAFORSEO_PASSWORD',
    'GOOGLE_SIGNAL_ACCOUNTS',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
  ]) {
    delete copy[binding];
  }
  return copy as unknown as IngestEnv;
}

/** Nothing leaves the test: every provider call is refused with a status. */
function refuseOutbound(): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch);
  return asked;
}

async function fire(cron: string, target: IngestEnv) {
  const trace = createWorkflowRecorder();
  await runCron(cron, target, trace).catch(() => undefined);
  return trace.steps;
}

async function failureRows(integration: string): Promise<{ runs: number; dumps: number }> {
  const runs = await storedCount(
    `SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE integration = $1 AND status = 'error'`,
    [integration],
  );
  const dumps = await pgFirst<{ n: number }>(`SELECT count(*)::int AS n FROM ${ARCHIVE_RUNS} WHERE integration = $1 AND status = 'error'`, [integration]);
  return { runs, dumps: dumps?.n ?? 0 };
}

describe('Bing and DataForSEO not connected, after the first site is added', () => {
  beforeEach(async () => {
    await reset();
    // A new installation that has just added its first site, in both stores.
    await removeSites();
    await addSites([{ id: SITE, displayName: 'Recipes', status: 'live', senseOnly: 0 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the nightly pull reads its Bing step as skipped and records no Bing failure', async () => {
    const asked = refuseOutbound();

    const steps = await fire(PULL_CRON, nothingConnected());

    expect(steps.find((step) => step.id === 'bing')).toMatchObject({ state: 'skipped' });
    expect(asked.some((url) => url.includes('bing.com'))).toBe(false);
    expect(await failureRows('bing-webmaster')).toEqual({ runs: 0, dumps: 0 });
  });

  it('Traffic and search archives read skipped and archive no Bing failure', async () => {
    const asked = refuseOutbound();

    const steps = await fire(SIGNAL_DUMPS_CRON, nothingConnected());

    expect(steps.find((step) => step.id === 'archives')).toMatchObject({ state: 'skipped' });
    expect(asked.some((url) => url.includes('bing.com'))).toBe(false);
    expect(await failureRows('bing-webmaster')).toEqual({ runs: 0, dumps: 0 });
  });

  it('the weekly search sweep reads skipped and archives no DataForSEO failure', async () => {
    const asked = refuseOutbound();

    const steps = await fire(DATAFORSEO_DUMPS_CRON, nothingConnected());

    expect(steps.find((step) => step.id === 'search')).toMatchObject({ state: 'skipped' });
    expect(asked.some((url) => url.includes('dataforseo.com'))).toBe(false);
    expect(await failureRows('dataforseo')).toEqual({ runs: 0, dumps: 0 });
  });

  it('still fails loudly when a Bing key is stored but cannot be opened', async () => {
    const stored = await putCredential(nothingConnected(), {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: 'synthetic-bing-key' },
    });
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
    refuseOutbound();

    // The key that sealed the row is gone, so resolution falls back to an empty
    // environment — and Integrations still shows a connection.
    const steps = await fire(PULL_CRON, nothingConnected({ CREDENTIALS_KEY: '' }));

    expect(steps.find((step) => step.id === 'bing')).toMatchObject({ state: 'failed' });
    expect((await failureRows('bing-webmaster')).runs).toBe(1);
  });

  it('still fails loudly when a DataForSEO login is stored but cannot be opened', async () => {
    const stored = await putCredential(nothingConnected(), {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'synthetic-login', DATAFORSEO_PASSWORD: 'synthetic-password' },
    });
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
    refuseOutbound();

    const steps = await fire(DATAFORSEO_DUMPS_CRON, nothingConnected({ CREDENTIALS_KEY: '' }));

    expect(steps.find((step) => step.id === 'search')).toMatchObject({ state: 'failed' });
    expect((await failureRows('dataforseo')).dumps).toBeGreaterThan(0);
  });
});
