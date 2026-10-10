// One DataForSEO collection at a time.
//
// The collector has two triggers — the Monday `45 12 * * 1` cron and the
// operator-authed `POST /api/signal-collect`. A double collection does not
// double the archive (`archiveCollectedDump` stores identical content as
// `unchanged`); it doubles the spend, because both runs make every provider
// call, both write manifest rows carrying `provider_cost_usd`, and the cap gate
// reads month-to-date spend once at the top of a run.
//
// Every test here holds the lane with a real run parked inside its first
// provider call, because that is the shape of the overlap: a full-property run
// holds the request open for minutes, the operator's client times out, the run
// carries on server-side invisibly, and firing again is the honest next move.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATAFORSEO_DUMPS_CRON } from '../src/crons.js';
import {
  runDataForSeoDumps,
  type DataForSeoDumpsResult,
} from '../src/dataforseo-dumps.js';
import { runCron } from '../src/dispatch.js';
import { handleSignalCollect } from '../src/routes/signal-collect.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { ARCHIVE_RUNS, pgCount, reset } from './helpers.js';

const NOW = Date.parse('2026-08-04T09:12:00.000Z');
const CREDENTIALS = { login: 'operator-login', password: 'operator-password' };
const DUMP_ROWS = `SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`;

interface Provider {
  fetchImpl: typeof fetch;
  calls: string[];
}

/** A provider that answers every call at once — the challenger's provider, so a
 * call that should never have been made is a recorded call rather than a hang. */
function provider(): Provider {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(requestUrl(input));
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface GatedProvider extends Provider {
  /** Resolves once the holding run is genuinely inside a provider call. */
  readonly started: Promise<void>;
  /** Let the holding run finish. */
  open(): void;
}

/**
 * A provider that parks on its first call until the test says otherwise.
 *
 * This is the whole fixture: a run held here has claimed the lane, has spent one
 * provider call and has written NO manifest row (a family's row is written only
 * after its last request returns), which is exactly the invisible in-flight run
 * the operator would re-fire.
 */
function gatedProvider(): GatedProvider {
  const calls: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let sawFirstCall!: () => void;
  const started = new Promise<void>((resolve) => {
    sawFirstCall = resolve;
  });
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(requestUrl(input));
    sawFirstCall();
    await gate;
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls, started, open: () => open() };
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function answer(): Response {
  return Response.json({
    status_code: 20000,
    status_message: 'Ok.',
    cost: 0.011,
    tasks: [
      {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.011,
        result: [{ items_count: 1, items: [{ ok: true }] }],
      },
    ],
  });
}

interface CollectBody {
  collected?: boolean;
  attempted?: number;
  costUsd?: number;
  error?: string;
  detail?: string;
  asset?: string;
  families?: string[];
  inFlight?: {
    startedAt: string;
    runningSeconds: number;
    scope: { asset: string; families?: string[] | null } | null;
    leaseExpiresAt: string;
  };
}

/** The route with a provider that is never the network. */
async function collect(
  body: unknown,
  options: Parameters<typeof handleSignalCollect>[2],
): Promise<{ status: number; body: CollectBody }> {
  const request = new Request('https://ingest.local/api/signal-collect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const res = await handleSignalCollect(request, env, {
    ...CREDENTIALS,
    ...options,
  });
  return { status: res.status, body: (await res.json()) as CollectBody };
}

beforeEach(reset);

describe('the DataForSEO collector runs one collection at a time', () => {
  /** The refusal names what is running, and pays for nothing. */
  it('refuses a second on-demand run with a 409 naming the run in flight', async () => {
    const holder = gatedProvider();
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: holder.fetchImpl,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    await holder.started;

    const challenger = provider();
    const { status, body } = await collect(
      { asset: 'northwind.example' },
      { nowMs: NOW, fetchImpl: challenger.fetchImpl },
    );

    expect(status).toBe(409);
    expect(body.error).toBe('collection_in_flight');
    // The two facts the operator came for: when it started, and what it covers.
    expect(body.inFlight).toMatchObject({
      startedAt: '2026-08-04T09:12:00.000Z',
      runningSeconds: 0,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    expect(body.detail).toContain('2026-08-04T09:12:00.000Z');
    expect(body.detail).toContain('northwind.example (serp-panel)');
    // A refused run is not a failed one, and the sentence has to say so inside
    // the 400 characters `signals:collect` prints of a non-2xx body.
    expect(body.detail).toContain('Nothing was billed for this call');
    expect(body.detail?.length ?? 0).toBeLessThanOrEqual(360);

    // Nothing was asked of the provider and nothing was written. The holder
    // is still parked in its first call, so a row here could only be the
    // refusal's.
    expect(challenger.calls).toEqual([]);
    expect(await pgCount(DUMP_ROWS)).toBe(0);

    holder.open();
    await running;
  });

  /** The lane is the run's, not the process's — it comes back on completion. */
  it('collects normally once the run in flight has completed', async () => {
    const holder = gatedProvider();
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: holder.fetchImpl,
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    });
    await holder.started;
    expect((await collect({ asset: 'northwind.example' }, { nowMs: NOW, fetchImpl: provider().fetchImpl })).status).toBe(409);

    holder.open();
    const held = await running;
    expect(held.refused).toBeUndefined();
    expect(held.attempted).toBe(1);

    const next = provider();
    const { status, body } = await collect(
      { asset: 'northwind.example', families: ['backlinks-summary'] },
      { nowMs: NOW, fetchImpl: next.fetchImpl },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ collected: true, attempted: 1 });
    expect(next.calls).toHaveLength(1);
    expect(await pgCount(DUMP_ROWS)).toBe(2);
  });

  /** The direction that costs the most: the operator's run is in flight when
   * Monday 12:45 comes round. The cron takes no options, so it collects on the
   * real clock and through the global `fetch` — stubbed here so a serialization
   * that failed would be a recorded call rather than a live, billed one. */
  it('refuses the weekly cron while an on-demand run is in flight', async () => {
    const holder = gatedProvider();
    // No injected clock: the cron reads Date.now(), so the lease it is measured
    // against has to be on the same clock.
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      fetchImpl: holder.fetchImpl,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    await holder.started;
    const heldCalls = holder.calls.length;

    const cronFetch = provider();
    vi.stubGlobal('fetch', cronFetch.fetchImpl);
    try {
      await runCron(DATAFORSEO_DUMPS_CRON, env);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(cronFetch.calls).toEqual([]);
    expect(holder.calls).toHaveLength(heldCalls);
    expect(await pgCount(DUMP_ROWS)).toBe(0);

    holder.open();
    await running;
  });

  /** The other direction: the Monday sweep is running and somebody fires the
   * route. The refusal has to name the sweep, which carries no scope at all. */
  it('refuses an on-demand run while the weekly sweep holds the lane', async () => {
    const sweep = gatedProvider();
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: sweep.fetchImpl,
    });
    await sweep.started;

    const challenger = provider();
    const { status, body } = await collect(
      { asset: 'northwind.example', families: ['serp-panel'] },
      { nowMs: NOW, fetchImpl: challenger.fetchImpl },
    );

    expect(status).toBe(409);
    expect(body.inFlight?.scope).toBeNull();
    expect(body.detail).toContain('the weekly portfolio sweep');
    expect(challenger.calls).toEqual([]);
    expect(await pgCount(DUMP_ROWS)).toBe(0);

    sweep.open();
    await running;
  });

  /** A lock over money must fail open on a schedule. A run whose request
   * context was torn down mid-await never reaches its release, so the lane is
   * held by nobody — and the lease is the answer. The expiry is the one the
   * refusal itself advertised, so the promise made to the operator is the
   * promise under test. (A restarted runtime is the other release: the marker
   * lives in module scope and comes back empty.) */
  it('lets the next trigger through once a stale run has outlived its lease', async () => {
    const abandoned = gatedProvider();
    const stale = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: abandoned.fetchImpl,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    await abandoned.started;

    const refused = await collect(
      { asset: 'northwind.example', families: ['ranked-keywords'] },
      { nowMs: NOW, fetchImpl: provider().fetchImpl },
    );
    expect(refused.status).toBe(409);
    // Fifteen minutes, pinned: how long a run may hold the lane without
    // returning is a decision about money, not an implementation detail.
    const freesAt = Date.parse(refused.body.inFlight!.leaseExpiresAt);
    expect(freesAt - NOW).toBe(15 * 60_000);

    const successor = gatedProvider();
    const taken = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: freesAt,
      fetchImpl: successor.fetchImpl,
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    });
    await successor.started;

    // The run that lost the lane cannot free it on its way out — the lane now
    // belongs to the successor, and a trigger arriving after the stale run
    // finally returns is refused by the run that is actually working.
    abandoned.open();
    const staleResult: DataForSeoDumpsResult = await stale;
    expect(staleResult.refused).toBeUndefined();

    const third = await collect(
      { asset: 'northwind.example', families: ['backlinks-summary'] },
      { nowMs: freesAt, fetchImpl: provider().fetchImpl },
    );
    expect(third.status).toBe(409);
    expect(third.body.inFlight).toMatchObject({
      startedAt: new Date(freesAt).toISOString(),
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    });

    successor.open();
    const takenResult = await taken;
    expect(takenResult.refused).toBeUndefined();
    expect(takenResult.attempted).toBe(1);
    expect(await pgCount(DUMP_ROWS)).toBe(2);
  });
});
