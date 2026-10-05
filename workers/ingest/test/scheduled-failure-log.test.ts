// WHAT "CHECK THE SERVICE LOGS" FINDS (bead `ro-ujb9.173`).
//
// A failed step's Workflows row tells the operator to check the service logs.
// Before this bead the error was swallowed and the logs held nothing: the
// cause of a failing lane could only be found by adding a debug line. Now the
// step that failed writes one structured line — cron, step, code, message —
// and nothing credential-shaped reaches it.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putCredential } from '../src/credentials.js';
import { COUNTERS_CRON } from '../src/crons.js';
import { runScheduledCron, scheduledStepFailure } from '../src/dispatch.js';
import { SignalError } from '../src/signal-store.js';
import { reset } from './helpers.js';

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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes one line from the step that failed, and the answer carries no error', async () => {
    // A Google row this Worker cannot open (its key is gone) with no binding
    // beside it: the Google step throws config_missing.
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
    expect(failureLines(logged)).toEqual([
      {
        event: 'scheduled_step_failed',
        cron: COUNTERS_CRON,
        step: 'google',
        code: 'config_missing',
        message: 'GOOGLE_SIGNAL_ACCOUNTS is not configured.',
      },
    ]);
    expect(logged.join('\n')).not.toContain(STORED_TOKEN);
    expect(JSON.stringify(result)).not.toContain('GOOGLE_SIGNAL_ACCOUNTS');
  });
});
