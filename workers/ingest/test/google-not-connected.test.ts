// Google not connected is no work, not a failure.
//
// A new installation (empty store, nothing on Integrations) fires every lane
// on its schedule. The two Google-backed lanes must not throw `config_missing`
// on every run and make System health read "Needs attention" for a source
// nobody set up: they read skipped, like every other provider not connected —
// while a Google row that is stored but cannot be opened still fails loudly.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowRecorder } from '../../../scripts/workflow-trace.mjs';
import { putCredential } from '../src/credentials.js';
import { COUNTERS_CRON, SIGNAL_DUMPS_CRON } from '../src/crons.js';
import { runCron } from '../src/dispatch.js';
import { runGoogleSignals } from '../src/google-signals.js';
import { runSignalDumps } from '../src/signal-dumps.js';
import { reset, storedCount } from './helpers.js';
import { removeSites } from './sites';

const NOW = Date.parse('2026-09-24T12:15:00.000Z');

/** The env with no Google credential anywhere: the suite's service-account
 * binding (vitest.config.ts) removed, and nothing stored. */
function noGoogle(overrides: Record<string, unknown> = {}): IngestEnv {
  const copy = { ...env, ...overrides } as Record<string, unknown>;
  delete copy.GOOGLE_SIGNAL_ACCOUNTS;
  delete copy.GOOGLE_OAUTH_REFRESH_TOKEN;
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

describe('Google not connected at all', () => {
  beforeEach(async () => {
    await reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a new installation reads Live traffic and counters’ Google step as skipped', async () => {
    await removeSites();
    const asked = refuseOutbound();

    const steps = await fire(COUNTERS_CRON, noGoogle());

    expect(steps.find((step) => step.id === 'google')).toMatchObject({ state: 'skipped' });
    expect(asked.some((url) => url.includes('googleapis.com'))).toBe(false);
  });

  it('a new installation reads Traffic and search archives as skipped', async () => {
    await removeSites();
    const asked = refuseOutbound();

    const steps = await fire(SIGNAL_DUMPS_CRON, noGoogle());

    expect(steps.find((step) => step.id === 'archives')).toMatchObject({ state: 'skipped' });
    expect(asked.some((url) => url.includes('googleapis.com'))).toBe(false);
  });

  it('asks Google nothing and records nothing for a site added before Google is connected', async () => {
    refuseOutbound();

    const live = await runGoogleSignals(noGoogle(), { nowMs: NOW });
    const archive = await runSignalDumps(noGoogle(), { nowMs: NOW, revisionDays: 1, bingApiKey: '' });

    expect(live).toMatchObject({ attempted: 0, failed: 0 });
    expect(archive.outcomes.filter((outcome) => outcome.integration === 'ga4' || outcome.integration === 'gsc')).toEqual([]);
    const google = await storedCount(
      `SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE integration IN ('ga4', 'gsc')`,
    );
    expect(google).toBe(0);
  });

  it('still fails loudly when a Google row is stored but cannot be opened', async () => {
    await removeSites();
    const stored = await putCredential(noGoogle(), {
      provider: 'google',
      fields: { GOOGLE_OAUTH_REFRESH_TOKEN: 'synthetic-refresh-token' },
    });
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
    refuseOutbound();

    // The key that sealed the row is gone, so resolution falls back to an
    // empty environment — and Integrations still shows a connection.
    const steps = await fire(COUNTERS_CRON, noGoogle({ CREDENTIALS_KEY: '' }));

    expect(steps.find((step) => step.id === 'google')).toMatchObject({ state: 'failed' });
  });
});
