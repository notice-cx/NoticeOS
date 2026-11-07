// Summaries remain fixed while run diagnostics and structured service logs
// retain the useful cause without credential material.

import { createWorkflowRecorder } from '../../../scripts/workflow-trace.mjs';
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedConfigDocuments, forgetConfigCache } from '../src/config-store.js';
import { putCredential } from '../src/credentials.js';
import { COUNTERS_CRON } from '../src/crons.js';
import { runScheduledCron, scheduledStepFailure } from '../src/dispatch.js';
import { SignalError } from '../src/signal-store.js';
import { reset, forgetConfigDocuments } from './helpers.js';

const STORED_TOKEN = 'synthetic-refresh-token-9f3c';

function failureLines(logged: string[]): Record<string, unknown>[] {
  return logged
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line?.event === 'scheduled_step_failed');
}

describe('the line a failed scheduled step writes', () => {
  it('names the cron, the step, the code and the message, and nothing secret', () => {
    const error = new SignalError(
      'request_failed',
      'GET https://provider.example.com/v1/report?api_key=sk-live-abc123&site=example.com failed; Authorization: Bearer eyJhbGciOi.secret.sig',
    );

    const line = scheduledStepFailure('*/15 * * * *', 'google', error);

    expect(Object.keys(line).sort()).toEqual(['code', 'cron', 'event', 'message', 'step']);
    expect(line).toMatchObject({
      event: 'scheduled_step_failed',
      cron: '*/15 * * * *',
      step: 'google',
      code: 'request_failed',
    });
    expect(line.message).toContain('provider.example.com');
    expect(JSON.stringify(line)).not.toContain('sk-live-abc123');
    expect(JSON.stringify(line)).not.toContain('eyJhbGciOi');
  });

  it('retains a useful diagnostic error while removing credential material', async () => {
    const trace = createWorkflowRecorder();
    await expect(trace.run('google', async () => { throw new Error(`GOOGLE_SIGNAL_ACCOUNTS request failed; Authorization: Bearer ${STORED_TOKEN}`); })).rejects.toThrow();
    const step = trace.steps[0]!;
    expect(step.summary ?? '').not.toContain('GOOGLE_SIGNAL_ACCOUNTS');
    expect(step.diagnostics?.error?.text).toContain('GOOGLE_SIGNAL_ACCOUNTS');
    expect(step.diagnostics?.error?.redacted).toBe(true);
    expect(JSON.stringify(step)).not.toContain(STORED_TOKEN);
  });

  it('keeps a plain error’s name as its code, and bounds the message', () => {
    const line = scheduledStepFailure('0 3 * * *', null, new TypeError('x'.repeat(2_000)));

    expect(line.code).toBe('TypeError');
    expect(line.step).toBeNull();
    expect(line.message.length).toBe(500);
  });
});

describe('a scheduled fire whose step throws', () => {
  let logged: string[];

  beforeEach(async () => {
    await reset();
    logged = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.stubGlobal('fetch', (async () => new Response('unavailable', { status: 503 })) as typeof fetch);
  });

  afterEach(async () => {
    try { await forgetConfigDocuments(['config/integrations.json']); } finally {
      forgetConfigCache(env.STORE);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('keeps the summary safe while retaining the actual redacted error and configuration provenance', async () => {
    // A Google row this Worker cannot open (its key is gone) with no binding
    // beside it: the Google step throws config_missing.
    await forgetConfigDocuments(['config/integrations.json']);
    const accountId = '947318265';
    expect((await seedConfigDocuments(env, { actor: 'diagnostic-fixture', documents: {
      'config/integrations.json': { catalog: [], assets: { 'example.com': { ga4: { ga4PropertyId: accountId } } } },
    } })).ok).toBe(true);
    forgetConfigCache(env.STORE);
    const bare = { ...env } as Record<string, unknown>;
    delete bare.GOOGLE_SIGNAL_ACCOUNTS;
    const stored = await putCredential(bare as unknown as IngestEnv, {
      provider: 'google',
      fields: { GOOGLE_OAUTH_REFRESH_TOKEN: STORED_TOKEN },
    });
    expect(stored.ok, JSON.stringify(stored)).toBe(true);

    const result = await runScheduledCron(COUNTERS_CRON, { ...bare, CREDENTIALS_KEY: '' } as unknown as IngestEnv);

    expect(result.outcome).toBe('failed');
    expect(result.steps?.find((step) => step.id === 'google')).toMatchObject({ state: 'failed' });
    expect(failureLines(logged)).toMatchObject([
      {
        event: 'scheduled_step_failed',
        cron: COUNTERS_CRON,
        step: 'google',
        code: 'config_missing',
      },
    ]);
    expect(logged.join('\n')).not.toContain(STORED_TOKEN);
    expect(result.detail ?? '').not.toContain('GOOGLE_SIGNAL_ACCOUNTS');
    const google = result.steps?.find(step => step.id === 'google');
    expect(google?.summary ?? '').not.toContain('GOOGLE_SIGNAL_ACCOUNTS');
    expect(google?.diagnostics?.error?.text).toContain('GOOGLE_SIGNAL_ACCOUNTS');
    expect(JSON.stringify(result)).not.toContain(STORED_TOKEN);
    expect(JSON.parse(google!.diagnostics!.input!.text)).toMatchObject({ configSources: { 'config/integrations.json': 'store' } });
    const config = result.steps?.find(step => step.id === 'config');
    expect(JSON.parse(config!.diagnostics!.output!.text)).toMatchObject({ sources: { 'config/integrations.json': 'store' } });
    expect(config?.diagnostics?.output?.text).not.toContain('documents');
    for (const step of result.steps ?? []) expect(step.diagnostics?.input?.text ?? '').not.toContain(accountId);
    expect(config?.diagnostics?.output?.text).not.toContain(accountId);
  });
});
