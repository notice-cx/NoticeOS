import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { credentialSummary, putCredential } from '../src/credentials.js';
import {
  NOW,
  type FetchCall,
  FAST_RETRY,
  providerFetch,
  ACCOUNT_PATH,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

// The prepaid balance decides whether next Monday's sweep can run, and the paid
// report endpoints never state it, so the sweep makes one read of the free
// account endpoint at the end of a run that worked. These pin the price of that:
// one extra call, zero spend, no retry, nothing from a run that failed or had
// nothing to do, and a failure of the read that leaves the sweep green.

describe('DataForSEO account credit', () => {
  /** The password never appears in a verdict, a log or this file's assertions —
   * it is here only so the sweep runs off the STORE rather than off options,
   * which is the only path that stamps a credential. */
  const DFS_PASSWORD = 'SEKRIT-dataforseo-sweep-do-not-echo';
  /** One property, one family: the smallest sweep that still buys something. */
  const ONE_FAMILY = { asset: 'meadow.example', families: ['backlinks-summary'] };

  async function storeCredential(): Promise<void> {
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });
  }

  function accountCalls(calls: FetchCall[]): FetchCall[] {
    return calls.filter((call) => call.url.endsWith(ACCOUNT_PATH));
  }

  it('refreshes the credit with one free read at the end of a sweep that worked', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch({ accountBalanceUsd: 12.34 });
    const result = await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: ONE_FAMILY });

    // ONE report, ONE account read, and the account read is last: the run does
    // not spend a call asking about credit it may not get to use.
    expect(calls).toHaveLength(2);
    expect(accountCalls(calls)).toHaveLength(1);
    expect(calls.at(-1)!.url).toContain(ACCOUNT_PATH);
    // Free. The run's billed total is the report's cost and nothing else.
    expect(result.costUsd).toBeCloseTo(0.011, 6);

    const summary = (await credentialSummary(env, 'dataforseo'))!;
    // WITH the instant, always: the card renders "seen 2h ago" off this, and a
    // figure that lost its stamp would be renderable as though it were current.
    expect(summary.metadata?.balance).toEqual({
      usd: '12.34',
      seenAt: new Date(NOW).toISOString(),
    });
  });

  it('records nothing when the account states no figure — an absent one is not a zero', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: ONE_FAMILY });

    expect(accountCalls(calls)).toHaveLength(1);
    const summary = (await credentialSummary(env, 'dataforseo'))!;
    expect(summary.metadata?.balance ?? null).toBeNull();
    // And the verdict this sweep DID prove is untouched by the absence.
    expect(summary.lastOkAt).not.toBeNull();
  });

  it('asks nothing and records nothing when every report in the sweep failed', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch({
      failPath: '/backlinks/summary/live',
      accountBalanceUsd: 12.34,
    });
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      retryBackoffMs: FAST_RETRY,
      scope: ONE_FAMILY,
    });

    expect(result.failed).toBe(1);
    // A run that just proved it cannot reach this provider does not ask it one
    // more question, and the card keeps its last sighting with its age.
    expect(accountCalls(calls)).toHaveLength(0);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance ?? null).toBeNull();
  });

  it('asks nothing when the sweep had nothing due', async () => {
    await storeCredential();
    const { fetchImpl } = providerFetch({ accountBalanceUsd: 12.34 });
    await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl });
    const second = providerFetch({ accountBalanceUsd: 99.99 });
    const repeat = await runDataForSeoDumps(env, {
      nowMs: NOW + 86_400_000,
      fetchImpl: second.fetchImpl,
    });

    // Automation inside the cadence buys nothing, so there is no run to refresh
    // anything at the end of — and the earlier sighting stands, unmoved.
    expect(repeat.attempted).toBe(0);
    expect(second.calls).toHaveLength(0);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance).toEqual({
      usd: '12.34',
      seenAt: new Date(NOW).toISOString(),
    });
  });

  it('stays green and never retries when the free read itself fails', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch({ accountFailWith: { status: 503 } });
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      retryBackoffMs: FAST_RETRY,
      scope: ONE_FAMILY,
    });

    // The reports are what a sweep is judged on, and they landed.
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(1);
    // ONE attempt. A courtesy read has nothing to lose by not being repeated.
    expect(accountCalls(calls)).toHaveLength(1);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance ?? null).toBeNull();
    // And the sweep's own verdict on the credential is still the reports'.
    expect((await credentialSummary(env, 'dataforseo'))!.lastOkAt).not.toBeNull();
  });

  it('stays green when the read never gets an answer at all', async () => {
    await storeCredential();
    const provider = providerFetch({ accountBalanceUsd: 12.34 });
    // What an egress refusal looks like from in here: the call throws.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(ACCOUNT_PATH)) throw new Error('blocked');
      return provider.fetchImpl(input, init);
    }) as typeof fetch;
    const result = await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: ONE_FAMILY });

    expect(result.failed).toBe(0);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance ?? null).toBeNull();
  });

  it('says on the completion line whether the credit was refreshed, and never the figure', async () => {
    await storeCredential();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const first = providerFetch({ accountBalanceUsd: 12.34 });
      await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl: first.fetchImpl, scope: ONE_FAMILY });
      expect(completionLine(log)).toMatchObject({ accountCredit: 'refreshed' });
      // The amount is on the card with its age; a log file is not where an
      // account balance belongs.
      expect(JSON.stringify(completionLine(log))).not.toContain('12.34');

      log.mockClear();
      const second = providerFetch({ accountFailWith: { status: 503 } });
      await runDataForSeoDumps(env, {
        nowMs: NOW + 8 * 86_400_000,
        fetchImpl: second.fetchImpl,
        scope: ONE_FAMILY,
      });
      expect(completionLine(log)).toMatchObject({ accountCredit: 'not refreshed' });
    } finally {
      log.mockRestore();
    }
  });

  function completionLine(log: MockInstance<typeof console.log>): Record<string, unknown> {
    const events = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    return events.find((event) => event.event === 'dataforseo_dumps_complete')!;
  }
});
